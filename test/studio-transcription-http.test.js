import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createStudioServer } from '../studio/server.js';
import { LocalTranscriptionError } from '../studio/transcription.js';

function wav(seconds = 0.5) {
  const size = Math.round(seconds * 16000) * 2, bytes = Buffer.alloc(44 + size);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(size, 40); return bytes;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const anchor = (app, session) => { const state = app.core.snapshot(); return { connectionId: session.connectionId,
  revision: state.revision, viewEpoch: state.viewEpoch, pageId: state.pageId, selectedId: state.selectedId }; };
async function fixture(t, { transcribe, available = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-http-')), calls = []; let inferenceCalls = 0;
  const transcriptionImpl = { available, engine: 'localWhisper', async transcribe(bytes, options) {
    calls.push({ bytes, ...options }); return transcribe ? transcribe(bytes, options) : { text: 'Explain this point.', metrics: { transcriptionMs: 31 } };
  } };
  const app = createStudioServer({ dataDir, port: 0, keyConfigured: false, transcriptionImpl, speechImpl: { available: false },
    generateImpl: async () => { inferenceCalls++; throw new Error('Transcription must not call a teaching provider'); } });
  await app.listen(); const port = app.server.address().port, url = `http://127.0.0.1:${port}`;
  t.after(async () => { await new Promise(done => { app.server.once('close', done); app.close(); }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const session = await (await fetch(url + '/api/session')).json();
  const post = (route, body, options = {}) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
  return { app, session, dataDir, url, port, post, calls, inferenceCalls: () => inferenceCalls,
    input: (seconds = 0.5) => ({ anchor: anchor(app, session), audioBase64: wav(seconds).toString('base64') }) };
}

test('HTTP local transcription returns the exact anchor and only transcript/timing without lesson changes or inference', async t => {
  const h = await fixture(t);
  assert.equal(h.session.config.localTranscription, true);
  assert.deepEqual(h.session.config.transcriber, { available: true, engine: 'localWhisper' });
  const before = h.app.core.snapshot(), saved = fs.readFileSync(path.join(h.dataDir, 'session.json'), 'utf8'), input = h.input();
  const response = await h.post('/api/transcribe', input); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'Explain this point.', metrics: { transcriptionMs: 31 }, anchor: input.anchor });
  assert.deepEqual(h.calls[0].bytes, wav()); assert.deepEqual(h.app.core.snapshot(), before);
  assert.equal(fs.readFileSync(path.join(h.dataDir, 'session.json'), 'utf8'), saved);
  assert.equal(fs.existsSync(path.join(h.dataDir, 'turns.jsonl')), false);
  assert.equal(h.inferenceCalls(), 0);
});

test('HTTP config discloses missing local transcription and errors remain sanitized', async t => {
  const h = await fixture(t, { available: false, transcribe: async () => { throw new LocalTranscriptionError('transcription_unavailable'); } });
  assert.equal(h.session.config.localTranscription, false); assert.equal(h.session.config.transcriber.available, false);
  const response = await h.post('/api/transcribe', h.input()); assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'transcription_unavailable');
  const broken = await fixture(t, { transcribe: async () => { throw new Error('PRIVATE_PATH csk-secret raw diagnostic'); } });
  const bad = await broken.post('/api/transcribe', broken.input()); assert.equal(bad.status, 503);
  assert.equal((await bad.json()).error.code, 'transcription_failed');
});

test('HTTP validates current reader and immutable five-field anchor before invoking recognition', async t => {
  const h = await fixture(t), input = h.input();
  for (const edit of [i => i.anchor.connectionId = 'old-reader', i => i.anchor.revision++, i => i.anchor.viewEpoch++,
    i => i.anchor.pageId = 'p2', i => i.anchor.selectedId = 'p1.derivative', i => i.anchor.extra = true,
    i => i.executable = '/not-a-request-option', i => i.audioBase64 = 'invalid']) {
    const changed = structuredClone(input); edit(changed);
    const response = await h.post('/api/transcribe', changed); assert.ok([400, 409].includes(response.status));
  }
  assert.equal(h.calls.length, 0); assert.deepEqual(h.app.core.snapshot(), h.session.state);
});

test('HTTP accepts a full 20-second utterance below 1 MB and rejects excessive duration or transport size', async t => {
  const h = await fixture(t);
  const input = h.input(20); assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1000000);
  assert.equal((await h.post('/api/transcribe', input)).status, 200);
  assert.equal(h.calls[0].bytes.length, 640044);
  assert.equal((await h.post('/api/transcribe', h.input(20.01))).status, 400);
  const oversized = await h.post('/api/transcribe', { anchor: input.anchor, audioBase64: 'A'.repeat(1000001) });
  assert.equal(oversized.status, 400); assert.match((await oversized.json()).error.message, /1000 KB/);
  assert.equal(h.calls.length, 1);
});

test('page changes abort recognition immediately and reject a late transcript even if the adapter ignores cancellation', async t => {
  const entered = deferred(), finished = deferred();
  const h = await fixture(t, { transcribe: () => { entered.resolve(); return finished.promise; } });
  const pending = h.post('/api/transcribe', h.input()); await entered.promise;
  const changed = await h.post('/api/control', { connectionId: h.session.connectionId, action: 'page', pageId: 'p2' });
  assert.equal(changed.status, 200); assert.equal(h.calls[0].signal.aborted, true);
  finished.resolve({ text: 'This belongs to the old page.', metrics: { transcriptionMs: 20 } });
  const response = await pending; assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'STALE_TRANSCRIPTION'); assert.equal(h.inferenceCalls(), 0);
});

