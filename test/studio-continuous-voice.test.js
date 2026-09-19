import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { VoiceSegmenter, ContinuousVoiceController, encodeWav } from '../studio/public/continuous-voice.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const frame = (value = 0.07) => new Float32Array(320).fill(value);
const segment = () => ({ frames: Array.from({ length: 20 }, () => frame()), speechStartMs: 100, speechEndMs: 500 });
const anchor = { connectionId: 'reader', revision: 5, viewEpoch: 5, pageId: 'p1', selectedId: 'block1' };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('WAV encoder emits canonical bounded mono PCM, clamps samples and rejects invalid durations', () => {
  const frames = Array.from({ length: 10 }, () => frame()); frames[0][0] = 4; frames[0][1] = -4; frames[0][2] = NaN;
  const wav = Buffer.from(encodeWav(frames));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE'); assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readInt16LE(44), 32767); assert.equal(wav.readInt16LE(46), -32768); assert.equal(wav.readInt16LE(48), 0);
  assert.throws(() => encodeWav([frame()])); assert.throws(() => encodeWav(Array.from({ length: 1001 }, () => frame())));
});

test('VAD ignores quiet and a brief click, detects sustained barge-in during playback and finishes once', () => {
  const events = []; const vad = new VoiceSegmenter({ onStart: value => events.push(['start', value]), onComplete: value => events.push(['end', value]) });
  let now = 0; const feed = (n, value) => { for (let i = 0; i < n; i++) vad.push(frame(value), now += 20); };
  feed(30, 0.001); feed(3, 0.2); feed(35, 0.001); assert.equal(events.length, 0);
  vad.playback = true; feed(20, 0.06); assert.equal(events.length, 1);
  feed(40, 0); assert.deepEqual(events.map(e => e[0]), ['start', 'end']);
  assert.ok(events[1][1].speechEndMs < now - 620);
  assert.ok(Buffer.from(encodeWav(events[1][1].frames)).length > 44);
});

test('VAD discards an overlong utterance and drains its tail until a full silence gap', () => {
  const complete = [], discarded = [], starts = [];
  const vad = new VoiceSegmenter({ onComplete: value => complete.push(value), onDiscard: value => discarded.push(value), onStart: value => starts.push(value) });
  let now = 0; const feed = (n, value = 0.07) => { for (let i = 0; i < n; i++) vad.push(frame(value), now += 20); };
  feed(1000);
  assert.equal(complete.length, 0); assert.deepEqual(discarded, ['too-long']);
  assert.equal(vad.draining, true); assert.equal(vad.frames, null); assert.equal(vad.pre.length, 0);
  feed(2000); feed(30, 0); feed(20); // A 600ms pause is shorter than the 620ms end threshold.
  assert.equal(starts.length, 1); assert.equal(complete.length, 0); assert.deepEqual(discarded, ['too-long']);
  assert.equal(vad.frames, null); assert.equal(vad.pre.length, 0);
  feed(31, 0); assert.equal(vad.draining, false);
  feed(20); feed(31, 0);
  assert.equal(starts.length, 2); assert.equal(complete.length, 1); assert.equal(complete[0].limited, false);
  assert.equal(complete[0].frames.length, 51); // Only the new 400ms question and its trailing pause.
});

test('worklet resamples 48 kHz into exact 16 kHz 20ms packets and outputs no audible signal', () => {
  const packets = []; let Processor;
  const context = vm.createContext({ sampleRate: 48000, Float32Array,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => packets.push(data) }; } },
    registerProcessor: (_name, value) => { Processor = value; },
  });
  vm.runInContext(fs.readFileSync(new URL('../studio/public/capture-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor();
  for (let i = 0; i < 375; i++) assert.equal(processor.process([[new Float32Array(128).fill(0.25)]]), true);
  assert.equal(packets.length, 50); assert.ok(packets.every(p => p.length === 320 && p.every(v => v === 0.25)));
});

function fixture(options = {}) {
  const results = [], errors = [], states = [], calls = [];
  const voice = new ContinuousVoiceController({ now: () => 800, onSpeechStart: () => anchor,
    onTranscript: value => results.push(value), onError: value => errors.push(value), onState: value => states.push(value),
    transcribe: async value => { calls.push(value); return { text: 'Why is the slope twenty?', metrics: { transcriptionMs: 100 } }; }, ...options });
  voice.active = true; voice.listening = true;
  return { voice, results, errors, states, calls };
}

test('overlong speech sends no ASR or transcript, survives a view change, and accepts the next short question', async () => {
  const onset = deferred(); let starts = 0;
  const f = fixture({ onSpeechStart: () => { starts++; return starts === 1 ? onset.promise : anchor; } });
  let now = 0; const feed = (n, value = 0.07) => { for (let i = 0; i < n; i++) f.voice.segmenter.push(frame(value), now += 20); };
  feed(1000); await flush();
  assert.equal(f.calls.length, 0); assert.equal(f.results.length, 0); assert.equal(f.voice.current, null);
  assert.match(f.states.at(-1).message, /not sent.*Pause.*shorter/);
  assert.equal(f.voice.active, true); assert.equal(f.voice.listening, true);
  onset.resolve(anchor); await flush(); // A late cancellation anchor must not revive the discarded prefix.
  f.voice.invalidate(); assert.equal(f.voice.segmenter.draining, true);
  feed(200); feed(30, 0); feed(30); await flush();
  assert.equal(starts, 1); assert.equal(f.calls.length, 0); assert.equal(f.results.length, 0);
  feed(31, 0); feed(20); feed(31, 0); await flush();
  assert.equal(starts, 2); assert.equal(f.calls.length, 1); assert.equal(f.results.length, 1);
  assert.equal(f.results[0].text, 'Why is the slope twenty?'); assert.deepEqual(f.calls[0].anchor, anchor);
  assert.equal(f.voice.active, true); assert.equal(f.voice.listening, true);
});

test('Stop clears overlong draining state for a future explicit microphone start', () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) f.voice.segmenter.push(frame(), i * 20);
  assert.equal(f.voice.segmenter.draining, true);
  f.voice.stop(); assert.equal(f.voice.segmenter.draining, false); assert.equal(f.voice.active, false);
});

