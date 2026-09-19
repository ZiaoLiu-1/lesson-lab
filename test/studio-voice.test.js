import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../studio/public/voice.js';

// All speech implementations here are explicit fakes. No microphone, network, or system speech.
class Clock {
  now = 0;
  id = 0;
  jobs = new Map();
  setTimeout = (fn, ms) => { const id = ++this.id; this.jobs.set(id, { at: this.now + ms, fn }); return id; };
  clearTimeout = id => this.jobs.delete(id);
  advance(ms) {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.jobs.delete(next[0]);
      next[1].fn();
    }
    this.now = until;
  }
}

const local = { name: 'Local English', lang: 'en-US', voiceURI: 'local-en', localService: true, default: false };
const remote = { name: 'Remote English', lang: 'en-US', voiceURI: 'remote-en', localService: false, default: true };
function setup({ voices = [remote, local], recognition = true, prefixed = false, ...options } = {}) {
  const recognizers = [], utterances = [], transcripts = [], states = [], errors = [], order = [];
  const timers = new Clock();
  class Recognition {
    constructor() { recognizers.push(this); this.stops = 0; this.aborts = 0; }
    start() { order.push('start'); if (options.startError) throw options.startError; }
    stop() { this.stops++; if (options.stopError) throw options.stopError; }
    abort() { this.aborts++; this.onerror?.({ error: 'aborted' }); this.onend?.(); }
  }
  class Utterance { constructor(text) { this.text = text; } }
  const listeners = new Map();
  const synth = {
    voices, cancelled: 0,
    getVoices() { return this.voices; },
    speak(utterance) { utterances.push(utterance); },
    cancel() { this.cancelled++; utterances.at(-1)?.onerror?.({ error: 'canceled' }); },
    addEventListener(event, fn) { listeners.set(event, fn); },
    removeEventListener(event, fn) { if (listeners.get(event) === fn) listeners.delete(event); },
  };
  const scope = { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance };
  if (recognition) scope[prefixed ? 'webkitSpeechRecognition' : 'SpeechRecognition'] = Recognition;
  const voice = new VoiceController({ scope, timers,
    onTranscript: value => transcripts.push(value), onState: value => states.push(value), onError: value => errors.push(value),
    onInterrupt: () => { order.push('interrupt'); options.onInterrupt?.(); },
  });
  const result = (api, text, isFinal = true) => api.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
  return { voice, scope, timers, recognizers, utterances, transcripts, states, errors, order, synth, listeners, result };
}

test('Node import/construct/capabilities do not start speech or require window', () => {
  const voice = new VoiceController({ scope: {} });
  assert.deepEqual(voice.capabilities(), { recognition: false, synthesis: false, localVoices: [] });
  assert.equal(voice.state, 'idle');
  const h = setup();
  assert.equal(h.recognizers.length, 0);
  assert.equal(h.utterances.length, 0);
  assert.deepEqual(h.voice.capabilities().localVoices, [{ name: local.name, lang: local.lang, voiceURI: local.voiceURI }]);
  assert.equal(h.timers.jobs.size, 0);
});

test('captures immutable anchor before interrupt and emits exactly one final transcript', () => {
  const anchor = { pageId: 'p1', revision: 4, selection: { id: 'derivative', range: [1, 3] } };
  const h = setup({ onInterrupt: () => { anchor.revision = 9; } });
  assert.equal(h.voice.start(anchor), true);
  anchor.selection.id = 'new-section';
  const api = h.recognizers[0];
  assert.deepEqual(h.order, ['interrupt', 'start']);
  assert.equal(api.continuous, false);
  assert.equal(api.interimResults, false);
  api.onstart();
  h.result(api, 'unfinished', false);
  assert.equal(h.transcripts.length, 0);
  h.result(api, '  Why is the slope two?  ');
  h.result(api, 'duplicate');
  api.onend();
  assert.equal(h.transcripts.length, 1);
  assert.deepEqual(h.transcripts[0], { text: 'Why is the slope two?', anchor: { pageId: 'p1', revision: 4, selection: { id: 'derivative', range: [1, 3] } } });
  assert.throws(() => { h.transcripts[0].anchor.selection.range[0] = 7; }, TypeError);
  assert.equal(api.aborts, 1);
  assert.equal(h.errors.length, 0);
  assert.equal(h.timers.jobs.size, 0);
});

