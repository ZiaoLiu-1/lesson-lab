import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeLessonRange, QUADRATIC_MIN_A, QUADRATIC_MAX_A } from './lesson.js';
import bundledLesson from './course/lesson.json' with { type: 'json' };
import { computeExample, expressionFor, parseFunctionCode, materialFor, sceneForStep } from './public/math.js';
import { cleanNarration, isFinalNarration, spokenText } from './public/narration.js';

const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,119}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value);
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max
  && (empty || value.trim().length > 0);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => own(value, key));
const SCENE_KEYS = ['tangent', 'secant', 'comparison'];
const KINDS = ['grounded', 'extension', 'needs_review'];
const MAX_CONVERSATION = 200;
const MAX_NOTES = 100;
export const MAX_STATE_BYTES = 2_000_000;

export class StudioError extends Error {
  constructor(code, message, status = 409) {
    super(message); this.name = 'StudioError'; this.code = code; this.status = status;
  }
}
function assert(value, code, message, status = 400) {
  if (!value) throw new StudioError(code, message, status);
}
function checkStateSize(state) {
  let serialized;
  try { serialized = JSON.stringify(state); }
  catch { throw new StudioError('INVALID_SESSION', 'The session must contain plain JSON data.'); }
  assert(typeof serialized === 'string', 'INVALID_SESSION', 'The session must contain a state object.');
  assert(Buffer.byteLength(serialized, 'utf8') <= MAX_STATE_BYTES, 'SESSION_FULL',
    'This session reached its storage limit. Export the current session, then import a lesson pack to start a new session.');
}
export function computeFacts(a, power = 2) {
  assert(Number.isFinite(a) && a >= QUADRATIC_MIN_A && a <= QUADRATIC_MAX_A, 'INVALID_PARAMETER', 'Choose a number from 0.5 to 10.');
  assert(Number.isInteger(power) && power >= 1 && power <= 5, 'INVALID_POWER', 'Choose a whole-number power from 1 to 5.');
  return computeExample(a, power);
}
function supportsFunctionEditing(lesson) { return isDeepStrictEqual(lesson.pages, bundledLesson.pages); }
function normalizeStateFunctions(state) {
  const out = copy(state);
  if (object(out?.pages)) for (const saved of Object.values(out.pages)) {
    if (!object(saved)) continue;
    if (!own(saved, 'power')) saved.power = 2;
    if (!own(saved, 'functionCode') && Number.isFinite(saved.a) && Number.isInteger(saved.power)) {
      try { saved.functionCode = expressionFor(saved.a, saved.power); } catch { /* State validation reports invalid bounds. */ }
    }
  }
  return out;
}

function checkLesson(lesson) {
  assert(object(lesson) && id(lesson.id) && text(lesson.version, 120) && text(lesson.title, 300)
    && Array.isArray(lesson.pages) && lesson.pages.length > 0 && lesson.pages.length <= 40
    && Array.isArray(lesson.sources) && lesson.sources.length <= 100, 'INVALID_LESSON', 'The lesson structure is invalid.');
  const used = new Set();
  const register = value => {
    assert(id(value) && !used.has(value), 'INVALID_LESSON', 'Lesson IDs must be unique and valid.'); used.add(value);
  };
  for (const page of lesson.pages) {
    assert(object(page) && Array.isArray(page.blocks) && page.blocks.length > 0 && page.blocks.length <= 100
      && Array.isArray(page.steps) && page.steps.length > 0 && page.steps.length <= 100,
    'INVALID_LESSON', 'Each page needs blocks and prepared steps.');
    register(page.id);
    for (const block of page.blocks) {
      register(block.id);
      assert(text(block.text, 12000) && text(block.title, 300), 'INVALID_LESSON', 'A lesson block is invalid.');
    }
    for (const step of page.steps) {
      register(step.id);
      assert(page.blocks.some(block => block.id === step.targetId) && text(step.text, 8000),
        'INVALID_LESSON', 'A prepared step has an invalid target or text.');
    }
  }
  for (const source of lesson.sources) {
    assert(object(source) && text(source.title, 500), 'INVALID_LESSON', 'A source is invalid.'); register(source.id);
  }
  assert(object(lesson.example) && lesson.example.kind === 'quadratic'
    && lesson.example.minA === QUADRATIC_MIN_A && [5, QUADRATIC_MAX_A].includes(lesson.example.maxA)
    && lesson.example.initialA <= lesson.example.maxA, 'INVALID_LESSON', 'This studio supports the bounded quadratic example.');
  computeFacts(lesson.example.initialA);
}

function initialState(lesson) {
  const first = lesson.pages[0];
  return { version: 1, lessonId: lesson.id, lessonVersion: lesson.version, revision: 0, viewEpoch: 0,
    pageId: first.id, selectedId: first.blocks[0].id, model: 'qwen',
    pages: Object.fromEntries(lesson.pages.map(page => [page.id, { a: lesson.example.initialA, power: 2, functionCode: expressionFor(lesson.example.initialA, 2),
      scene: { tangent: false, secant: false, comparison: false }, notes: [] }])),
    conversation: [], cursor: { pageId: first.id, stepIndex: 0, delivered: false },
    resumePoint: null, mode: 'lesson', delivery: 'idle' };
}

