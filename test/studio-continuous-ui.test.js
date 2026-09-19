import { spokenText } from '../studio/public/narration.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { ContinuousVoiceController } from '../studio/public/continuous-voice.js';
import { shouldEditCanvas } from '../studio/public/canvas-seed.js';
const source = await readFile(new URL('../studio/public/app.js', import.meta.url), 'utf8');
function actual(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source); assert.ok(match, name);
  const next = /\n(?:async )?function \w+\(/g; next.lastIndex = match.index + match[0].length;
  return source.slice(match.index, next.exec(source)?.index ?? source.length);
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function fixture() {
  const calls = []; const spoken = []; const errors = []; const playback = [];
  const state = { lessonId: 'lesson', lessonVersion: '1', pageId: 'p1', selectedId: 'b1', revision: 0, viewEpoch: 0, model: 'qwen', mode: 'lesson', delivery: 'idle', cursor: { pageId: 'p1', stepIndex: 0, delivered: false }, resumePoint: null, pages: { p1: { a: 1, scene: {}, notes: [] } } };
  const controller = { active: true, invalidations: 0, starts: 0, stops: 0, async start() { this.starts++; return true; }, stop() { this.stops++; }, invalidate() { this.invalidations++; }, setPlayback(value) { playback.push(value); } };
  const ui = { state, connectionId: 'reader', connected: true, controlBusy: false, fileBusy: false, previewA: null, view: 'study', config: { keyConfigured: true, localTranscription: true }, active: null, audio: null, accepted: null, voice: null, voiceState: 'idle', continuous: controller, continuousEnabled: false, continuousEpoch: 0, continuousCapture: null, continuousUtteranceId: null };
  const text = { visible: true, scrollIntoView() {} }; const target = { dataset: { passageId: 'b1' }, visible: true };
  const message = { dataset: { turnId: 'turn' }, querySelector: () => text };
  const elements = new Map([['conversation', { scrollTop: 0, scrollHeight: 100, querySelectorAll: () => [message] }]]);
  const context = vm.createContext({ spokenText, ui, timer: null, bridgeJobs: new Set(), AbortController, Uint8Array, btoa: (value) => Buffer.from(value, 'binary').toString('base64'), performance: { now: () => 200 }, crypto: { randomUUID: () => 'client' },
    document: { hidden: false, querySelectorAll: () => [target] },
    $(id) { if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: false, textContent: '', setAttribute() {}, classList: { toggle() {} }, focus() {} }); return elements.get(id); },
    visible: (node) => Boolean(node?.visible && !context.document.hidden),
    renderControls() {}, renderConversation() {}, renderMetrics() {}, renderStatus() {}, renderTeachingFocus() {}, renderGraph() {},
    setError(message) { if (message) errors.push(message); }, announce() {}, notice() {}, showHelp() {},
    markDraftStale() {}, finishViewMotion() {}, setTeachingMarker() {}, followTeachingFocus() {}, canSpeak: () => true,
    applyState(value) { ui.state = value; }, currentStep: () => ({ id: 'step', text: 'Prepared.' }), interpolate: (value) => value,
    twoFrames: async () => {}, settledView: async () => {}, motion: { settled: async () => {} },
    setInterval: () => 1, clearInterval() {}, requestAnimationFrame: () => 1,
    post: async (path, body) => { calls.push({ path, body }); return {}; },
    readText: (text, identity) => spoken.push({ text, identity }),
  });
  const names = ['teachingFollowKey', 'stopAutomaticTeaching', 'ownsAutomaticTeaching', 'beginAutomaticLesson', 'teachPreparedStep', 'stateMatchesAnchor', 'advanceAutomaticLesson', 'audioIsCurrent', 'continuousSpokenCommand', 'runContinuousSpokenCommand', 'speakPrepared', 'anchor', 'anchorMatches', 'matchesTurn', 'stopAudio', 'invalidateLocal', 'control', 'continuousAvailable', 'ownsContinuousTurn', 'voiceViewSignature', 'beginContinuousUtterance', 'receiveContinuousTranscript', 'ask', 'onCommit', 'speakReply', 'reportBridge', 'onBridgeCommand', 'voiceDelta', 'directVoiceMetrics', 'directPlaybackMetrics', 'transcribeContinuous', 'toggleContinuousConversation', 'endContinuousConversation'];
  vm.runInContext(`let speechGeneration = 0;\n${names.map(actual).join('\n')}`, context);
  const enable = () => { ui.continuousEnabled = true; ui.continuousEpoch++; };
  const permit = async (id = 'utterance') => {
    enable();
    context.post = async (path, body) => { calls.push({ path, body }); return { state: { ...ui.state, revision: ui.state.revision + 1, viewEpoch: ui.state.viewEpoch + 1, delivery: 'interrupted' } }; };
    return context.beginContinuousUtterance({ utteranceId: id, speechStartMs: 5 });
  };
  return { context, ui, calls, spoken, errors, playback, controller, enable, permit, elements, target };
}
const unit = { title: 'A tangent', text: 'The local slope is two.', focusId: 'b1' };
const timing = { speechStartMs: 5, speechEndMs: 50, transcriptReadyMs: 100, transcriptionMs: 40 };
function direct(f) { return { epoch: f.ui.continuousEpoch, utteranceId: f.ui.continuousUtteranceId, metrics: timing }; }
function readyTurn(f) {
  f.enable(); f.ui.continuousUtteranceId = 'utterance';
  const turn = { turnId: 'turn', clientTurnId: 'client', anchor: f.context.anchor(), viewEpoch: 1, directVoice: direct(f), started: 110, timeline: [], cancelled: false };
  f.ui.active = turn;
  const state = { ...f.ui.state, revision: 2, viewEpoch: 1, mode: 'question' };
  const data = { turnId: 'turn', clientTurnId: 'client', state, revision: 2, unit };
  return { turn, data, result: { state, unit, turnId: 'turn', metrics: {} } };
}