test('cancel on view change invalidates late result/start/error/end and permits a fresh anchor', () => {
  const h = setup();
  h.voice.start({ pageId: 'old' });
  const old = h.recognizers[0];
  const late = { start: old.onstart, result: old.onresult, error: old.onerror, end: old.onend };
  h.voice.cancel();
  h.voice.start({ pageId: 'new' });
  late.start(); late.error({ error: 'network' }); late.end();
  late.result({ results: [Object.assign([{ transcript: 'stale answer' }], { isFinal: true })] });
  assert.equal(h.voice.state, 'starting');
  assert.equal(h.transcripts.length, 0);
  assert.equal(h.errors.length, 0);
  h.result(h.recognizers[1], 'Current question');
  assert.equal(h.transcripts[0].anchor.pageId, 'new');
});

test('manual stop requests finalization once and still accepts its final transcript', () => {
  const h = setup(); h.voice.start({ revision: 1 });
  const api = h.recognizers[0]; api.onstart();
  assert.equal(h.voice.stop(), true);
  assert.equal(h.voice.stop(), false);
  assert.equal(api.stops, 1);
  assert.equal(api.aborts, 0);
  assert.equal(h.voice.state, 'stopping');
  h.result(api, 'Finished question');
  assert.equal(h.transcripts.length, 1);
  h.timers.advance(100000);
  assert.equal(h.errors.length, 0);
});

test('stop before start retries a browser InvalidStateError after onstart', () => {
  const options = { stopError: Object.assign(new Error('not ready'), { name: 'InvalidStateError' }) };
  const h = setup(options); h.voice.start({});
  const api = h.recognizers[0];
  h.voice.stop();
  // Replace the fake behavior to model the browser becoming ready.
  api.stop = () => { api.stops++; };
  api.onstart();
  assert.equal(api.stops, 2);
  assert.equal(h.voice.state, 'stopping');
  h.result(api, 'Final after startup');
  assert.equal(h.transcripts.length, 1);
  assert.equal(h.errors.length, 0);
});

for (const code of ['not-allowed', 'network', 'no-speech', 'audio-capture', 'service-not-allowed']) {
  test(`recognition ${code} is clear, stops capture, and cannot later deliver a transcript`, () => {
    const h = setup(); h.voice.start({});
    const api = h.recognizers[0];
    api.onerror({ error: code, message: 'untrusted raw browser detail' });
    h.result(api, 'late'); api.onend();
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0].code, code);
    assert.match(h.errors[0].message, /question|dictation|text/);
    assert.equal(h.errors[0].message.includes('untrusted'), false);
    assert.equal(api.aborts, 1);
    assert.equal(h.transcripts.length, 0);
    assert.equal(h.timers.jobs.size, 0);
  });
}

test('unsupported and prefixed recognition paths retain text fallback', () => {
  const unavailable = setup({ recognition: false });
  assert.equal(unavailable.voice.start({}), false);
  assert.equal(unavailable.voice.state, 'unsupported');
  assert.equal(unavailable.recognizers.length, 0);
  const prefixed = setup({ prefixed: true });
  assert.equal(prefixed.voice.start({}), true);
  prefixed.voice.cancel();
});

test('non-user activation and invalid anchors cannot start capture', () => {
  const h = setup();
  h.scope.navigator = { userActivation: { isActive: false } };
  assert.equal(h.voice.start({}), false);
  assert.equal(h.errors[0].code, 'user-gesture-required');
  assert.equal(h.recognizers.length, 0);
  const cycle = {}; cycle.self = cycle;
  assert.equal(h.voice.start(cycle), false);
  assert.equal(h.errors[1].code, 'invalid-anchor');
});

test('startup, missing finalization, and missing recognition end have bounded cleanup', () => {
  for (const mode of ['startup', 'stop', 'maximum']) {
    const h = setup(); h.voice.start({});
    const api = h.recognizers[0];
    if (mode !== 'startup') api.onstart();
    if (mode === 'stop') h.voice.stop();
    h.timers.advance(mode === 'startup' ? 15000 : mode === 'stop' ? 5000 : 90000);
    assert.equal(h.errors[0].code, 'recognition-timeout', mode);
    assert.equal(api.aborts, 1);
    h.result(api, 'too late');
    assert.equal(h.transcripts.length, 0);
    assert.equal(h.timers.jobs.size, 0);
  }
});