function validateState(state, lesson) {
  state = normalizeStateFunctions(state);
  const invalid = 'The saved session is incomplete or contains invalid values.';
  const check = value => assert(value, 'INVALID_SESSION', invalid);
  checkStateSize(state);
  check(exact(state, ['version', 'lessonId', 'lessonVersion', 'revision', 'viewEpoch', 'pageId',
    'selectedId', 'model', 'pages', 'conversation', 'cursor', 'resumePoint', 'mode', 'delivery']));
  check(state.version === 1 && state.lessonId === lesson.id && state.lessonVersion === lesson.version);
  check(integer(state.revision) && state.revision <= 1_000_000_000
    && integer(state.viewEpoch) && state.viewEpoch <= 1_000_000_000 && ['qwen', 'gptoss'].includes(state.model)
    && ['lesson', 'question'].includes(state.mode) && ['idle', 'speaking', 'interrupted', 'done'].includes(state.delivery));
  const page = lesson.pages.find(item => item.id === state.pageId);
  check(page && exact(state.pages, lesson.pages.map(item => item.id)));
  const sourceIds = new Set(lesson.sources.map(source => source.id));
  const noteIds = new Set();
  const fixedIds = new Set(lesson.pages.flatMap(item => [item.id, ...item.blocks.map(block => block.id), ...item.steps.map(step => step.id)]));
  const sourcesValid = values => Array.isArray(values) && values.length <= 12
    && new Set(values).size === values.length && values.every(value => sourceIds.has(value));
  for (const prepared of lesson.pages) {
    const saved = state.pages[prepared.id];
    check(exact(saved, ['a', 'power', 'functionCode', 'scene', 'notes']));
    check(Number.isFinite(saved.a) && saved.a >= QUADRATIC_MIN_A && saved.a <= QUADRATIC_MAX_A);
    check(Number.isInteger(saved.power) && saved.power >= 1 && saved.power <= 5);
    check(saved.power === 2 || supportsFunctionEditing(lesson));
    let parsed; try { parsed = parseFunctionCode(saved.functionCode); } catch { check(false); }
    check(parsed.a === saved.a && parsed.power === saved.power);
    check(exact(saved.scene, SCENE_KEYS) && SCENE_KEYS.every(key => typeof saved.scene[key] === 'boolean'));
    check(Array.isArray(saved.notes) && saved.notes.length <= MAX_NOTES);
    // A live note can target an earlier live note, never a later note or itself.
    const targets = new Set(prepared.blocks.map(block => block.id));
    for (const note of saved.notes) {
      check(exact(note, ['id', 'pageId', 'targetId', 'title', 'text', 'kind', 'sourceIds', 'turnId']));
      check(id(note.id) && !noteIds.has(note.id) && !fixedIds.has(note.id) && note.pageId === prepared.id
        && targets.has(note.targetId) && text(note.title, 160) && text(note.text, 4000)
        && KINDS.includes(note.kind) && sourcesValid(note.sourceIds) && text(note.turnId, 120));
      noteIds.add(note.id); targets.add(note.id);
    }
  }
  check(page.blocks.some(block => block.id === state.selectedId)
    || state.pages[page.id].notes.some(note => note.id === state.selectedId));
  const cursorValid = cursor => exact(cursor, ['pageId', 'stepIndex', 'delivered'])
    && integer(cursor.stepIndex) && typeof cursor.delivered === 'boolean'
    && lesson.pages.some(item => item.id === cursor.pageId && cursor.stepIndex < item.steps.length);
  check(cursorValid(state.cursor) && (state.resumePoint === null || cursorValid(state.resumePoint)));
  check(state.mode !== 'lesson' || (state.cursor.pageId === state.pageId && state.resumePoint === null));
  check(state.mode !== 'question' || state.resumePoint !== null);
  check(Array.isArray(state.conversation) && state.conversation.length <= MAX_CONVERSATION);
  const conversationIds = new Set();
  for (const item of state.conversation) {
    check(object(item) && Object.keys(item).every(key => ['id', 'role', 'text', 'pageId', 'turnId', 'at', 'kind', 'sourceIds'].includes(key)));
    check(text(item.id, 120) && !conversationIds.has(item.id) && ['user', 'assistant'].includes(item.role)
      && text(item.text, 4000) && lesson.pages.some(prepared => prepared.id === item.pageId)
      && text(item.turnId, 120) && text(item.at, 40) && Number.isFinite(Date.parse(item.at))
      && (!own(item, 'kind') || KINDS.includes(item.kind)) && (!own(item, 'sourceIds') || sourcesValid(item.sourceIds)));
    conversationIds.add(item.id);
  }
  return copy(state);
}

function candidateFor(question, power = 2) {
  const target = String.raw`(?:a|(?:the\s+)?coefficient(?:\s+a)?)`;
  const command = String.raw`(?:set|change)\s+${target}`;
  const numberWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const leading = new RegExp(String.raw`^(?:please\s+)?${command}\b`, 'i').test(question);
  if (!leading) return null; // Negated requests and explanatory mentions are ordinary questions.
  const instruction = new RegExp(String.raw`^(?:please\s+)?${command}\s+to\s+([^\s,;!?]+)`, 'i').exec(question);
  assert(instruction, 'INVALID_PARAMETER_INSTRUCTION', 'Use a clear instruction such as “change the coefficient to three”.');
  const parse = token => {
    const clean = token.replace(/\.$/, '').toLowerCase();
    const word = numberWords.indexOf(clean);
    if (word >= 0) return computeFacts(word, power);
    assert(/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(clean), 'INVALID_PARAMETER_INSTRUCTION', 'Use one explicit decimal value for a.');
    return computeFacts(Number(clean), power);
  };
  const candidate = parse(instruction[1]);
  const tail = question.slice(instruction[0].length);
  const alternative = new RegExp(String.raw`^\s*(?:or|to|through|\.\.)\s*(?:[-.\d]|(?:${numberWords.join('|')})\b)`, 'i');
  assert(!alternative.test(tail), 'CONFLICTING_PARAMETER', 'Choose one value for a.');
  assert(!/^\s*(?:point|hundred|thousand|million|billion|and\s+(?:a\s+)?(?:half|quarter))\b/i.test(tail),
    'INVALID_PARAMETER_INSTRUCTION', 'Use a decimal numeral or one number word from one through ten.');
  for (const match of tail.matchAll(new RegExp(String.raw`\b${command}\s+to\s+([^\s,;!?]+)`, 'gi'))) {
    assert(parse(match[1]).a === candidate.a, 'CONFLICTING_PARAMETER', 'The request contains conflicting values for a.');
  }
  return candidate;
}