test('invalid page changes leave transcription running, while a new session invalidates its old connection', async t => {
  const entered = deferred(), finished = deferred();
  const h = await fixture(t, { transcribe: () => { entered.resolve(); return finished.promise; } });
  const pending = h.post('/api/transcribe', h.input()); await entered.promise;
  assert.equal((await h.post('/api/control', { connectionId: h.session.connectionId, action: 'parameter', a: 11 })).status, 400);
  assert.equal(h.calls[0].signal.aborted, false);
  const next = await (await fetch(h.url + '/api/session')).json(); assert.notEqual(next.connectionId, h.session.connectionId);
  assert.equal(h.calls[0].signal.aborted, true);
  finished.resolve({ text: 'Old reader.', metrics: { transcriptionMs: 20 } });
  assert.equal((await (await pending).json()).error.code, 'STALE_TRANSCRIPTION');
});

test('aborting the HTTP request cancels its local transcription process without mutating lesson state', async t => {
  const entered = deferred(), aborted = deferred();
  const h = await fixture(t, { transcribe: (bytes, { signal }) => new Promise((resolve, reject) => {
    entered.resolve(); signal.addEventListener('abort', () => { aborted.resolve(); reject(new LocalTranscriptionError('transcription_cancelled')); }, { once: true });
  }) });
  const controller = new AbortController(), before = h.app.core.snapshot();
  const request = h.post('/api/transcribe', h.input(), { signal: controller.signal });
  const rejected = assert.rejects(request, error => error.name === 'AbortError');
  await entered.promise; controller.abort(); await rejected; await aborted.promise;
  assert.deepEqual(h.app.core.snapshot(), before); assert.equal(h.inferenceCalls(), 0);
});

test('losing the final SSE reader cancels recognition even while its HTTP response remains connected', async t => {
  const entered = deferred(), finished = deferred();
  const h = await fixture(t, { transcribe: () => { entered.resolve(); return finished.promise; } });
  const peer = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: h.port, path: `/api/events?connectionId=${h.session.connectionId}` }, res => { res.resume(); resolve(req); });
    req.on('error', reject);
  });
  t.after(() => peer.destroy());
  const pending = h.post('/api/transcribe', h.input()); await entered.promise; peer.destroy();
  for (let i = 0; !h.calls[0].signal.aborted && i < 100; i++) await new Promise(done => setTimeout(done, 1));
  assert.equal(h.calls[0].signal.aborted, true);
  finished.resolve({ text: 'No visible reader.', metrics: { transcriptionMs: 20 } });
  const response = await pending; assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'transcription_cancelled');
});

test('malformed transcription output is rejected and its private metadata cannot enter a successful response', async t => {
  for (const result of [{ text: 'x'.repeat(2001), metrics: { transcriptionMs: 1 } }, { text: 'bad\0text', metrics: { transcriptionMs: 1 } },
    { text: 'Hello.', metrics: { transcriptionMs: -1 } }, { text: 'Hello.' }]) {
    const h = await fixture(t, { transcribe: async () => result });
    const response = await h.post('/api/transcribe', h.input()); assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'transcription_invalid_output');
  }
  const h = await fixture(t, { transcribe: async () => ({ text: '', metrics: { transcriptionMs: 0, private: 'PRIVATE' }, raw: 'PRIVATE' }) });
  const response = await h.post('/api/transcribe', h.input()); assert.equal(response.status, 200);
  assert.equal((await response.json()).text, ''); assert.equal(h.inferenceCalls(), 0);
});