test('recognition start exception and end without result remain recoverable', () => {
  const h = setup({ startError: Object.assign(new Error(), { name: 'NotAllowedError' }) });
  assert.equal(h.voice.start({}), false);
  assert.equal(h.errors[0].code, 'not-allowed');
  assert.equal(h.timers.jobs.size, 0);
  const quiet = setup(); quiet.voice.start({}); quiet.recognizers[0].onend();
  assert.equal(quiet.errors[0].code, 'no-speech');
  assert.equal(quiet.voice.start({ pageId: 'retry' }), true);
  quiet.voice.cancel();
});

test('only an explicitly local English voice is spoken; callbacks follow actual events once', () => {
  const h = setup({ voices: [remote, { ...local, lang: 'fr-FR', default: true }, local] });
  const events = [];
  h.voice.speak('The tangent slope is two.', { onStart: () => events.push('start'), onEnd: () => events.push('end') });
  const utterance = h.utterances[0];
  assert.equal(utterance.voice, local);
  assert.equal(utterance.lang, 'en-US');
  assert.equal(h.voice.state, 'speech-queued');
  assert.deepEqual(events, []);
  utterance.onstart(); utterance.onstart();
  assert.deepEqual(events, ['start']);
  utterance.onend(); utterance.onend();
  assert.deepEqual(events, ['start', 'end']);
  assert.equal(h.timers.jobs.size, 0);
});

test('remote-only or unknown-locality voices never silently fall back; voiceschanged does not autoplay', () => {
  const h = setup({ voices: [remote, { ...local, localService: undefined }] });
  let failed;
  const cancel = h.voice.speak('Text', { onError: e => { failed = e; } });
  assert.equal(failed.code, 'no-local-voice');
  assert.equal(h.utterances.length, 0);
  cancel();
  h.synth.voices = [local]; h.listeners.get('voiceschanged')();
  assert.equal(h.states.at(-1).capabilities.localVoices.length, 1);
  assert.equal(h.utterances.length, 0);
  h.voice.speak('Retry explicitly');
  assert.equal(h.utterances.length, 1);
  h.voice.cancel();
});

test('explicit voice selection overrides automatic preference and accepts only current local English voices', () => {
  const selected = { ...local, name: 'Selected English', lang: 'en-GB', voiceURI: 'local-gb' };
  const french = { ...local, name: 'French', lang: 'fr-FR', voiceURI: 'local-fr' };
  const h = setup({ voices: [remote, { ...local, default: true }, selected, french] });
  assert.equal(h.voice.setVoice(selected.voiceURI), true);
  assert.equal(h.utterances.length, 0);
  h.voice.speak('Use the selected local voice.');
  assert.equal(h.utterances.at(-1).voice, selected);
  h.voice.cancel();
  for (const value of [remote.voiceURI, french.voiceURI, 'missing', undefined, 5]) {
    assert.equal(h.voice.setVoice(value), false);
    assert.equal(h.errors.at(-1).code, 'invalid-voice');
  }
  h.voice.speak('The last valid selection remains selected.');
  assert.equal(h.utterances.at(-1).voice, selected);
  h.voice.cancel();
});

test('clearing voice selection restores automatic preference without starting, cancelling, or emitting state', () => {
  const preferred = { ...local, default: true };
  const selected = { ...local, name: 'Selected English', voiceURI: 'selected-local' };
  const h = setup({ voices: [preferred, selected] });
  for (const automatic of ['', null]) {
    assert.equal(h.voice.setVoice(selected.voiceURI), true);
    h.voice.speak('Existing utterance uses the explicit selection.');
    const utterance = h.utterances.at(-1);
    assert.equal(utterance.voice, selected);
    const before = { states: h.states.length, utterances: h.utterances.length, cancelled: h.synth.cancelled };
    assert.equal(h.voice.setVoice(automatic), true);
    assert.deepEqual({ states: h.states.length, utterances: h.utterances.length, cancelled: h.synth.cancelled }, before);
    assert.equal(utterance.voice, selected);
    h.voice.cancel();
    h.voice.speak('The next utterance uses automatic selection.');
    assert.equal(h.utterances.at(-1).voice, preferred);
    h.voice.cancel();
  }
});