test('conversation is explicit opt-in; unavailable local ASR never starts a microphone', async () => {
  const f = fixture(); assert.equal(f.controller.starts, 0);
  f.ui.config.localTranscription = false; await f.context.toggleContinuousConversation(); assert.equal(f.controller.starts, 0);
  f.ui.config.localTranscription = true; await f.context.toggleContinuousConversation(); assert.equal(f.controller.starts, 1); assert.equal(f.ui.continuousEnabled, true);
  f.context.endContinuousConversation('Off', { cancelTurn: false }); assert.equal(f.ui.continuousEnabled, false); assert.equal(f.controller.stops, 1); assert.equal(f.controller.starts, 1);
});

test('a controller returning false cannot leave conversation mode armed', async () => {
  const f = fixture(); f.controller.start = async () => { f.controller.starts++; return false; };
  await f.context.toggleContinuousConversation();
  assert.equal(f.controller.starts, 1); assert.equal(f.controller.stops, 1);
  assert.equal(f.ui.continuousEnabled, false); assert.match(f.context.$('continuous-status').textContent, /did not start/);
});

test('the controller positive numeric utterance ID binds and submits exactly once', async () => {
  const f = fixture(); const bound = await f.permit(1);
  assert.equal(bound.revision, 1); assert.equal(f.ui.continuousUtteranceId, 1);
  f.context.post = async (path, body) => { f.calls.push({ path, body }); return { turnId: 'turn' }; };
  const payload = { text: 'Explain the slope.', anchor: bound, utteranceId: 1, metrics: timing };
  f.context.receiveContinuousTranscript(payload); f.context.receiveContinuousTranscript(payload); await flush();
  assert.equal(f.calls.filter((call) => call.path === '/api/ask').length, 1);
});

test('the real continuous controller hands a numeric final utterance through cancellation to one ask', async () => {
  const f = fixture(); f.enable();
  const controller = new ContinuousVoiceController({ onSpeechStart: f.context.beginContinuousUtterance, onTranscript: f.context.receiveContinuousTranscript, transcribe: async () => ({ text: 'Explain the tangent.', metrics: { transcriptionMs: 40 } }), now: () => 100 });
  f.ui.continuous = controller; controller.active = true; controller.listening = true;
  f.context.post = async (path, body) => { f.calls.push({ path, body }); return path === '/api/control' ? { state: { ...f.ui.state, revision: 1, viewEpoch: 1, delivery: 'interrupted' } } : { turnId: 'turn' }; };
  controller.begin({ speechStartMs: 5 });
  await controller.complete({ frames: [new Float32Array(8000)], speechStartMs: 5, speechEndMs: 50 }); await flush();
  const asks = f.calls.filter((call) => call.path === '/api/ask');
  assert.equal(asks.length, 1); assert.equal(asks[0].body.revision, 1);
  assert.equal(f.ui.active.directVoice.utteranceId, 1); assert.equal(controller.active, true);
});