test('onset stops output synchronously; transcription waits for cancellation anchor and submits once', async () => {
  const gate = deferred(); let interrupted = false;
  const f = fixture({ onSpeechStart() { interrupted = true; return gate.promise; } });
  f.voice.begin({ speechStartMs: 100 }); assert.equal(interrupted, true);
  const first = f.voice.complete(segment()), duplicate = f.voice.complete(segment()); await flush(); assert.equal(f.calls.length, 0);
  gate.resolve(anchor); await Promise.all([first, duplicate]);
  assert.equal(f.calls.length, 1); assert.equal(f.results.length, 1);
  assert.deepEqual(f.results[0].anchor, anchor); assert.equal(Object.isFrozen(f.results[0].anchor), true);
  assert.equal(f.results[0].metrics.speechEndMs, 500); assert.equal(f.results[0].metrics.transcriptReadyMs, 800);
});

test('failed/stale onset handshake never transcribes the captured audio', async () => {
  const f = fixture({ onSpeechStart: async () => null });
  f.voice.begin({ speechStartMs: 100 }); await f.voice.complete(segment());
  assert.equal(f.calls.length, 0); assert.equal(f.results.length, 0); assert.equal(f.voice.active, true);
});

test('new speech aborts local ASR; a late response cannot answer over the new question', async () => {
  const gates = [], calls = [];
  const f = fixture({ transcribe: value => { calls.push(value); const gate = deferred(); gates.push(gate); return gate.promise; } });
  f.voice.begin({ speechStartMs: 100 }); const first = f.voice.complete(segment()); await flush();
  f.voice.begin({ speechStartMs: 1000 }); assert.equal(calls[0].signal.aborted, true);
  const second = f.voice.complete(segment()); await flush();
  gates[0].resolve({ text: 'Old result' }); await first; assert.equal(f.results.length, 0);
  gates[1].resolve({ text: 'New result' }); await second; assert.equal(f.results.length, 1); assert.equal(f.results[0].text, 'New result');
});

test('page invalidation drops pending onset and keeps the microphone armed', async () => {
  const gate = deferred(); const f = fixture({ onSpeechStart: () => gate.promise });
  f.voice.begin({ speechStartMs: 100 }); const pending = f.voice.complete(segment());
  f.voice.invalidate(); gate.resolve(anchor); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.voice.active, true); assert.equal(f.voice.listening, true);
});

test('Stop aborts transcription and discards late callbacks, without reopening the microphone', async () => {
  const gate = deferred(); let request;
  const f = fixture({ transcribe: value => { request = value; return gate.promise; } });
  f.voice.begin({ speechStartMs: 100 }); const pending = f.voice.complete(segment()); await flush();
  f.voice.stop(); assert.equal(request.signal.aborted, true);
  gate.resolve({ text: 'Late answer' }); await pending;
  assert.equal(f.results.length, 0); assert.equal(f.voice.active, false); assert.equal(f.voice.listening, false);
  assert.equal(f.states.at(-1).state, 'off');
});

test('empty speech stays local and ASR errors never fabricate a submitted question', async () => {
  const f = fixture({ transcribe: async () => ({ text: '   ' }) });
  f.voice.begin({ speechStartMs: 100 }); await f.voice.complete(segment()); assert.equal(f.results.length, 0);
  f.voice.transcribe = async () => { throw new Error('Local recognizer is unavailable.'); };
  f.voice.begin({ speechStartMs: 1000 }); await f.voice.complete(segment());
  assert.equal(f.results.length, 0); assert.equal(f.errors.length, 1); assert.equal(f.voice.active, true);
});

test('permission resolving after Stop releases the stream without creating a processor', async () => {
  const gate = deferred(); let requested = 0, stopped = 0, closed = 0, modules = 0;
  const scope = {
    navigator: { mediaDevices: { getUserMedia: () => { requested++; return gate.promise; } } },
    AudioContext: class { resume() { return Promise.resolve(); } close() { closed++; return Promise.resolve(); } audioWorklet = { addModule: async () => { modules++; } }; },
    AudioWorkletNode: class {},
  };
  const voice = new ContinuousVoiceController({ scope }); assert.equal(requested, 0);
  const pending = voice.start(); voice.stop();
  gate.resolve({ getTracks: () => [{ stop: () => { stopped++; } }] });
  assert.equal(await pending, false); assert.equal(stopped, 1); assert.equal(modules, 0); assert.ok(closed >= 1); assert.equal(voice.active, false);
});
