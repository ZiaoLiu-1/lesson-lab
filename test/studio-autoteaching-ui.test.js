import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { StudioCore } from '../studio/core.js';
import { computeExample, expressionFor, formatFunction, materialFor } from '../studio/public/math.js';

const source = await readFile(new URL('../studio/public/app.js', import.meta.url), 'utf8');
function actual(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source); assert.ok(match, name);
  const next = /\n(?:async )?function \w+\(/g; next.lastIndex = match.index + match[0].length;
  return source.slice(match.index, next.exec(source)?.index ?? source.length);
}
const flush = async () => { for (let i = 0; i < 45; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const lesson = {
  id: 'autoplay-test', version: '1', title: 'Changes', subtitle: 'Two small chapters.',
  example: { kind: 'quadratic', initialA: 1, minA: 0.5, maxA: 10 }, sources: [{ id: 'source', title: 'Prepared material' }],
  pages: [1, 2].map(n => ({ id: `p${n}`, title: n === 1 ? 'Local slope' : 'Finite change', eyebrow: 'Lesson', summary: 'Compare rates.',
    blocks: [{ id: `p${n}.curve`, title: 'Curve', text: 'The local function.' }],
    steps: [1, 2].map(i => ({ id: `p${n}.s${i}`, targetId: `p${n}.curve`, text: `Chapter ${n}, step ${i}. The height is {y}.` })), quickQuestions: ['Why?'] })),
};
function fixture(t) {
  const core = new StudioCore({ lesson, generate: async () => assert.fail('Prepared teaching must not request a model') });
  const session = core.session(); t.after(() => core.invalidate('TEST_END'));
  const spoken = [], calls = [], elements = new Map();
  const continuous = { listening: true, starts: 0, async start() { this.starts++; return true; }, stop() {}, invalidate() {}, setPlayback() {} };
  const ui = { lesson, state: session.state, connectionId: session.connectionId, connected: true, view: 'study', controlBusy: false, fileBusy: false, previewA: null,
    config: { keyConfigured: true, localTranscription: true }, continuous, continuousEnabled: false, continuousEpoch: 0, continuousUtteranceId: null,
    autoTeaching: null, teachingGeneration: 0, guidedAudio: false, audio: null, active: null, speechEngine: 'browser', voiceState: 'idle' };
  ui.voice = { cancel() {}, speak(text, callbacks) { const entry = { text, callbacks, cancelled: false }; spoken.push(entry); return () => { entry.cancelled = true; }; } };
  const context = vm.createContext({ ui, computeExample, expressionFor, formatFunction, materialFor, timer: null,
    document: { hidden: false }, performance: { now: () => 200 },
    $(id) { if (!elements.has(id)) elements.set(id, { value: '', checked: false, textContent: '', hidden: false, focus() {}, setAttribute() {}, classList: { toggle() {} } }); return elements.get(id); },
    canSpeak: () => true, applyState: value => { ui.state = value; },
    renderControls() {}, renderStatus() {}, renderMetrics() {}, renderTeachingFocus() {}, renderConversation() {}, renderGraph() {},
    setTeachingMarker() {}, followTeachingFocus() {}, markDraftStale() {}, finishViewMotion() {}, setError() {}, notice() {}, announce() {}, showHelp() {},
    twoFrames: async () => {}, motion: { settled: async () => {} }, clearInterval() {},
    async post(path, body) { calls.push({ path, body }); if (path === '/api/control') return core.control(body); if (path === '/api/audio') return core.audio(body); assert.fail(`Unexpected request ${path}`); },
  });
  const names = ['number', 'facts', 'preparedPage', 'pageState', 'interpolate', 'currentStep', 'anchor', 'anchorMatches', 'audioIsCurrent', 'stopAudio', 'invalidateLocal', 'control', 'readText', 'speakPrepared', 'stopAutomaticTeaching', 'ownsAutomaticTeaching', 'beginAutomaticLesson', 'teachPreparedStep', 'stateMatchesAnchor', 'advanceAutomaticLesson', 'ownsContinuousTurn', 'continuousAvailable', 'renderContinuousControls', 'toggleContinuousConversation', 'endContinuousConversation', 'continuousSpokenCommand', 'runContinuousSpokenCommand', 'ask'];
  vm.runInContext(`let speechGeneration = 0;\n${names.map(actual).join('\n')}`, context);
  const complete = async () => { const entry = spoken.at(-1); entry.callbacks.onStart(); await flush(); await entry.callbacks.onEnd(); await flush(); };
  return { core, ui, context, spoken, calls, continuous, complete };
}

test('one successful microphone connection starts the first chapter and advances only after real end acknowledgement', async t => {
  const f = fixture(t); await f.context.toggleContinuousConversation();
  assert.equal(f.continuous.starts, 1); assert.equal(f.spoken.length, 1); assert.match(f.spoken[0].text, /Chapter 1, step 1/);
  assert.equal(f.ui.state.cursor.delivered, false); assert.equal(f.ui.audio.started, false);
  const gate = deferred(), original = f.context.post;
  f.context.post = async (path, body) => { if (path === '/api/audio' && body.phase === 'end') await gate.promise; return original(path, body); };
  f.spoken[0].callbacks.onStart(); await flush(); assert.equal(f.spoken.length, 1);
  const end = f.spoken[0].callbacks.onEnd(); await flush(); assert.equal(f.spoken.length, 1, 'No advance while end acknowledgement is pending');
  gate.resolve(); await end; await flush(); assert.equal(f.spoken.length, 2); assert.match(f.spoken[1].text, /Chapter 1, step 2/);
  await f.complete(); assert.match(f.spoken.at(-1).text, /Chapter 2, step 1/);
  await f.complete(); assert.match(f.spoken.at(-1).text, /Chapter 2, step 2/);
  await f.complete(); assert.equal(f.spoken.length, 4); assert.equal(f.ui.autoTeaching, null); assert.equal(f.ui.continuousEnabled, true); assert.equal(f.continuous.starts, 1);
});

test('microphone-free teaching uses the same acknowledged progression without starting capture', async t => {
  const f = fixture(t); await f.context.beginAutomaticLesson({ pageId: 'p1', guided: true });
  assert.equal(f.continuous.starts, 0); assert.equal(f.ui.continuousEnabled, false); assert.equal(f.spoken.length, 1);
  await f.complete(); assert.equal(f.spoken.length, 2);
  await f.context.control('cancel'); const stopped = f.spoken.at(-1); stopped.callbacks.onEnd(); await flush();
  assert.equal(f.spoken.length, 2); assert.equal(f.ui.autoTeaching, null); assert.equal(f.core.snapshot().cursor.delivered, false);
});

test('a stale microphone-free button click cannot restart the lesson while capture remains active', async t => {
  const f = fixture(t); await f.context.toggleContinuousConversation();
  const owner = f.ui.autoTeaching, calls = f.calls.length, spoken = f.spoken.length;
  const result = await f.context.beginAutomaticLesson({ pageId: 'p1', action: 'start', guided: true });
  assert.equal(result, null); assert.equal(f.ui.autoTeaching, owner);
  assert.equal(f.calls.length, calls); assert.equal(f.spoken.length, spoken);
  assert.equal(f.ui.continuousEnabled, true); assert.equal(f.ui.guidedAudio, false);
});

test('the persistent primary button stops guided reading without activating the microphone', async t => {
  const f = fixture(t); await f.context.beginAutomaticLesson({ pageId: 'p1', guided: true });
  f.context.renderContinuousControls(); assert.equal(f.context.$('conversation-toggle').textContent, 'Stop reading');
  assert.equal(f.context.$('conversation-toggle').disabled, false);
  await f.context.toggleContinuousConversation();
  assert.equal(f.ui.guidedAudio, false); assert.equal(f.ui.audio, null); assert.equal(f.continuous.starts, 0);
  assert.equal(f.spoken[0].cancelled, true); assert.match(f.context.$('continuous-status').textContent, /microphone stayed off/i);
});

test('interrupting while end acknowledgement is pending never advances or marks the next step read', async t => {
  const f = fixture(t); await f.context.beginAutomaticLesson({ pageId: 'p1', guided: true });
  const gate = deferred(), original = f.context.post;
  f.context.post = async (path, body) => { if (path === '/api/audio' && body.phase === 'end') await gate.promise; return original(path, body); };
  f.spoken[0].callbacks.onStart(); await flush(); const ending = f.spoken[0].callbacks.onEnd(); await flush();
  await f.context.control('cancel'); gate.resolve(); await ending; await flush();
  assert.equal(f.spoken.length, 1); assert.equal(f.ui.state.cursor.stepIndex, 0); assert.equal(f.ui.autoTeaching, null);
});

test('spoken chapter number, exact title, page ID and restart jump locally to the first step', async t => {
  const f = fixture(t); f.ui.continuousEnabled = true; f.ui.continuousEpoch = 1; f.ui.continuousUtteranceId = 1;
  for (const phrase of ['Go to chapter two', 'Go to Finite change', 'Go to p2', 'Start from beginning']) {
    const command = f.context.continuousSpokenCommand(phrase);
    await f.context.runContinuousSpokenCommand(command, { epoch: 1, utteranceId: 1 });
    assert.equal(f.ui.state.pageId, phrase === 'Start from beginning' ? 'p1' : 'p2'); assert.equal(f.ui.state.cursor.stepIndex, 0);
    assert.match(f.spoken.at(-1).text, /step 1/);
  }
  assert.equal(f.calls.some(call => call.path === '/api/ask'), false);
});

test('manual and typed chapter navigation restart the chosen chapter during guided teaching', async t => {
  const f = fixture(t); await f.context.beginAutomaticLesson({ pageId: 'p1', guided: true });
  await f.context.control('page', { pageId: 'p2' }); assert.match(f.spoken.at(-1).text, /Chapter 2, step 1/);
  f.context.$('question').value = 'Go to chapter one'; await f.context.ask();
  assert.match(f.spoken.at(-1).text, /Chapter 1, step 1/); assert.equal(f.context.$('question').value, '');
  assert.equal(f.calls.some(call => call.path === '/api/ask'), false);
});

test('idle typed chapter and restart commands teach locally with no key or microphone', async t => {
  const f = fixture(t); f.ui.config.keyConfigured = false;
  f.context.$('question').value = 'Go to chapter two'; await f.context.ask();
  assert.equal(f.ui.state.pageId, 'p2'); assert.equal(f.ui.state.cursor.stepIndex, 0);
  assert.match(f.spoken.at(-1).text, /Chapter 2, step 1/); assert.equal(f.ui.guidedAudio, true);
  assert.deepEqual(f.calls.filter(call => call.path === '/api/control').map(call => call.body.action), ['page', 'start']);
  assert.equal(f.continuous.starts, 0); assert.equal(f.ui.continuousEnabled, false);
  await f.context.control('cancel'); f.context.$('question').value = 'Start from beginning'; await f.context.ask();
  assert.match(f.spoken.at(-1).text, /Chapter 1, step 1/);
  assert.equal(f.calls.some(call => call.path === '/api/ask'), false);
});

for (const blocked of ['busy', 'file-busy', 'stale-draft', 'stale-anchor']) test(`typed navigation preserves the current lesson and draft when ${blocked}`, async t => {
  const f = fixture(t); f.context.$('question').value = 'Go to chapter two';
  if (blocked === 'busy') f.ui.controlBusy = true;
  if (blocked === 'file-busy') f.ui.fileBusy = true;
  if (blocked === 'stale-draft') f.ui.draftStale = true;
  if (blocked === 'stale-anchor') f.ui.draftAnchor = { ...f.context.anchor(), selectedId: 'earlier-selection' };
  await f.context.ask();
  assert.equal(f.calls.length, 0); assert.equal(f.spoken.length, 0); assert.equal(f.continuous.starts, 0);
  assert.equal(f.ui.state.pageId, 'p1'); assert.equal(f.context.$('question').value, 'Go to chapter two');
  if (blocked.startsWith('stale')) assert.equal(f.ui.draftStale, true);
});

test('continue resumes the unfinished prepared step and duplicate ended callbacks never skip ahead', async t => {
  const f = fixture(t); await f.context.toggleContinuousConversation(); await f.complete();
  assert.equal(f.ui.state.cursor.stepIndex, 1);
  await f.context.control('cancel'); f.ui.continuousUtteranceId = 2;
  await f.context.runContinuousSpokenCommand('continue', { epoch: f.ui.continuousEpoch, utteranceId: 2 });
  const active = f.spoken.at(-1); assert.match(active.text, /Chapter 1, step 2/);
  active.callbacks.onStart(); await flush(); await Promise.all([active.callbacks.onEnd(), active.callbacks.onEnd()]); await flush();
  assert.match(f.spoken.at(-1).text, /Chapter 2, step 1/); assert.equal(f.ui.state.cursor.stepIndex, 0);
});

test('a replaced chapter owner cannot start speech after an older motion waiter settles', async t => {
  const f = fixture(t); const motion = deferred(); f.context.motion.settled = () => motion.promise;
  const old = f.context.beginAutomaticLesson({ pageId: 'p1', guided: true }); await flush();
  const replacement = f.context.control('page', { pageId: 'p2' }); await flush();
  motion.resolve(); await Promise.all([old, replacement]);
  assert.equal(f.spoken.length, 1); assert.match(f.spoken[0].text, /Chapter 2, step 1/);
});
