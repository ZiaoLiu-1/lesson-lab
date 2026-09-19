import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalTranscription, decodeTranscriptionAudio, LocalTranscriptionError } from '../studio/transcription.js';

function wav(seconds = 0.5) {
  const size = Math.round(16000 * seconds) * 2, bytes = Buffer.alloc(44 + size);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(size, 40);
  return bytes;
}
const checkError = code => error => {
  assert.ok(error instanceof LocalTranscriptionError); assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /PRIVATE|secret|diagnostic|csk-/); return true;
};
function fixture(t, mode = 'success', options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-test-')), calls = [];
  const spawnImpl = (command, args, spawnOptions) => {
    if (mode === 'throw') throw new Error('PRIVATE secret spawn path');
    const child = new EventEmitter(), input = args[args.indexOf('--file') + 1], output = args[args.indexOf('--output-file') + 1] + '.json';
    const call = { command, args, spawnOptions, child, input, output, audio: fs.readFileSync(input), signals: [] }; calls.push(call);
    assert.equal(fs.statSync(path.dirname(input)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(input).mode & 0o777, 0o600); assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    child.kill = signal => { call.signals.push(signal); if (mode !== 'unclosed') queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(() => {
      if (mode === 'pending' || mode === 'unclosed') return;
      if (mode === 'error') return child.emit('error', new Error('PRIVATE secret diagnostic'));
      if (mode === 'nonzero') return child.emit('close', 1);
      const contents = mode === 'invalid' ? '{PRIVATE invalid json'
        : mode === 'oversized' ? ' '.repeat(256001)
        : JSON.stringify(mode === 'shape' ? { transcription: [{ text: 10 }] }
          : mode === 'long' ? { transcription: [{ text: 'x'.repeat(2001) }] }
          : mode === 'control' ? { transcription: [{ text: 'bad\0text' }] }
          : mode === 'empty' ? { transcription: [] }
          : { params: { model: 'PRIVATE-model-path' }, transcription: [{ text: ' Set a' }, { text: ' to ten.\n' }] });
      fs.writeFileSync(output, contents); child.emit('close', 0);
    });
    return child;
  };
  const transcriber = createLocalTranscription({ binPath: '/PRIVATE/whisper-cli', modelPath: '/PRIVATE/tiny.en.bin', spawnImpl, tempRoot, ...options });
  t.after(() => { transcriber.cancel(); fs.rmSync(tempRoot, { recursive: true, force: true }); });
  return { transcriber, calls, tempRoot };
}
async function entered(h) { for (let i = 0; !h.calls.length && i < 200; i++) await new Promise(done => setTimeout(done, 1)); assert.ok(h.calls.length); }

test('local transcription accepts only canonical bounded 16 kHz mono PCM16 WAV and strict base64', () => {
  for (const seconds of [0.2, 1, 20]) assert.deepEqual(decodeTranscriptionAudio(wav(seconds).toString('base64')), wav(seconds));
  for (const audio of ['', null, 'data:audio/wav;base64,AAAA', 'not base64', wav(0.199).toString('base64'), wav(20.001).toString('base64'), wav().toString('base64') + '\n']) {
    assert.throws(() => decodeTranscriptionAudio(audio), checkError('transcription_invalid_audio'));
  }
  for (const edit of [b => b.writeUInt16LE(2, 22), b => b.writeUInt32LE(48000, 24), b => b.writeUInt32LE(44100, 28),
    b => b.writeUInt16LE(4, 32), b => b.writeUInt16LE(32, 34), b => b.writeUInt32LE(1, 40), b => b.write('JUNK', 36), b => b.writeUInt32LE(99, 4)]) {
    const bytes = wav(); edit(bytes); assert.throws(() => decodeTranscriptionAudio(bytes.toString('base64')), checkError('transcription_invalid_audio'));
  }
});

test('Whisper CLI receives private files and fixed argv without a shell; only parsed transcript and actual time are returned', async t => {
  const h = fixture(t); const result = await h.transcriber.transcribe(wav());
  assert.equal(h.transcriber.available, true); assert.equal(h.transcriber.engine, 'localWhisper');
  assert.equal(result.text, 'Set a to ten.'); assert.ok(Number.isFinite(result.metrics.transcriptionMs) && result.metrics.transcriptionMs >= 0);
  const call = h.calls[0]; assert.equal(call.command, '/PRIVATE/whisper-cli');
  assert.deepEqual(call.args, ['--model', '/PRIVATE/tiny.en.bin', '--file', call.input, '--language', 'en', '--threads', '4',
    '--no-gpu', '--output-json', '--output-file', call.output.slice(0, -5), '--no-prints', '--no-timestamps']);
  assert.deepEqual(call.spawnOptions, { shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
  assert.deepEqual(call.audio, wav()); assert.deepEqual(fs.readdirSync(h.tempRoot), []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|model|params/);
});

test('missing dependencies, invalid audio, and a pre-aborted request do not spawn recognition', async t => {
  const h = fixture(t);
  await assert.rejects(h.transcriber.transcribe(Buffer.from('bad')), checkError('transcription_invalid_audio'));
  await assert.rejects(h.transcriber.transcribe(wav(), { signal: AbortSignal.abort() }), checkError('transcription_cancelled'));
  assert.equal(h.calls.length, 0);
  const unavailable = createLocalTranscription({ binPath: '/definitely-missing-whisper', modelPath: '/definitely-missing-model' });
  assert.equal(unavailable.available, false);
  await assert.rejects(unavailable.transcribe(wav()), checkError('transcription_unavailable'));
});

test('external cancellation kills the active local process and keeps subsequent recordings separate', async t => {
  const h = fixture(t, 'pending'), abort = new AbortController();
  const pending = h.transcriber.transcribe(wav(), { signal: abort.signal }); await entered(h);
  await assert.rejects(h.transcriber.transcribe(wav()), checkError('transcription_busy'));
  abort.abort(); await assert.rejects(pending, checkError('transcription_cancelled'));
  assert.deepEqual(h.calls[0].signals, ['SIGKILL']); assert.deepEqual(fs.readdirSync(h.tempRoot), []);
  const second = h.transcriber.transcribe(wav()); h.transcriber.cancel();
  await assert.rejects(second, checkError('transcription_cancelled'));
});

test('deadline cleans temporary audio while retaining the process lock until actual close', async t => {
  const h = fixture(t, 'unclosed', { timeoutMs: 30 });
  const pending = h.transcriber.transcribe(wav()); await entered(h);
  await assert.rejects(pending, checkError('transcription_timeout'));
  assert.deepEqual(h.calls[0].signals, ['SIGKILL']); assert.deepEqual(fs.readdirSync(h.tempRoot), []);
  await assert.rejects(h.transcriber.transcribe(wav()), checkError('transcription_busy'));
  h.calls[0].child.emit('close', null);
  const second = h.transcriber.transcribe(wav()); h.transcriber.cancel();
  await assert.rejects(second, checkError('transcription_cancelled'));
});

for (const mode of ['error', 'nonzero', 'throw', 'invalid', 'shape', 'oversized', 'long', 'control']) {
  test(`transcription ${mode} failures are sanitized and leave no temporary recording`, async t => {
    const h = fixture(t, mode);
    await assert.rejects(h.transcriber.transcribe(wav()), checkError(['error', 'nonzero', 'throw'].includes(mode) ? 'transcription_failed' : 'transcription_invalid_output'));
    assert.deepEqual(fs.readdirSync(h.tempRoot), []);
  });
}
test('a valid empty recognition result returns no invented words', async t => {
  const h = fixture(t, 'empty'); assert.equal((await h.transcriber.transcribe(wav())).text, '');
});