test('speech onset interrupts immediately, preserves its capture, and binds only exact cancellation state', async () => {
  const f = fixture(); f.enable(); const response = deferred(); let cancelled = 0; let aborted = 0;
  f.ui.audio = { identity: { turnId: 'previous' }, connectionId: 'reader', cancel: () => cancelled++ };
  f.ui.active = { controller: { abort: () => aborted++ }, timeline: [], started: 0 };
  f.context.post = (path, body) => { f.calls.push({ path, body }); return path === '/api/control' ? response.promise : Promise.resolve({}); };
  const start = f.context.beginContinuousUtterance({ utteranceId: 'one', speechStartMs: 10 });
  assert.equal(cancelled, 1); assert.equal(aborted, 1); assert.equal(f.controller.invalidations, 0);
  const duplicate = f.context.beginContinuousUtterance({ utteranceId: 'one', speechStartMs: 10 }); assert.equal(duplicate, start);
  response.resolve({ state: { ...f.ui.state, revision: 1, viewEpoch: 1, delivery: 'interrupted' } });
  const bound = await start; assert.equal(bound.revision, 1); assert.ok(Object.isFrozen(bound)); assert.equal(f.calls.filter((call) => call.path === '/api/control').length, 1);
});

for (const change of ['intervening-commit', 'changed-page', 'mode-off']) test(`onset rejects ${change} while server cancellation is pending`, async () => {
  const f = fixture(); f.enable(); const response = deferred(); f.context.post = () => response.promise;
  const pending = f.context.beginContinuousUtterance({ utteranceId: 'one', speechStartMs: 5 });
  let state = { ...f.ui.state, revision: 1, viewEpoch: 1 };
  if (change === 'intervening-commit') state.revision = 2;
  if (change === 'changed-page') state.pageId = 'p2';
  if (change === 'mode-off') f.context.endContinuousConversation('Off', { cancelTurn: false });
  response.resolve({ state }); assert.equal(await pending, null);
});

test('one final transcript sends its immutable anchor exactly once without appending or erasing a typed draft', async () => {
  const f = fixture(); const bound = await f.permit(); f.context.$('question').value = 'An unrelated typed draft';
  f.context.post = async (path, body) => { f.calls.push({ path, body }); return { turnId: 'turn' }; };
  const payload = { text: 'Explain the tangent.', anchor: bound, utteranceId: 'utterance', metrics: timing };
  f.context.receiveContinuousTranscript(payload); f.context.receiveContinuousTranscript(payload); await flush();
  const asks = f.calls.filter((call) => call.path === '/api/ask'); assert.equal(asks.length, 1);
  assert.equal(asks[0].body.question, payload.text); assert.equal(asks[0].body.revision, bound.revision); assert.equal(asks[0].body.bridgeId, undefined);
  assert.equal(f.context.$('question').value, 'An unrelated typed draft'); assert.equal(f.controller.starts, 0, 'a transcript never reopens the microphone');
});

for (const change of ['off', 'selection', 'parameter', 'model', 'connection']) test(`late transcript after ${change} cannot submit`, async () => {
  const f = fixture(); const bound = await f.permit();
  if (change === 'off') f.context.endContinuousConversation('Off', { cancelTurn: false });
  else if (change === 'connection') f.ui.connectionId = 'another';
  else { f.ui.state.revision++; f.ui.state.viewEpoch++; if (change === 'selection') f.ui.state.selectedId = 'b2'; }
  f.context.receiveContinuousTranscript({ text: 'Old input.', anchor: bound, utteranceId: 'utterance', metrics: timing }); await flush();
  assert.equal(f.calls.filter((call) => call.path === '/api/ask').length, 0);
});

test('ordinary control invalidates capture while retaining the explicitly enabled continuous stream', async () => {
  const f = fixture(); await f.permit();
  await f.context.control('parameter', { a: 3 });
  assert.equal(f.ui.continuousCapture, null); assert.equal(f.ui.continuousEnabled, true); assert.equal(f.controller.invalidations, 1); assert.equal(f.controller.stops, 0);
});

