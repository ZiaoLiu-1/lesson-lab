import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { matchesFinaleCommand } from '../studio/public/finale.js';

const source = await readFile(new URL('../studio/public/app.js', import.meta.url), 'utf8');
function actual(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source); assert.ok(match, name);
  const next = /\n(?:async )?function \w+\(/g; next.lastIndex = match.index + match[0].length;
  return source.slice(match.index, next.exec(source)?.index ?? source.length);
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function fixture() {
  const writes = []; const errors = []; const effects = { starts: 0, micStops: 0, audioStops: 0, requestAborts: 0, canvasStops: 0, voiceStops: 0, help: 0 };
  const state = { pageId: 'p1', selectedId: 'b1', revision: 0, viewEpoch: 0 };
  const ui = { state, connectionId: 'reader', view: 'study', connected: true, controlBusy: false, fileBusy: false, previewA: null,
    config: { keyConfigured: false }, active: null, audio: null, marker: null, continuousEnabled: false, continuousEpoch: 4,
    continuousUtteranceId: null, continuousCapture: null, guidedAudio: false, autoTeaching: null,
    continuous: { stop() { effects.micStops++; }, invalidate() {}, setPlayback() {} },
    voice: { cancel() { effects.voiceStops++; } },
    canvas: { cancel() { effects.canvasStops++; }, stopSpeech() {}, handles() { return false; } } };
  const elements = new Map();
  class FakeFinale {
    constructor(options) { this.options = options; }
    start() { effects.starts++; this.options.onStart(); }
    cancel() { this.options.onCancel(); }
  }
  const context = vm.createContext({ ui, FakeFinale, finaleMatcher: matchesFinaleCommand, AbortController, timer: null,
    performance: { now: () => 200 }, crypto: { randomUUID: () => 'request' },
    document: { hidden: false, querySelectorAll: () => [] },
    $(id) { if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: false, textContent: '', focus() {} }); return elements.get(id); },
    post: async (path, body) => { writes.push({ path, body }); return path === '/api/control' ? { state: { ...ui.state, revision: ui.state.revision + 1, viewEpoch: ui.state.viewEpoch + 1 } } : { turnId: 'turn' }; },
    applyState(value) { ui.state = value; }, setError(message) { if (message) errors.push(message); }, showHelp() { effects.help++; },
    renderControls() {}, renderConversation() {}, renderMetrics() {}, renderTeachingFocus() {}, renderStatus() {}, renderGraph() {},
    finishViewMotion() {}, notice() {}, clearInterval() {}, setInterval: () => 1, requestAnimationFrame() {},
  });
  const names = ['anchor', 'anchorMatches', 'continuousSpokenCommand', 'ownsContinuousTurn', 'receiveContinuousTranscript', 'ask', 'markDraftStale', 'stopAudio', 'invalidateLocal', 'stopAutomaticTeaching', 'endContinuousConversation', 'control'];
  vm.runInContext(`let speechGeneration = 0;\n${names.map(actual).join('\n')}\n${actual('setupFinale').replace("await import('/finale.js')", '({ ShowcaseFinale: FakeFinale, matchesFinaleCommand: finaleMatcher })')}`, context);
  await context.setupFinale();
  assert.deepEqual(errors, [], 'the actual setup function must install the finale');
  const armVoice = () => {
    ui.continuousEnabled = true; ui.continuousUtteranceId = 1;
    const bound = Object.freeze({ ...context.anchor() });
    ui.continuousCapture = { utteranceId: 1, epoch: ui.continuousEpoch, anchor: bound, submitted: false, speechStartMs: 20 };
    return { text: 'Showcase complete.', anchor: bound, utteranceId: 1, metrics: {} };
  };
  return { context, ui, writes, effects, errors, armVoice };
}