test('automatic local preference uses local default, then Samantha, then Alex, before generic voices', () => {
  const albert = { ...local, name: 'Albert', voiceURI: 'albert' };
  const alex = { ...local, name: 'Alex', voiceURI: 'alex' };
  const samantha = { ...local, name: 'Samantha (Enhanced)', voiceURI: 'samantha' };
  for (const [voices, expected] of [
    [[albert, alex, samantha], samantha],
    [[albert, alex], alex],
    [[{ ...albert, default: true }, samantha], 'albert'],
    [[remote, albert], albert],
  ]) {
    const h = setup({ voices });
    h.voice.speak('Preference fixture.');
    assert.equal(h.utterances[0].voice.voiceURI, typeof expected === 'string' ? expected : expected.voiceURI);
    h.voice.cancel();
  }
});

test('new local voices are selectable, but a disappearing selected voice never silently falls back', () => {
  const h = setup({ voices: [local] });
  const added = { ...local, name: 'Samantha', voiceURI: 'new-local' };
  assert.equal(h.voice.setVoice(added.voiceURI), false);
  h.synth.voices = [local, added]; h.listeners.get('voiceschanged')();
  assert.equal(h.voice.capabilities().localVoices.length, 2);
  assert.equal(h.voice.setVoice(added.voiceURI), true);
  assert.equal(h.utterances.length, 0);
  h.synth.voices = [local, remote]; h.listeners.get('voiceschanged')();
  h.voice.speak('Do not substitute another voice.');
  assert.equal(h.errors.at(-1).code, 'selected-voice-unavailable');
  assert.equal(h.utterances.length, 0);
  h.synth.voices = [{ ...added, localService: false }, local];
  h.voice.speak('Do not reuse a voice that is now remote.');
  assert.equal(h.utterances.length, 0);
  assert.equal(h.voice.setVoice(local.voiceURI), true);
  h.voice.speak('Explicitly choose an available voice.');
  assert.equal(h.utterances[0].voice, local);
  h.voice.cancel();
});

test('queued speech can be cancelled before onstart and all late callbacks are ignored', () => {
  const h = setup(); const events = [];
  const cancel = h.voice.speak('Do not speak late.', { onStart: () => events.push('start'), onEnd: () => events.push('end'), onError: () => events.push('error') });
  const utterance = h.utterances[0];
  cancel(); cancel();
  utterance.onstart(); utterance.onend(); utterance.onerror({ error: 'canceled' });
  assert.deepEqual(events, []);
  assert.equal(h.synth.cancelled, 1);
  assert.equal(h.voice.state, 'idle');
  assert.equal(h.timers.jobs.size, 0);
});

test('an older speech cancel handle cannot stop a replacement utterance', () => {
  const h = setup();
  const oldCancel = h.voice.speak('Old');
  h.voice.speak('New');
  const cancellations = h.synth.cancelled;
  oldCancel();
  assert.equal(h.synth.cancelled, cancellations);
  h.utterances[1].onstart();
  assert.equal(h.voice.state, 'speaking');
  h.voice.cancel();
});

test('new input interrupts speech; playback cancels an old microphone result', () => {
  const h = setup(); let started = false;
  h.voice.speak('Previous response', { onStart: () => { started = true; } });
  const speech = h.utterances[0];
  h.voice.start({ pageId: 'input' });
  speech.onstart(); assert.equal(started, false);
  const api = h.recognizers[0];
  h.voice.speak('New response');
  h.result(api, 'self-echo or stale microphone');
  assert.equal(h.transcripts.length, 0);
  assert.equal(api.aborts, 1);
  h.voice.cancel();
});

test('speech timeout and premature end are failures, never fabricated start/end events', () => {
  for (const mode of ['timeout', 'premature-end', 'error']) {
    const h = setup(); const events = [];
    h.voice.speak('Text', { onStart: () => events.push('start'), onEnd: () => events.push('end'), onError: e => events.push(e.code) });
    if (mode === 'timeout') h.timers.advance(10000);
    if (mode === 'premature-end') h.utterances[0].onend();
    if (mode === 'error') h.utterances[0].onerror({ error: 'synthesis-failed' });
    assert.deepEqual(events, [mode === 'timeout' ? 'speech-timeout' : mode === 'premature-end' ? 'speech-no-start' : 'speech-failed']);
    assert.equal(h.timers.jobs.size, 0);
    h.utterances[0].onstart();
    assert.equal(events.length, 1);
  }
});

test('destroy stops active work, removes voice listener, and prevents new capture/playback', () => {
  const h = setup(); h.voice.start({});
  h.voice.destroy();
  assert.equal(h.recognizers[0].aborts, 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.voice.start({}), false);
  h.voice.speak('Do not restart');
  assert.equal(h.utterances.length, 0);
});