test('oversized transcript is not silently truncated and automatically submitted', async () => {
  const f = fixture(); const bound = await f.permit(); const text = 'word '.repeat(450);
  f.context.receiveContinuousTranscript({ text, anchor: bound, utteranceId: 'utterance' }); await flush();
  assert.equal(f.calls.filter((call) => call.path === '/api/ask').length, 0); assert.equal(f.context.$('question').value, text.trim());
});

test('direct auto-reading waits for visible ACK and matching conversation ownership', async () => {
  const f = fixture(); const { data, result } = readyTurn(f); const view = deferred(); const ack = deferred();
  f.context.settledView = () => view.promise;
  f.context.post = (path, body) => { f.calls.push({ path, body }); return ack.promise; };
  const pending = f.context.onCommit(data); await flush(); assert.equal(f.calls.length, 0); assert.equal(f.spoken.length, 0);
  view.resolve(); await flush(); assert.equal(f.calls[0].path, '/api/ack'); assert.equal(f.spoken.length, 0);
  ack.resolve(result); await pending; await flush(); assert.equal(f.spoken.length, 1); assert.equal(f.ui.lastMetrics.voice.endToVisibleMs, 150); assert.equal(f.ui.lastMetrics.voice.transcriptToVisibleMs, 100);
});

test('the real inline lesson answer remains ACKable while the optional discussion rail is hidden', async () => {
  const f = fixture(); const { data, result } = readyTurn(f);
  f.context.$('live-answer').dataset = {}; f.context.$('live-answer').querySelector = () => ({});
  f.context.$('live-answer-text').visible = true; f.context.$('live-answer-text').scrollIntoView = () => {};
  f.context.kindLabels = { grounded: 'AI · lesson-based' };
  vm.runInContext(`${actual('setText')}\n${actual('renderLiveAnswer')}`, f.context);
  f.context.applyState = state => { f.ui.state = state; f.context.renderLiveAnswer(); };
  f.context.$('conversation').querySelectorAll = () => [];
  f.context.post = async (path, body) => { f.calls.push({ path, body }); return result; };
  await f.context.onCommit(data); await flush();
  assert.equal(f.context.$('live-answer').hidden, false);
  assert.equal(f.context.$('live-answer-text').textContent, unit.text);
  assert.equal(f.calls.filter(call => call.path === '/api/ack').length, 1); assert.equal(f.spoken.length, 1);
});

test('an offscreen reply reveals one stable target before ACK without scrollIntoView recentering', async () => {
  const f = fixture(); const { data, result } = readyTurn(f); let scrolls = 0;
  f.context.$('live-answer').dataset = { turnId: 'turn' };
  const text = f.context.$('live-answer-text'); text.visible = false; text.scrollIntoView = () => assert.fail('Competing native scroll must not run');
  f.context.$('follow-teaching').checked = true;
  f.context.focusTarget = target => { assert.equal(target, text); scrolls++; text.visible = true; };
  f.context.post = async (path, body) => { f.calls.push({ path, body }); return result; };
  await f.context.onCommit(data); await flush();
  assert.equal(scrolls, 1); assert.equal(f.calls.filter(call => call.path === '/api/ack').length, 1);
  assert.equal(f.ui.followAttemptKey, 'reader:reply:turn:2');
});

for (const reason of ['user-scrolled', 'follow-off']) test(`an offscreen answer does not steal the viewport or fake ACK after ${reason}`, async () => {
  const f = fixture(); const { turn, data } = readyTurn(f); let rejected = 0;
  f.context.$('live-answer').dataset = { turnId: 'turn' }; f.context.$('live-answer-text').visible = false;
  f.context.$('follow-teaching').checked = reason !== 'follow-off'; turn.userScrolled = reason === 'user-scrolled';
  f.context.focusTarget = () => assert.fail('The reader controls this viewport');
  f.context.failVisibleTurn = async () => { rejected++; f.ui.active = null; };
  await f.context.onCommit(data); await flush();
  assert.equal(rejected, 1); assert.equal(f.calls.filter(call => call.path === '/api/ack').length, 0); assert.equal(f.spoken.length, 0);
});

for (const change of ['off', 'new-utterance']) test(`direct reply cannot auto-read after ${change} while ACK is pending`, async () => {
  const f = fixture(); const { data, result } = readyTurn(f); const ack = deferred(); f.context.post = () => ack.promise;
  const pending = f.context.onCommit(data); await flush();
  if (change === 'off') f.context.endContinuousConversation('Off', { cancelTurn: false }); else f.ui.continuousUtteranceId = 'new';
  ack.resolve(result); await pending; await flush(); assert.equal(f.spoken.length, 0);
});