function validFunctionTail(tail) {
  const clean = tail.trim().replace(/^[.,;!?]+\s*/, '').replace(/[.,;!?]+$/, '').trim();
  if (!clean) return true;
  const note = String.raw`(?:an?\s+|the\s+)?(?:(?:short|brief|concise)\s+)?(?:note|annotation|explanation)\b`;
  const start = new RegExp(String.raw`^(?:and\s+)?(?:(?:explain|describe|compare)\b|(?:show|draw|keep)\s+(?:the\s+)?(?:tangent|curve|function|secant|graph|finite[ -]step|comparison|slope)\b|add\s+${note})`, 'i');
  // Sentence punctuation is not permission to ignore another expression term.
  if (!clean.split(/[.;!?]\s*/).filter(Boolean).every(clause => start.test(clause.trim()))) return false;
  const arithmetic = new RegExp(String.raw`(?:^|[,;.!?]|\band\b)\s*(?:[+*/^=−-]|plus\b|minus\b|times\b|divided\b|multiply\b|divide\b|subtract\b|add\s+(?!${note}))`, 'i');
  return !arithmetic.test(clean);
}

function requestedFunction(question, current) {
  const target = String.raw`(?:f\s*\(\s*x\s*\)|f\s+of\s+x|fx|(?:the\s+)?function)`;
  const begin = new RegExp(String.raw`^(?:please\s+)?(?:set|change)\s+${target}(?=\s|=)`, 'i');
  const restore = /^(?:please\s+)?restore\s+(?:the\s+)?quadratic(?:\s+function)?(?=$|[\s.,;!?])/i.exec(question);
  if (restore) {
    const tail = question.slice(restore[0].length);
    assert(validFunctionTail(tail),
      'INVALID_FUNCTION_INSTRUCTION', 'Use “restore the quadratic function” as one clear instruction.');
    assert(!/\b(?:set|change|restore)\b/i.test(tail), 'CONFLICTING_FUNCTION', 'Request one function change at a time.');
    return { facts: computeFacts(current.a, 2), code: expressionFor(current.a, 2) };
  }
  if (!begin.test(question)) return null;
  const prefix = new RegExp(String.raw`^(?:please\s+)?(?:set|change)\s+${target}\s*(?:to\s+|=\s*)`, 'i').exec(question);
  assert(prefix, 'INVALID_FUNCTION_INSTRUCTION', 'Use a clear expression such as “change f(x) to 10x cubed”.');
  const input = question.slice(prefix[0].length).replace(/[¹²³⁴⁵]/g, value => `**${'¹²³⁴⁵'.indexOf(value) + 1}`);
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const coefficient = String.raw`(?:\d+(?:\.\d+)?|\.\d+|${words.join('|')})`;
  const match = new RegExp(String.raw`^(?:(${coefficient})\s*(?:\*\s*|times\s+)?)?x\s*(?:(?:\*\*|\^)\s*(\d+)|\b(squared|cubed)\b|\b(?:to\s+the\s+)?(first|second|third|fourth|fifth)\s+power\b)?`, 'i').exec(input);
  assert(match, 'INVALID_FUNCTION_INSTRUCTION', 'Only coefficient times x to an integer power from 1 to 5 is supported.');
  const token = (match[1] ?? '1').toLowerCase();
  const a = words.includes(token) ? words.indexOf(token) : Number(token);
  const power = match[2] ? Number(match[2]) : match[3] ? ({ squared: 2, cubed: 3 })[match[3].toLowerCase()]
    : match[4] ? ['first', 'second', 'third', 'fourth', 'fifth'].indexOf(match[4].toLowerCase()) + 1 : 1;
  const tail = input.slice(match[0].length);
  assert(!/^\s*(?:or|to|through)\b/i.test(tail), 'CONFLICTING_FUNCTION', 'Choose one explicit function.');
  assert(validFunctionTail(tail),
    'INVALID_FUNCTION_INSTRUCTION', 'Unsupported expression syntax was not applied. Use coefficient*x**power.');
  assert(!new RegExp(String.raw`\b(?:set|change)\s+${target}|\brestore\s+(?:the\s+)?quadratic`, 'i').test(tail),
    'CONFLICTING_FUNCTION', 'Request one function change at a time.');
  const facts = computeFacts(a, power);
  for (const another of tail.matchAll(/\b(?:set|change)\s+(?:a|(?:the\s+)?coefficient(?:\s+a)?)\s+to\s+([^\s,;!?]+)/gi)) {
    const other = candidateFor(another[0], power);
    assert(other.a === a, 'CONFLICTING_PARAMETER', 'The requested function and coefficient disagree.');
  }
  return { facts, code: expressionFor(a, power) };
}

