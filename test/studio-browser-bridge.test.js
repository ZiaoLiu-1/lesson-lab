import { spokenText } from '../studio/public/narration.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../studio/public/app.js', import.meta.url), 'utf8');
// Execute the actual named functions; no browser startup, source-rewritten logic, or network.
function functionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing actual UI function ${name}`);
  const start = match.index;
  const next = /\n(?:async )?function \w+\(/g;
  next.lastIndex = start + match[0].length;
  const end = next.exec(source)?.index ?? source.length;
  return source.slice(start, end).trim();
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture() {
  const state = { lessonId: 'lesson', pageId: 'p1', selectedId: 'b1', revision: 0, viewEpoch: 0, mode: 'lesson' };
  const ui = { state, connectionId: 'reader', connected: true, controlBusy: false, fileBusy: false, previewA: null, view: 'study', config: { keyConfigured: true }, active: null, audio: null, accepted: null, voiceState: 'idle' };
  const answer = { visible: true, scrollIntoView() {} };
  const article = { dataset: { turnId: 'turn' }, querySelector: () => answer };
  const passage = { dataset: { passageId: 'b1' }, visible: true };
  const elements = new Map([['conversation', { scrollHeight: 100, scrollTop: 0, querySelectorAll: () => [article] }]]);
  const writes = []; const errors = []; const spoken = [];
  const context = vm.createContext({ spokenText,
    ui, bridgeJobs: new Set(), timer: null, AbortController, performance: { now: () => 200 }, crypto: { randomUUID: () => 'client' },
    document: { hidden: false, querySelectorAll: () => [passage] },
    $(id) { if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: false, textContent: '' }); return elements.get(id); },
    visible(node) { return Boolean(node?.visible && !context.document.hidden); },
    renderConversation() {}, renderControls() {}, renderMetrics() {}, renderStatus() {}, renderTeachingFocus() {},
    setError(message = '') { if (message) errors.push(message); }, announce() {}, setTeachingMarker() {}, followTeachingFocus() {},
    applyState(value) { ui.state = value; }, currentStep: () => ({ id: 'step1', text: 'Prepared words.' }), interpolate: (text) => text,
    twoFrames: async () => {}, settledView: async () => {}, motion: { settled: async () => {} },
    setInterval: () => 1, clearInterval() {}, requestAnimationFrame: () => 1,
    post: async (path, body) => { writes.push({ path, body }); return {}; },
    readText: (text, identity) => spoken.push({ text, identity }),
    showHelp() {}, markDraftStale() {}, finishViewMotion() {},
  });
  vm.runInContext(`let speechGeneration = 0;\n${['teachingFollowKey', 'voiceDelta', 'directVoiceMetrics', 'directPlaybackMetrics', 'ownsContinuousTurn', 'anchor', 'anchorMatches', 'matchesTurn', 'stopAudio', 'reportBridge', 'onBridgeCommand', 'ask', 'onCommit', 'speakPrepared', 'speakReply'].map(functionSource).join('\n')}`, context);
  context.invalidateLocal = () => { context.stopAudio(); ui.active = null; };
  return { context, ui, writes, errors, spoken, passage, answer };
}
const unit = { title: 'Tangent', text: 'Its slope is two.', focusId: 'b1' };
const committedState = { lessonId: 'lesson', pageId: 'p1', selectedId: 'b1', revision: 2, viewEpoch: 1, mode: 'question' };
function commitData() { return { turnId: 'turn', clientTurnId: 'client', state: { ...committedState }, revision: 2, unit }; }

test('remote ask HTTP response can arrive after actual ACK without failing the still-settling bridge job', async () => {
  const f = fixture(); const askResponse = deferred(); const focusMotion = deferred();
  const initial = f.context.anchor();
  f.context.motion.settled = () => focusMotion.promise;
  f.context.post = async (path, body) => {
    f.writes.push({ path, body });
    if (path === '/api/bridge/claim') return { id: 'bridge', clientTurnId: 'client', anchor: initial, command: { kind: 'ask', question: 'Explain this tangent.' } };
    if (path === '/api/ask') return askResponse.promise;
    if (path === '/api/ack') return { state: committedState, unit, turnId: 'turn', metrics: {} };
    return {};
  };
  const remote = f.context.onBridgeCommand({ id: 'bridge' }); await flush();
  assert.ok(f.ui.active); f.ui.active.turnId = 'turn'; f.ui.active.viewEpoch = 1;
  const delivery = f.context.onCommit(commitData()); await flush();
  assert.equal(f.ui.active, null); assert.equal(f.ui.accepted.turnId, 'turn');
  assert.equal(f.writes.filter((entry) => entry.path === '/api/ack').length, 1);
  askResponse.resolve({ turnId: 'turn' }); await remote;
  assert.equal(f.writes.filter((entry) => entry.path === '/api/bridge/result').length, 0, 'completion still waits for the passage');
  assert.deepEqual(f.errors, []);
  focusMotion.resolve(); await delivery;
  const reports = f.writes.filter((entry) => entry.path === '/api/bridge/result');
  assert.equal(reports.length, 1); assert.equal(reports[0].body.status, 'completed');
  assert.deepEqual(f.spoken, [], 'native bridge must not start local narration');
});

test('visible reply ACK does not imply remote passage visibility after an interrupted follow scroll', async () => {
  const f = fixture(); const view = deferred();
  f.ui.active = { turnId: 'turn', clientTurnId: 'client', bridgeId: 'bridge', anchor: f.context.anchor(), viewEpoch: 1, started: 0, timeline: [], cancelled: false };
  f.context.bridgeJobs.add('bridge'); f.passage.visible = false;
  f.context.settledView = () => view.promise;
  f.context.post = async (path, body) => { f.writes.push({ path, body }); return path === '/api/ack' ? { state: committedState, unit, turnId: 'turn' } : {}; };
  const delivery = f.context.onCommit(commitData()); await flush();
  assert.equal(f.writes.length, 0, 'no ACK before graph/note settling');
  view.resolve(); await delivery;
  assert.equal(f.writes[0].path, '/api/ack', 'the actual answer was visible');
  const report = f.writes.find((entry) => entry.path === '/api/bridge/result');
  assert.equal(report.body.status, 'failed'); assert.equal(report.body.visible, false);
  assert.deepEqual(f.spoken, []);
});

test('Stop cancels prepared speech waiting on motion even before an audio object exists', async () => {
  const f = fixture(); const motion = deferred(); f.context.motion.settled = () => motion.promise;
  const pending = f.context.speakPrepared({ id: 'step1' }); await flush();
  assert.equal(f.ui.audio, null); assert.deepEqual(f.spoken, []);
  f.context.stopAudio(); motion.resolve(); await pending;
  assert.deepEqual(f.spoken, []);
  await f.context.speakPrepared({ id: 'step1' }); assert.equal(f.spoken.length, 1, 'an explicit fresh reading remains available');
});

test('new prepared read supersedes an older motion waiter without starting two voices', async () => {
  const f = fixture(); const motion = deferred(); f.context.motion.settled = () => motion.promise;
  const first = f.context.speakPrepared({ id: 'step1' });
  const second = f.context.speakPrepared({ id: 'step1' }); await flush(); motion.resolve();
  await Promise.all([first, second]); assert.equal(f.spoken.length, 1);
});

test('Stop also cancels acknowledged reply speech waiting for focus motion', async () => {
  const f = fixture(); const motion = deferred(); f.context.motion.settled = () => motion.promise;
  const reply = { turnId: 'turn', connectionId: 'reader', unit, started: 0 }; f.ui.accepted = reply;
  const pending = f.context.speakReply(reply); await flush(); f.context.stopAudio(); motion.resolve(); await pending;
  assert.deepEqual(f.spoken, []);
});