test('remote bridge commands cannot start a second narrator while continuous conversation owns the mic', async () => {
  const f = fixture(); f.enable();
  f.context.post = async (path, body) => { f.calls.push({ path, body }); return { anchor: f.context.anchor(), command: { kind: 'ask', question: 'Remote.' } }; };
  await f.context.onBridgeCommand({ id: 'bridge' });
  assert.equal(f.calls.filter((call) => call.path === '/api/ask').length, 0); assert.equal(f.calls.at(-1).body.status, 'failed'); assert.equal(f.spoken.length, 0); assert.equal(f.ui.continuousEnabled, true);
});

test('playback reference and voice latency are driven by actual start/end callbacks, never queued speech', async () => {
  const f = fixture(); f.enable(); f.ui.continuousUtteranceId = 'utterance'; let callbacks;
  f.ui.speechEngine = 'browser'; f.ui.voice = { cancel() {}, speak(text, hooks) { callbacks = hooks; return () => {}; } };
  f.ui.accepted = { turnId: 'turn', directVoice: direct(f) }; f.ui.lastMetrics = { voice: f.context.directVoiceMetrics(direct(f), 150) };
  f.context.post = async () => ({ state: f.ui.state });
  vm.runInContext(actual('readText'), f.context);
  f.context.readText('Reply.', { turnId: 'turn' }, 110); assert.equal(f.playback.includes(true), false); assert.equal(f.ui.lastMetrics.voice.endToPlaybackMs, null);
  callbacks.onStart(); assert.equal(f.playback.at(-1), true); assert.equal(f.ui.lastMetrics.voice.endToPlaybackMs, 150); assert.equal(f.ui.lastMetrics.voice.transcriptToPlaybackMs, 100);
  await callbacks.onEnd(); assert.equal(f.playback.at(-1), false); assert.equal(f.controller.stops, 0, 'playback must leave continuous capture armed');
});

test('local transcription transports only WAV bytes and the bound anchor with abort propagation', async () => {
  const f = fixture(); const bound = f.context.anchor(); const controller = new AbortController(); let request;
  f.context.post = async (path, body, signal) => { request = { path, body, signal }; return { text: 'hello' }; };
  const result = await f.context.transcribeContinuous({ wav: new Uint8Array([82, 73, 70, 70]).buffer, anchor: bound, signal: controller.signal });
  assert.equal(result.text, 'hello'); assert.equal(request.path, '/api/transcribe'); assert.equal(request.body.audioBase64, 'UklGRg=='); assert.equal(request.body.anchor, bound); assert.equal(request.signal, controller.signal);
});

test('spoken controls match complete phrases, leaving substantive questions for Cerebras', () => {
  const f = fixture();
  for (const phrase of ['continue', 'Continue the lesson.', 'continue where we left off']) assert.equal(f.context.continuousSpokenCommand(phrase), 'continue');
  assert.equal(f.context.continuousSpokenCommand('start the lesson'), 'start');
  assert.equal(f.context.continuousSpokenCommand('stop speaking!'), 'stop');
  assert.equal(f.context.continuousSpokenCommand('end conversation'), 'end');
  assert.equal(f.context.continuousSpokenCommand('stop listening'), 'end');
  for (const phrase of ['continue explaining the tangent', 'why does it stop?', 'start', 'next', 'do not stop listening']) assert.equal(f.context.continuousSpokenCommand(phrase), null);
});

test('an explicit canvas edit uses the canvas source path without dispatching a bounded lesson ask', async () => {
  const f = fixture(); const edits = []; let cancelled = 0;
  f.ui.canvas = { active: false, handles: question => shouldEditCanvas(question, false), cancel() { cancelled++; }, stopSpeech() {}, async edit(question, options) { edits.push({ question, options }); } };
  f.context.$('question').value = 'Change this page to a midnight blue theme.';
  f.ui.draftAnchor = f.context.anchor();
  await f.context.ask();
  assert.equal(edits.length, 1); assert.equal(edits[0].question, 'Change this page to a midnight blue theme.');
  assert.equal(edits[0].options.read, false); assert.equal(edits[0].options.voiceOwner, null);
  assert.equal(cancelled, 1, 'the old canvas request is cancelled before a replacement');
  assert.equal(f.calls.filter(call => call.path === '/api/ask').length, 0);
  assert.equal(f.ui.active, null); assert.equal(f.context.$('question').value, '');
});

