import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalSpeech, LocalSpeechError } from '../studio/speech.js';

function wav() {
  const dataSize = 100;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(22050, 24); bytes.writeUInt32LE(44100, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40); bytes.writeInt16LE(50, 44);
  return bytes;
}

function fixture(t, mode = 'success', options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-lab-speech-test-'));
  const calls = [];
  const spawnImpl = (command, args, spawnOptions) => {
    const child = new EventEmitter();
    const file = args[args.indexOf('-o') + 1];
    const call = { command, args, spawnOptions, child, file, text: null, signals: [] };
    calls.push(call);
    child.stdin = new EventEmitter();
    child.kill = signal => {
      call.signals.push(signal);
      if (mode !== 'unclosed') queueMicrotask(() => child.emit('close', null));
      return true;
    };
    child.stdin.end = text => {
      call.text = text;
      queueMicrotask(() => {
        if (mode === 'success' || mode === 'invalid') {
          fs.writeFileSync(file, mode === 'success' ? wav() : Buffer.from('not audio'));
          child.emit('close', 0);
        } else if (mode === 'nonzero') child.emit('close', 1);
        else if (mode === 'error') child.emit('error', new Error('private path and secret diagnostic'));
        else if (mode === 'stdin-error') child.stdin.emit('error', new Error('private EPIPE diagnostic'));
      });
    };
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    return child;
  };
  const speech = createLocalSpeech({ enabled: true, spawnImpl, tempRoot, ...options });
  t.after(() => { speech.cancel(); fs.rmSync(tempRoot, { recursive: true, force: true }); });
  return { speech, calls, tempRoot };
}

const waitForCall = async h => {
  for (let i = 0; !h.calls.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(h.calls.length);
};
const safeError = code => error => {
  assert.ok(error instanceof LocalSpeechError);
  assert.equal(error.code, code);
  assert.equal(typeof error.status, 'number');
  assert.doesNotMatch(error.message, /private|secret|EPIPE/);
  return true;
};

test('synthesizes fixed local WAV through stdin without a shell, then removes private files', async t => {
  const h = fixture(t);
  const text = 'A tangent is local. $(touch /tmp/never) --output-file=never';
  assert.deepEqual(await h.speech.synthesize(text), wav());
  const call = h.calls[0];
  assert.equal(call.command, '/usr/bin/say');
  assert.deepEqual(call.args, ['-v', 'Samantha', '-o', call.file, '--file-format=WAVE', '--data-format=LEI16@22050', '--channels=1', '-f', '-']);
  assert.deepEqual(call.spawnOptions, { shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
  assert.equal(call.text, text);
  assert.deepEqual(fs.readdirSync(h.tempRoot), []);
});

test('unsupported, invalid, oversized, and already-aborted requests never spawn', async t => {
  const h = fixture(t);
  for (const text of ['', '   ', null, 3, 'a'.repeat(2601), 'bad\0text']) {
    await assert.rejects(h.speech.synthesize(text), safeError('speech_invalid_text'));
  }
  await assert.rejects(h.speech.synthesize('Valid', { signal: AbortSignal.abort() }), safeError('speech_cancelled'));
  assert.equal(h.calls.length, 0);
  const disabled = createLocalSpeech({ enabled: false, spawnImpl() { assert.fail('must not spawn'); } });
  assert.equal(disabled.available, false);
  await assert.rejects(disabled.synthesize('Valid'), safeError('speech_unavailable'));
});

test('rejects concurrent synthesis and kills an aborted process before allowing another', async t => {
  const h = fixture(t, 'pending'); const abort = new AbortController();
  const first = h.speech.synthesize('First', { signal: abort.signal });
  await waitForCall(h);
  await assert.rejects(h.speech.synthesize('Second'), safeError('speech_busy'));
  abort.abort();
  await assert.rejects(first, safeError('speech_cancelled'));
  assert.deepEqual(h.calls[0].signals, ['SIGKILL']);
  assert.deepEqual(fs.readdirSync(h.tempRoot), []);
  const next = h.speech.synthesize('Next');
  h.speech.cancel();
  await assert.rejects(next, safeError('speech_cancelled'));
});

test('deadline rejects and cleans up even if the process omits close, retaining its one-process lock', async t => {
  const h = fixture(t, 'unclosed', { timeoutMs: 30 });
  const pending = h.speech.synthesize('Deadline');
  await waitForCall(h);
  await assert.rejects(pending, safeError('speech_timeout'));
  assert.deepEqual(h.calls[0].signals, ['SIGKILL']);
  assert.deepEqual(fs.readdirSync(h.tempRoot), []);
  await assert.rejects(h.speech.synthesize('Do not overlap'), safeError('speech_busy'));
  h.calls[0].child.emit('close', null);
  const next = h.speech.synthesize('Allowed after close'); h.speech.cancel();
  await assert.rejects(next, safeError('speech_cancelled'));
});

for (const mode of ['error', 'nonzero', 'stdin-error', 'invalid']) {
  test(`sanitizes ${mode} failure and removes temporary audio`, async t => {
    const h = fixture(t, mode);
    await assert.rejects(h.speech.synthesize('Failure fixture'), safeError(mode === 'invalid' ? 'speech_invalid_audio' : 'speech_failed'));
    assert.deepEqual(fs.readdirSync(h.tempRoot), []);
  });
}

test('synchronous spawn failure is sanitized and releases the job lock', async t => {
  const h = fixture(t, 'success', { spawnImpl() { throw new Error('private executable path'); } });
  await assert.rejects(h.speech.synthesize('First'), safeError('speech_failed'));
  await assert.rejects(h.speech.synthesize('Retry'), safeError('speech_failed'));
  assert.deepEqual(fs.readdirSync(h.tempRoot), []);
});