function safeMetadata(value) {
  if (!object(value)) return null;
  const result = {};
  for (const key of ['model', 'modelReported', 'providerId', 'finishReason']) {
    if (typeof value[key] === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value[key])) result[key] = value[key];
    else if (value[key] === null) result[key] = null;
  }
  if (Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) result.elapsedMs = value.elapsedMs;
  if (object(value.usage)) {
    result.usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'reasoning_tokens']) {
      if (integer(value.usage[key])) result.usage[key] = value.usage[key];
    }
    if (integer(value.usage.completion_tokens_details?.reasoning_tokens)) {
      result.usage.completion_tokens_details = { reasoning_tokens: value.usage.completion_tokens_details.reasoning_tokens };
    }
  }
  const config = value.config ?? value.effectiveConfig;
  if (object(config)) {
    result.config = {};
    for (const key of ['model', 'reasoningEffort', 'reasoningFormat']) {
      if (typeof config[key] === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(config[key])) result.config[key] = config[key];
    }
    for (const key of ['maxCompletionTokens', 'temperature', 'timeoutMs']) {
      if (Number.isFinite(config[key]) && config[key] >= 0) result.config[key] = config[key];
    }
  }
  return result;
}

export class StudioCore {
  constructor({ lesson, generate, savedState, persist = () => {}, record = () => {}, emit = () => {},
    timeoutMs = 20000, ackTimeoutMs = 5000 }) {
    checkLesson(lesson);
    assert(typeof generate === 'function', 'INVALID_GENERATOR', 'A generation function is required.');
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0 && Number.isFinite(ackTimeoutMs) && ackTimeoutMs > 0,
      'INVALID_DEADLINE', 'Request and rendering deadlines must be positive.');
    this.lesson = normalizeLessonRange(lesson); this.generate = generate; this.persist = persist; this.record = record; this.emit = emit;
    this.timeoutMs = timeoutMs; this.ackTimeoutMs = ackTimeoutMs;
    this.state = savedState ? validateState(savedState, this.lesson) : initialState(this.lesson);
    if (this.state.delivery === 'speaking') this.state.delivery = 'interrupted';
    this.connectionId = null; this.active = null; this.latestCompleted = null; this.audioAnchor = null;
    this.undoStack = []; this.records = [];
  }
  page(pageId = this.state.pageId) { return this.lesson.pages.find(page => page.id === pageId); }
  material(pageId = this.state.pageId) {
    const content = this.state.pages[pageId];
    return materialFor(this.page(pageId), computeFacts(content.a, content.power));
  }
  sourcesFor(power = this.state.pages[this.state.pageId].power) {
    return this.lesson.sources.map(source => ({ ...copy(source), ...(power !== 2
      ? { title: `${source.title} (quadratic foundation; changed-power material is program-derived)` } : {}) }));
  }
  block(selectedId = this.state.selectedId, pageId = this.state.pageId) {
    return this.material(pageId)?.blocks.find(block => block.id === selectedId)
      ?? this.state.pages[pageId]?.notes.find(note => note.id === selectedId) ?? null;
  }
  authorize(connectionId) {
    assert(connectionId && connectionId === this.connectionId, 'STALE_CONNECTION', 'This reader connection has expired. Reload the page.', 409);
  }
  snapshot() { return copy(this.state); }
  save() { this.persist(this.snapshot()); }
  notify(name, value) { try { this.emit(name, copy(value)); } catch { /* A disconnected observer cannot mutate a turn. */ } }
  stateEvent() { this.notify('state', { state: this.snapshot() }); }
  invalidate(reason = 'CANCELLED') {
    this.audioAnchor = null; this.latestCompleted = null;
    const turn = this.active;
    if (turn) { turn.abort.abort(); this.finish(turn, 'cancelled', reason, 'The request was cancelled; late results will not be applied.'); }
  }
  session() {
    this.invalidate('RECONNECTED');
    this.state.viewEpoch++; this.state.revision++;
    if (this.state.delivery === 'speaking') this.state.delivery = 'interrupted';
    this.connectionId = randomUUID(); this.save();
    return { connectionId: this.connectionId, lesson: copy(this.lesson), state: this.snapshot() };
  }
  timeline(turn, name, data = {}) {
    if (turn.timeline.length < 60) turn.timeline.push({ event: name, elapsedMs: +(performance.now() - turn.started).toFixed(2), ...data });
  }
  metrics(turn) {
    return { startedAt: turn.startedAt, elapsedMs: +(performance.now() - turn.started).toFixed(2),
      timeline: copy(turn.timeline), renderedMs: turn.renderedMs ?? null,
      baseRevision: turn.baseRevision, committedRevision: turn.committedRevision ?? null,
      metadata: copy(turn.metadata ?? null) };
  }
  finish(turn, status, code = null, message = null) {
    if (turn.final) return;
    turn.final = true; clearTimeout(turn.deadline); clearTimeout(turn.ackTimer);
    this.timeline(turn, status, code ? { code } : {});
    if (this.active === turn) this.active = null;
    if (status !== 'completed') {
      this.state.delivery = 'interrupted'; this.save();
    }
    const entry = { turnId: turn.id, clientTurnId: turn.clientTurnId, question: turn.question,
      pageId: turn.pageId, status, ...(turn.unit ? { unit: copy(turn.unit) } : {}), metrics: this.metrics(turn),
      ...(code ? { code } : {}) };
    this.records.push(entry); if (this.records.length > 100) this.records.shift();
    try { this.record(copy(entry)); } catch { /* In-memory record remains available to the server. */ }
    if (status !== 'completed') this.notify('failure', { turnId: turn.id, clientTurnId: turn.clientTurnId, code, message, metrics: entry.metrics });
  }
  context(candidateFacts, candidateFunctionCode = null) {
    const state = this.snapshot(); state.conversation = state.conversation.slice(-8);
    return { lesson: { id: this.lesson.id, version: this.lesson.version, title: this.lesson.title, subtitle: this.lesson.subtitle ?? '' },
      page: this.material(), sources: this.sourcesFor(candidateFacts?.power ?? state.pages[state.pageId].power), state,
      facts: computeFacts(state.pages[state.pageId].a, state.pages[state.pageId].power), candidateFacts: copy(candidateFacts), candidateFunctionCode,
      candidatePage: candidateFacts ? materialFor(this.page(), candidateFacts) : null, functionEditing: supportsFunctionEditing(this.lesson),
      selectedBlock: copy(this.block()), conversation: copy(state.conversation) };
  }
  ask(input) {
    this.authorize(input?.connectionId);
    assert(text(input.question, 2000), 'INVALID_QUESTION', 'Enter a question of up to 2000 characters.');
    assert(input.revision === this.state.revision && input.viewEpoch === this.state.viewEpoch
      && input.pageId === this.state.pageId && input.selectedId === this.state.selectedId,
    'STALE_QUESTION', 'The page or selection changed. Review the question before sending it.', 409);
    assert(this.block(input.selectedId), 'UNKNOWN_TARGET', 'The selected passage is no longer available.');
    assert(text(input.clientTurnId, 120), 'INVALID_CLIENT_TURN', 'A client turn identifier is required.');
    const question = input.question.trim();
    const current = this.state.pages[this.state.pageId];
    const functionRequest = requestedFunction(question, current);
    assert(!functionRequest || supportsFunctionEditing(this.lesson), 'UNSUPPORTED_FUNCTION_LESSON', 'Live function edits require the bundled lesson. This imported lesson keeps its authored formulas.');
    const candidateFacts = functionRequest?.facts ?? candidateFor(question, current.power);
    const candidateFunctionCode = functionRequest?.code ?? null;
    if (!functionRequest && candidateFacts) assert(!/\b(?:set|change)\s+(?:f\s*\(|f\s+of\s+x|fx\b|(?:the\s+)?function\b)/i.test(question.slice(1)),
      'CONFLICTING_FUNCTION', 'Request the function change as one clear leading instruction.');
    const proposed = this.snapshot();
    if (!proposed.resumePoint) proposed.resumePoint = copy(proposed.cursor);
    proposed.mode = 'question'; proposed.delivery = 'interrupted';
    proposed.revision++; proposed.viewEpoch++;
    const turn = { id: randomUUID(), clientTurnId: input.clientTurnId, question, pageId: proposed.pageId,
      connectionId: this.connectionId, baseRevision: proposed.revision, viewEpoch: proposed.viewEpoch,
      started: performance.now(), startedAt: new Date().toISOString(), abort: new AbortController(), timeline: [], final: false,
      candidateFacts, candidateFunctionCode, model: proposed.model };
    proposed.conversation.push({ id: `user-${turn.id}`, role: 'user', text: question, pageId: turn.pageId,
      turnId: turn.id, at: turn.startedAt });
    proposed.conversation = proposed.conversation.slice(-MAX_CONVERSATION);
    checkStateSize(proposed);
    this.invalidate('SUPERSEDED'); this.state = proposed;
    turn.snapshot = this.context(candidateFacts, candidateFunctionCode);
    this.active = turn; this.save(); this.stateEvent(); this.timeline(turn, 'accepted');
    this.notify('status', { turnId: turn.id, clientTurnId: turn.clientTurnId, status: 'generating', elapsedMs: 0 });
    turn.deadline = setTimeout(() => {
      if (!turn.final) { turn.abort.abort(); this.finish(turn, 'failed', 'REQUEST_TIMEOUT', 'Generation timed out. No partial answer was applied.'); }
    }, this.timeoutMs);
    void this.run(turn);
    return { turnId: turn.id };
  }
  validTurn(turn, revision = turn.baseRevision) {
    return this.active === turn && !turn.final && turn.connectionId === this.connectionId
      && revision === this.state.revision && turn.viewEpoch === this.state.viewEpoch && turn.pageId === this.state.pageId;
  }
  validateUnit(unit, turn) {
    assert(exact(unit, ['title', 'text', 'kind', 'sourceIds', 'focusId', 'scene', 'note', 'claims', 'reviewReason', 'functionCode']),
      'INVALID_UNIT', 'The generated answer has an invalid structure.');
    assert(text(unit.title, 160) && text(unit.text, 4000) && KINDS.includes(unit.kind),
      'INVALID_UNIT', 'The generated answer is empty, too long, or has an invalid label.');
    assert(Array.isArray(unit.sourceIds) && unit.sourceIds.length <= 12
      && new Set(unit.sourceIds).size === unit.sourceIds.length
      && unit.sourceIds.every(sourceId => this.lesson.sources.some(source => source.id === sourceId)),
    'UNKNOWN_SOURCE', 'The generated answer cites a source outside this lesson.');
    assert(this.block(unit.focusId, turn.pageId), 'UNKNOWN_TARGET', 'The generated answer targets unavailable content.');
    assert(exact(unit.scene, SCENE_KEYS) && SCENE_KEYS.every(key => typeof unit.scene[key] === 'boolean'),
      'INVALID_SCENE', 'The generated scene is invalid.');
    assert(unit.note === null || (exact(unit.note, ['targetId', 'text']) && this.block(unit.note.targetId, turn.pageId)
      && text(unit.note.text, 4000)), 'INVALID_NOTE', 'The generated annotation is invalid.');
    assert(unit.reviewReason === null || text(unit.reviewReason, 1000), 'INVALID_REVIEW', 'The review reason is invalid.');
    assert(unit.kind !== 'needs_review' || text(unit.reviewReason, 1000), 'MISSING_REVIEW_REASON', 'An uncertain answer must explain what needs review.');
    assert([unit.title, unit.text, unit.note?.text, unit.reviewReason].filter(value => value !== undefined && value !== null).every(isFinalNarration),
      'UNSAFE_NARRATION', 'The generated response contained draft or planning text. No new explanation or page action was applied.');
    const facts = turn.candidateFacts ?? turn.snapshot.facts;
    assert(facts.power === 2 || ['extension', 'needs_review'].includes(unit.kind), 'UNSUPPORTED_GROUNDING',
      'A changed-power example must be labeled as an extension of the prepared quadratic lesson.');
    if (turn.candidateFunctionCode && unit.kind !== 'needs_review') {
      let parsed; try { parsed = parseFunctionCode(unit.functionCode); } catch { assert(false, 'INVALID_FUNCTION_CODE', 'The generated function source is unsupported. No change was applied.'); }
      assert(parsed.a === facts.a && parsed.power === facts.power, 'FUNCTION_MISMATCH', 'The generated function differs from the requested expression. No change was applied.');
    } else assert(unit.functionCode === null, 'UNREQUESTED_FUNCTION', 'The model cannot change function source without an explicit supported request.');
    assert(Array.isArray(unit.claims) && unit.claims.length <= Object.keys(facts).length, 'INVALID_CLAIMS', 'The generated numerical claims are invalid.');
    const keys = new Set();
    for (const claim of unit.claims) {
      assert(exact(claim, ['key', 'value']) && own(facts, claim.key) && !keys.has(claim.key)
        && Number.isFinite(claim.value), 'INVALID_CLAIMS', 'The generated answer contains an unknown numerical claim.');
      assert(Math.abs(claim.value - facts[claim.key]) <= 1e-9 * Math.max(1, Math.abs(facts[claim.key])),
        'MATH_MISMATCH', 'A generated number disagrees with the current example. No change was applied.');
      keys.add(claim.key);
    }
    if (unit.note) assert(this.state.pages[turn.pageId].notes.length < MAX_NOTES, 'NOTE_LIMIT', 'This page has reached its annotation limit. Export the session before starting another.');
  }
  async run(turn) {
    try {
      const result = await this.generate({ question: turn.question, snapshot: copy(turn.snapshot), model: turn.model,
        signal: turn.abort.signal, onEvent: (name, data = {}) => {
          if (!this.validTurn(turn) || typeof name !== 'string' || !/^[a-z_]{1,60}$/.test(name)) return;
          const metadata = safeMetadata(data.metadata ?? data);
          if (metadata && Object.keys(metadata).length) turn.metadata = { ...turn.metadata, ...metadata };
          this.timeline(turn, name);
          this.notify('status', { turnId: turn.id, clientTurnId: turn.clientTurnId, status: name,
            elapsedMs: +(performance.now() - turn.started).toFixed(2) });
        } });
      if (!this.validTurn(turn)) return;
      turn.metadata = safeMetadata(result?.metadata) ?? turn.metadata ?? null;
      this.validateUnit(result?.unit, turn); this.timeline(turn, 'validated');
      clearTimeout(turn.deadline);
      const proposed = this.snapshot();
      const unit = copy(result.unit);
      const content = proposed.pages[turn.pageId];
      if (unit.kind !== 'needs_review') {
        if (turn.candidateFacts) {
          content.a = turn.candidateFacts.a; content.power = turn.candidateFacts.power;
          content.functionCode = turn.candidateFunctionCode ? unit.functionCode : expressionFor(content.a, content.power);
        }
        content.scene = copy(unit.scene);
      }
      if (unit.note) content.notes.push({ id: `note-${turn.id}`, pageId: turn.pageId,
        targetId: unit.note.targetId, title: unit.title, text: unit.note.text,
        kind: unit.kind, sourceIds: copy(unit.sourceIds), turnId: turn.id });
      proposed.selectedId = unit.focusId;
      proposed.conversation.push({ id: `assistant-${turn.id}`, role: 'assistant', text: unit.text,
        pageId: turn.pageId, turnId: turn.id, at: new Date().toISOString(), kind: unit.kind, sourceIds: copy(unit.sourceIds) });
      proposed.conversation = proposed.conversation.slice(-MAX_CONVERSATION);
      proposed.revision++; proposed.delivery = 'idle';
      checkStateSize(proposed);
      this.undoStack.push({ pageId: turn.pageId, content: copy(this.state.pages[turn.pageId]) });
      if (this.undoStack.length > 20) this.undoStack.shift();
      this.state = proposed; turn.unit = unit;
      turn.committedRevision = this.state.revision;
      this.save(); this.timeline(turn, 'committed');
      turn.ackTimer = setTimeout(() => {
        if (!turn.final) this.finish(turn, 'failed', 'RENDER_TIMEOUT', 'The page did not confirm the update. Speech is unavailable for this answer.');
      }, this.ackTimeoutMs);
      this.notify('commit', { turnId: turn.id, clientTurnId: turn.clientTurnId, state: this.snapshot(),
        unit: copy(turn.unit), revision: turn.committedRevision });
    } catch (error) {
      if (!turn.final) {
        turn.metadata = safeMetadata(error?.metadata) ?? turn.metadata ?? null;
        const providerMessages = {
          key_missing: 'Add CEREBRAS_API_KEY to the server .env file and restart Lesson Lab. The key stays on your computer.',
          authentication: 'Cerebras rejected the key or model access. Check the server configuration.',
          rate_limit: 'Cerebras reached a service or account limit. Your lesson is saved; retry when ready.',
          truncated: 'The reply reached its reasoning or output budget and was not applied. Try a smaller question.',
          timeout: 'The reply timed out. No partial answer was applied.',
          invalid_model: 'Choose one of the available Cerebras models.',
          invalid_output: 'The provider returned incomplete or invalid teaching content. No change was applied.',
          provider_unavailable: 'The inference service could not be reached. Check your connection and try again.',
        };
        const knownProviderCode = typeof error?.code === 'string' && own(providerMessages, error.code);
        this.finish(turn, 'failed', error instanceof StudioError ? error.code : knownProviderCode ? error.code.toUpperCase() : 'GENERATION_FAILED',
          error instanceof StudioError ? error.message : knownProviderCode ? providerMessages[error.code]
            : 'The provider could not produce an accepted answer. Check the connection or model setup.');
      }
    }
  }
  ack(input) {
    this.authorize(input?.connectionId);
    const turn = this.active;
    assert(turn && input.turnId === turn.id && input.revision === turn.committedRevision
      && this.validTurn(turn, turn.committedRevision), 'STALE_ACK', 'This render confirmation belongs to an expired answer.', 409);
    assert(input.clientTurnId === turn.clientTurnId, 'WRONG_CLIENT_TURN', 'The render confirmation belongs to another client turn.', 409);
    assert(input.renderedMs === null || (Number.isFinite(input.renderedMs) && input.renderedMs >= 0 && input.renderedMs <= 300000),
      'INVALID_TIMING', 'The render time is invalid.');
    turn.renderedMs = input.renderedMs;
    this.timeline(turn, 'display_ack'); this.finish(turn, 'completed');
    this.latestCompleted = turn;
    this.audioAnchor = { type: 'turn', id: turn.id, connectionId: this.connectionId,
      revision: this.state.revision, viewEpoch: this.state.viewEpoch, phase: 'ready' };
    return { state: this.snapshot(), unit: copy(turn.unit), metrics: this.metrics(turn), turnId: turn.id };
  }
  preparedStep() {
    const cursor = this.state.cursor;
    const step = copy(this.material(cursor.pageId).steps[cursor.stepIndex]);
    const facts = computeFacts(this.state.pages[cursor.pageId].a, this.state.pages[cursor.pageId].power);
    step.text = step.text.replace(/\{([A-Za-z]+)\}/g, (match, key) => own(facts, key) ? String(facts[key]) : match);
    return step;
  }
  speechText() {
    const audio = this.audioAnchor;
    assert(audio && audio.connectionId === this.connectionId && audio.revision === this.state.revision
      && audio.viewEpoch === this.state.viewEpoch && audio.phase === 'ready',
    'STALE_AUDIO', 'This reading belongs to expired or already-started content.', 409);
    let narration = '';
    if (audio.type === 'turn' && this.latestCompleted?.id === audio.id) narration = spokenText(this.latestCompleted.unit);
    if (audio.type === 'step' && this.state.mode === 'lesson' && this.preparedStep().id === audio.id) narration = cleanNarration(this.preparedStep().text);
    assert(narration, 'UNSAFE_NARRATION', 'No final teaching narration is available for this reading.', 409);
    return narration;
  }
  control(input) {
    this.authorize(input?.connectionId);
    const action = input.action;
    assert(['page', 'select', 'parameter', 'model', 'cancel', 'start', 'continue', 'next', 'complete_step', 'undo', 'review_note'].includes(action),
      'INVALID_CONTROL', 'This control is not supported.');
    // Validate before cancelling useful work or changing any state.
    if (action === 'page') assert(this.page(input.pageId), 'UNKNOWN_PAGE', 'The requested page does not exist.');
    if (action === 'select') assert(this.block(input.selectedId), 'UNKNOWN_TARGET', 'The selected content does not exist on this page.');
    if (action === 'review_note') assert(this.state.pages[this.state.pageId].notes.some(note => note.id === input.noteId),
      'UNKNOWN_TARGET', 'The annotation does not exist on this page.');
    if (action === 'parameter') computeFacts(input.a);
    if (action === 'model') assert(['qwen', 'gptoss'].includes(input.model), 'UNKNOWN_MODEL', 'Choose one of the available models.');
    if (action === 'next') {
      assert(this.state.mode === 'lesson' && this.state.cursor.pageId === this.state.pageId, 'CONTINUE_FIRST', 'Return to the lesson before advancing.', 409);
      assert(this.state.cursor.stepIndex + 1 < this.page().steps.length, 'END_OF_PAGE', 'This is the last prepared step on this page.', 409);
    }
    if (action === 'complete_step') assert(this.state.mode === 'lesson' && this.state.cursor.pageId === this.state.pageId
      && input.stepId === this.preparedStep().id, 'STALE_STEP', 'This completion belongs to another prepared step.', 409);
    if (action === 'undo') assert(this.undoStack.length > 0, 'NOTHING_TO_UNDO', 'There is no model edit to undo in this session.', 409);
    this.invalidate(action === 'cancel' ? 'CANCELLED' : `CONTROL_${action.toUpperCase()}`);
    this.state.viewEpoch++; this.state.revision++; this.state.delivery = 'interrupted';
    if (action === 'page') {
      this.state.pageId = input.pageId; this.state.selectedId = this.page().blocks[0].id;
      this.state.cursor = { pageId: input.pageId, stepIndex: 0, delivered: false };
      this.state.resumePoint = null; this.state.mode = 'lesson'; this.state.delivery = 'idle';
    } else if (action === 'select') this.state.selectedId = input.selectedId;
    else if (action === 'review_note') this.state.pages[this.state.pageId].notes.find(note => note.id === input.noteId).kind = 'needs_review';
    else if (action === 'parameter') {
      const content = this.state.pages[this.state.pageId]; content.a = input.a;
      content.functionCode = expressionFor(content.a, content.power);
    }
    else if (action === 'model') this.state.model = input.model;
    else if (action === 'start') {
      this.state.cursor = { pageId: this.state.pageId, stepIndex: 0, delivered: false };
      this.state.resumePoint = null; this.state.mode = 'lesson';
    } else if (action === 'continue') {
      this.state.cursor = copy(this.state.resumePoint ?? this.state.cursor);
      this.state.pageId = this.state.cursor.pageId; this.state.resumePoint = null; this.state.mode = 'lesson';
    } else if (action === 'next') {
      this.state.cursor.stepIndex++; this.state.cursor.delivered = false;
    } else if (action === 'complete_step') {
      this.state.cursor.delivered = true; this.state.delivery = 'done';
    } else if (action === 'undo') {
      const previous = this.undoStack.pop(); this.state.pages[previous.pageId] = copy(previous.content);
      if (!this.block()) this.state.selectedId = this.page().blocks[0].id;
    }
    let step;
    if (['start', 'continue', 'next'].includes(action)) {
      step = this.preparedStep(); this.state.selectedId = step.targetId; this.state.delivery = 'idle';
      if (supportsFunctionEditing(this.lesson)) this.state.pages[this.state.pageId].scene = sceneForStep(step.id);
      this.audioAnchor = { type: 'step', id: step.id, connectionId: this.connectionId,
        revision: this.state.revision, viewEpoch: this.state.viewEpoch, phase: 'ready' };
    }
    this.save(); this.stateEvent();
    return { state: this.snapshot(), ...(step ? { step } : {}) };
  }
  audio(input) {
    this.authorize(input?.connectionId);
    assert(['start', 'end', 'cancel'].includes(input.phase), 'INVALID_AUDIO_PHASE', 'This audio phase is invalid.');
    const anchor = this.audioAnchor;
    const isTurn = typeof input.turnId === 'string' && !input.stepId;
    const isStep = typeof input.stepId === 'string' && !input.turnId;
    assert(anchor && anchor.connectionId === this.connectionId && anchor.revision === this.state.revision
      && anchor.viewEpoch === this.state.viewEpoch
      && ((isTurn && anchor.type === 'turn' && anchor.id === input.turnId && this.latestCompleted?.id === input.turnId)
        || (isStep && anchor.type === 'step' && anchor.id === input.stepId && this.state.mode === 'lesson'
          && this.preparedStep().id === input.stepId)), 'STALE_AUDIO', 'This audio event belongs to expired content.', 409);
    assert(input.phase === 'start' ? anchor.phase === 'ready'
      : input.phase === 'end' ? anchor.phase === 'start' : ['ready', 'start'].includes(anchor.phase),
    'AUDIO_ORDER', 'This audio event is duplicate or out of order.', 409);
    anchor.phase = input.phase;
    this.state.delivery = { start: 'speaking', end: 'done', cancel: 'interrupted' }[input.phase];
    if (anchor.type === 'step' && input.phase === 'end') this.state.cursor.delivered = true;
    if (anchor.type === 'turn') this.timeline(this.latestCompleted, `audio_${input.phase}`);
    this.save(); this.stateEvent();
    return { state: this.snapshot() };
  }
  exportSession() {
    return { format: 'lesson-lab-session', version: 1, lesson: copy(this.lesson), state: this.snapshot(), exportedAt: new Date().toISOString() };
  }
  restoreSession(payload) {
    assert(exact(payload, ['format', 'version', 'lesson', 'state', 'exportedAt'])
      && payload.format === 'lesson-lab-session' && payload.version === 1
      && object(payload.lesson) && payload.lesson.id === this.lesson.id && payload.lesson.version === this.lesson.version
      && text(payload.exportedAt, 40) && Number.isFinite(Date.parse(payload.exportedAt)),
    'INVALID_SESSION', 'Choose an exported session for this exact lesson and version.');
    // Revalidate the embedded lesson but retain our canonical content for a session import.
    checkLesson(payload.lesson);
    assert(isDeepStrictEqual(normalizeLessonRange(payload.lesson), this.lesson), 'LESSON_MISMATCH', 'This session embeds different lesson content. Import it as a lesson pack instead.');
    const next = validateState(payload.state, this.lesson);
    const revision = Math.max(this.state.revision, next.revision) + 1;
    const viewEpoch = Math.max(this.state.viewEpoch, next.viewEpoch) + 1;
    next.revision = revision; next.viewEpoch = viewEpoch;
    next.delivery = next.delivery === 'speaking' ? 'interrupted' : 'idle';
    checkStateSize(next);
    this.invalidate('SESSION_RESTORED'); this.undoStack = [];
    this.state = next; this.save(); this.stateEvent();
    return { state: this.snapshot() };
  }
}