test('a stale typed canvas edit retains its draft and cannot bypass the anchor guard', async () => {
  const f = fixture(); let edits = 0;
  f.ui.canvas = { handles: () => true, edit() { edits++; } };
  f.context.$('question').value = 'Change this page to orange.';
  f.ui.draftAnchor = f.context.anchor(); f.ui.state.revision++;
  await f.context.ask();
  assert.equal(edits, 0); assert.equal(f.ui.draftStale, true);
  assert.equal(f.context.$('question').value, 'Change this page to orange.'); assert.equal(f.calls.length, 0);
});

for (const command of ['continue', 'start']) test(`spoken ${command} in an active canvas teaches that source without resuming hidden prepared material`, async () => {
  const f = fixture(); const bound = await f.permit(1); const edits = [];
  f.ui.canvas = { active: true, cancel() {}, stopSpeech() {}, async edit(question, options) { edits.push({ question, options }); } };
  f.context.receiveContinuousTranscript({ text: command === 'start' ? 'start the lesson' : 'continue', anchor: bound, utteranceId: 1 }); await flush();
  assert.equal(edits.length, 1); assert.match(edits[0].question, command === 'start' ? /beginning/i : /continue/i);
  assert.equal(edits[0].options.read, true); assert.equal(edits[0].options.voiceOwner.utteranceId, 1);
  assert.equal(edits[0].options.voiceOwner.epoch, f.ui.continuousEpoch);
  assert.equal(f.calls.filter(call => call.path === '/api/ask' || call.path === '/api/control' && ['start', 'continue'].includes(call.body.action)).length, 0);
  assert.equal(f.spoken.length, 0); assert.equal(f.ui.continuousEnabled, true);
});

test('continuous speech onset cancels canvas generation and audio before awaiting a fresh anchor', async () => {
  const f = fixture(); f.enable(); const response = deferred(); let cancelled = 0; let stopped = 0;
  f.ui.canvas = { busy: true, cancel() { cancelled++; this.busy = false; }, stopSpeech() { stopped++; } };
  f.context.post = (path, body) => { f.calls.push({ path, body }); return response.promise; };
  const onset = f.context.beginContinuousUtterance({ utteranceId: 1, speechStartMs: 5 });
  assert.equal(cancelled, 1); assert.equal(stopped, 1); assert.equal(f.ui.canvas.busy, false);
  assert.equal(f.controller.invalidations, 0, 'barge-in keeps this utterance capture alive');
  assert.equal(f.controller.stops, 0); assert.equal(f.ui.continuousCapture.anchor, null);
  response.resolve({ state: { ...f.ui.state, revision: 1, viewEpoch: 1, delivery: 'interrupted' } });
  const captured = await onset;
  assert.equal(captured.revision, 1); assert.equal(f.ui.continuousEnabled, true);
  assert.equal(f.calls.filter(call => call.path === '/api/ask').length, 0);
});

for (const command of ['continue', 'start']) test(`spoken ${command} reads only the returned prepared step without a Cerebras turn`, async () => {
  const f = fixture(); const bound = await f.permit(1); f.context.$('read-replies').checked = true;
  f.context.post = async (path, body) => { f.calls.push({ path, body }); return { state: { ...f.ui.state, revision: f.ui.state.revision + 1, viewEpoch: f.ui.state.viewEpoch + 1, mode: 'lesson' }, step: { id: 'step', text: 'Prepared.' } }; };
  f.context.receiveContinuousTranscript({ text: command === 'start' ? 'start the lesson' : 'continue', anchor: bound, utteranceId: 1 }); await flush();
  assert.equal(f.calls.filter((call) => call.path === '/api/ask').length, 0);
  assert.equal(f.calls.filter((call) => call.path === '/api/control' && call.body.action === command).length, 1);
  assert.equal(f.spoken.length, 1, 'manual read-replies must not double-read a voice control');
  assert.equal(f.spoken[0].identity.stepId, 'step'); assert.equal(f.ui.continuousEnabled, true);
});