test('the exact typed finale works without a Cerebras key and bypasses both model routes', async () => {
  const f = await fixture(); f.context.$('question').value = 'SHOWCASE COMPLETE!';
  await f.context.ask(); await flush();
  assert.equal(f.effects.starts, 1); assert.equal(f.effects.help, 0); assert.equal(f.ui.showcaseEnding, true);
  assert.equal(f.context.$('question').value, ''); assert.equal(f.ui.draftAnchor, null);
  assert.equal(f.writes.filter(item => item.path === '/api/ask' || item.path === '/api/canvas/edit' || item.path === '/api/transcribe').length, 0);
  assert.equal(f.writes.filter(item => item.path === '/api/control' && item.body.action === 'cancel').length, 1);
});

test('one exact final spoken command starts once, stops capture, and never asks Cerebras', async () => {
  const f = await fixture(); const payload = f.armVoice();
  f.context.receiveContinuousTranscript(payload); f.context.receiveContinuousTranscript(payload); await flush();
  assert.equal(f.effects.starts, 1); assert.equal(f.ui.continuousEnabled, false); assert.equal(f.ui.continuousCapture, null);
  assert.equal(f.effects.micStops, 1); assert.equal(f.writes.filter(item => item.path === '/api/ask' || item.path === '/api/canvas/edit').length, 0);
});

for (const change of ['off', 'new-utterance', 'revision', 'selection', 'connection']) test(`stale spoken finale after ${change} cannot end the showcase`, async () => {
  const f = await fixture(); const payload = f.armVoice();
  if (change === 'off') f.ui.continuousEnabled = false;
  if (change === 'new-utterance') f.ui.continuousUtteranceId = 2;
  if (change === 'revision') f.ui.state.revision++;
  if (change === 'selection') f.ui.state.selectedId = 'b2';
  if (change === 'connection') f.ui.connectionId = 'other';
  f.context.receiveContinuousTranscript(payload); await flush();
  assert.equal(f.effects.starts, 0); assert.equal(f.writes.length, 0);
});

test('a stale typed finale retains its draft instead of bypassing the reader anchor', async () => {
  const f = await fixture(); f.context.$('question').value = 'Showcase complete'; f.ui.draftAnchor = f.context.anchor(); f.ui.state.revision++;
  await f.context.ask();
  assert.equal(f.effects.starts, 0); assert.equal(f.writes.length, 0); assert.equal(f.ui.draftStale, true);
  assert.equal(f.context.$('question').value, 'Showcase complete');
});

test('the actual setup onStart synchronously cancels microphone, audio, pending request and auto-teaching', async () => {
  const f = await fixture(); f.armVoice(); f.ui.guidedAudio = true; f.ui.autoTeaching = { serial: 1 };
  f.ui.audio = { connectionId: 'reader', identity: { stepId: 's1' }, cancel() { f.effects.audioStops++; } };
  const pending = { started: 0, timeline: [], controller: { abort() { f.effects.requestAborts++; } } }; f.ui.active = pending;
  f.ui.finale.start();
  assert.equal(f.effects.micStops, 1); assert.equal(f.effects.audioStops, 1); assert.equal(f.effects.requestAborts, 1);
  assert.equal(pending.cancelled, true); assert.equal(f.ui.audio, null); assert.equal(f.ui.active, null);
  assert.equal(f.ui.continuousEnabled, false); assert.equal(f.ui.autoTeaching, null); assert.equal(f.ui.guidedAudio, false);
  assert.ok(f.effects.canvasStops > 0); assert.ok(f.effects.voiceStops > 0);
  await flush(); assert.equal(f.writes.some(item => item.path === '/api/audio' && item.body.phase === 'cancel'), true);
  f.ui.finale.cancel(); assert.equal(f.ui.showcaseEnding, false); assert.equal(f.ui.continuousEnabled, false, 'returning cannot reopen the microphone');
});

test('a remote bridge question cannot invoke local finale navigation', async () => {
  const f = await fixture(); f.ui.config.keyConfigured = true;
  await f.context.ask(null, { id: 'bridge', clientTurnId: 'remote', anchor: f.context.anchor(), command: { question: 'Showcase complete' } });
  assert.equal(f.effects.starts, 0); assert.equal(f.writes.filter(item => item.path === '/api/ask').length, 1);
});