test('spoken stop keeps capture armed; end conversation releases it without generating an answer', async () => {
  const f = fixture(); const bound = await f.permit(1);
  f.context.receiveContinuousTranscript({ text: 'stop speaking', anchor: bound, utteranceId: 1 }); await flush();
  assert.equal(f.calls.length, 1, 'onset cancellation already stopped the earlier turn');
  assert.equal(f.ui.continuousEnabled, true); assert.equal(f.controller.stops, 0);
  const next = await f.context.beginContinuousUtterance({ utteranceId: 2, speechStartMs: 10 });
  f.context.receiveContinuousTranscript({ text: 'stop listening', anchor: next, utteranceId: 2 }); await flush();
  assert.equal(f.ui.continuousEnabled, false); assert.equal(f.controller.stops, 1);
  assert.equal(f.calls.filter((call) => call.path === '/api/ask').length, 0); assert.equal(f.spoken.length, 0);
});

test('turning conversation off during prepared motion prevents delayed spoken continue', async () => {
  const f = fixture(); const bound = await f.permit(1); const motion = deferred(); f.context.motion.settled = () => motion.promise;
  f.context.post = async () => ({ state: { ...f.ui.state, revision: f.ui.state.revision + 1, viewEpoch: f.ui.state.viewEpoch + 1, mode: 'lesson' }, step: { id: 'step', text: 'Prepared.' } });
  f.context.receiveContinuousTranscript({ text: 'continue', anchor: bound, utteranceId: 1 }); await flush();
  f.context.endContinuousConversation('Off', { cancelTurn: false }); motion.resolve(); await flush();
  assert.equal(f.spoken.length, 0);
});

for (const listening of [true, false]) test(`native playback completion reports the continuous microphone accurately (listening=${listening})`, async () => {
  const f = fixture(); let player; let ended = 0;
  if (listening) { f.enable(); f.controller.listening = true; }
  Object.assign(f.context, {
    setTimeout: () => 1, clearTimeout() {}, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fetch: async () => ({ ok: true, headers: { get: () => 'audio/wav' }, blob: async () => ({ size: 100 }) }),
    Audio: class {
      constructor() { player = this; this.events = new Map(); }
      addEventListener(name, handler) { this.events.set(name, handler); }
      removeEventListener(name) { this.events.delete(name); }
      async play() {} pause() {} removeAttribute() {} load() {}
    },
  });
  vm.runInContext(`${actual('localMicrophoneStatus')}\n${actual('playNativeSpeech')}`, f.context);
  const audio = { identity: { stepId: 'step' }, connectionId: 'reader', revision: 0, viewEpoch: 0, started: false, cancelled: false };
  f.ui.audio = audio;
  f.context.playNativeSpeech(audio, { onStart: () => { audio.started = true; }, onEnd: () => ended++, onError: (error) => assert.fail(error.message) });
  await flush(); player.events.get('playing')(); player.events.get('ended')();
  assert.equal(ended, 1);
  assert.equal(f.context.$('voice-status').textContent, listening ? 'Finished local reading. Still listening for your next question.' : 'Finished local reading. Microphone off.');
  assert.equal(f.controller.stops, 0, 'speech completion must not release the continuous microphone');
});

test('browser finish/cancel status cannot report the whole microphone off while continuous capture is armed', async () => {
  const f = fixture(); let callbacks;
  f.context.FakeVoiceController = class { constructor(hooks) { callbacks = hooks; } capabilities() { return { recognition: true, synthesis: true, localVoices: [] }; } };
  vm.runInContext(`${actual('localMicrophoneStatus')}\n${actual('browserVoiceStatus')}\n${actual('setupVoice').replace("await import('/voice.js')", '({ VoiceController: FakeVoiceController })')}`, f.context);
  await f.context.setupVoice(); f.enable(); f.controller.listening = true;
  for (const message of ['Finished reading. Microphone off.', 'Speech stopped. Microphone off.', 'Microphone and speech off.']) {
    callbacks.onState({ state: 'idle', message });
    assert.equal(f.context.$('voice-status').textContent, 'Local reading is idle. Still listening for your next question.');
  }
  f.controller.listening = false; callbacks.onState({ state: 'idle', message: 'Microphone and speech off.' });
  assert.match(f.context.$('voice-status').textContent, /microphone is starting/);
  f.ui.continuousEnabled = false; callbacks.onState({ state: 'idle', message: 'Finished reading. Microphone off.' });
  assert.equal(f.context.$('voice-status').textContent, 'Finished reading. Microphone off.');
});
