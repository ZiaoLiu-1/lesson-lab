import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../studio/server.js';

// Native local HTTP only. Every model response is an explicit injected fake.
function generated({ snapshot }) {
  const facts = snapshot.candidateFacts || snapshot.facts;
  return { unit: {
    title: 'Fixture explanation', text: `The local slope is ${facts.slope}.`, kind: 'grounded',
    sourceIds: [snapshot.sources[0].id], focusId: snapshot.state.selectedId,
    scene: { tangent: true, secant: false, comparison: false },
    note: { targetId: snapshot.state.selectedId, text: 'A test annotation from the fake provider.' },
    claims: [{ key: 'slope', value: facts.slope }], reviewReason: null, functionCode: null,
  }, metadata: { model: 'fake-test-model', providerId: 'fixture-http', usage: { completion_tokens: 12 } } };
}

function request(port, route, { method = 'GET', body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent: false,
      headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* Static responses are deliberately not JSON. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-lab-http-test-'));
  const calls = [];
  const generateImpl = options.generateImpl || (async args => { calls.push(args); return generated(args); });
  const app = createStudioServer({ dataDir, port: 0, generateImpl, keyConfigured: false });
  await app.listen();
  const port = app.server.address().port;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise(resolve => { app.server.once('close', resolve); app.close(); });
  }
  t.after(async () => { await close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { app, port, dataDir, calls, close,
    get: (route, opts) => request(port, route, opts),
    post: (route, body, opts = {}) => request(port, route, { method: 'POST', body, ...opts }),
  };
}

const anchor = (session, extra = {}) => ({ connectionId: session.connectionId,
  revision: session.state.revision, viewEpoch: session.state.viewEpoch,
  pageId: session.state.pageId, selectedId: session.state.selectedId,
  clientTurnId: 'http-client-turn', question: 'Explain the local slope.', ...extra });

function openEvents(port, connectionId) {
  return new Promise((resolve, reject) => {
    const events = [], pending = [];
    const req = http.get({ hostname: '127.0.0.1', port, agent: false,
      path: `/api/events?connectionId=${encodeURIComponent(connectionId)}` }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`SSE status ${res.statusCode}`)); return; }
      let buffer = '';
      const closed = new Promise(done => res.once('close', done));
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!name || !data) continue;
          const event = { name, data: JSON.parse(data) }; events.push(event);
          for (const waiter of [...pending]) {
            if (waiter.name === name && waiter.predicate(event.data)) {
              pending.splice(pending.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(event.data);
            }
          }
        }
      });
      const wait = (name, predicate = () => true) => {
        const found = events.find(event => event.name === name && predicate(event.data));
        if (found) return Promise.resolve(found.data);
        return new Promise((yes, no) => {
          const waiter = { name, predicate, resolve: yes };
          waiter.timer = setTimeout(() => {
            pending.splice(pending.indexOf(waiter), 1); no(new Error(`Timed out waiting for SSE ${name}`));
          }, 3000);
          pending.push(waiter);
        });
      };
      resolve({ events, wait, closed, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

test('HTTP health/static allowlist expose no arbitrary project files and never dispatch inference', async t => {
  const h = await fixture(t);
  const health = await h.get('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, version: '0.6.0', keyConfigured: false, bridgeVersion: '1' });
  assert.match(health.headers['content-security-policy'], /script-src 'self'/);
  for (const route of ['/', '/app.js', '/math.js', '/voice.js', '/style.css']) {
    const response = await h.get(route);
    assert.equal(response.status, 200, route);
    assert.ok(response.text.length > 0);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  for (const route of ['/package.json', '/studio/server.js', '/%2e%2e/package.json', '/.env', '/unlisted.js']) {
    assert.equal((await h.get(route)).status, 404, route);
  }
  const template = await h.get('/api/lesson-template');
  assert.equal(template.status, 200);
  assert.match(template.headers['content-disposition'], /attachment/);
  assert.equal(h.calls.length, 0);
});

test('HTTP Host, Origin, JSON content type, and session authorization reject invalid requests', async t => {
  const h = await fixture(t);
  assert.equal((await h.get('/api/session', { headers: { Host: `localhost:${h.port}` } })).status, 403);
  assert.equal((await h.get('/api/session', { headers: { Origin: 'https://other.example' } })).status, 403);
  const session = (await h.get('/api/session', { headers: { Origin: `http://127.0.0.1:${h.port}` } })).json;
  assert.equal((await h.post('/api/control', { connectionId: session.connectionId, action: 'cancel' }, { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await h.post('/api/control', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  for (const endpoint of ['/api/control', '/api/ask', '/api/ack', '/api/audio', '/api/import', '/api/lesson']) {
    const response = await h.post(endpoint, { connectionId: 'expired' });
    assert.equal(response.status, 409, endpoint);
    assert.equal(response.json.error.code, 'STALE_CONNECTION');
  }
  assert.equal((await h.get('/api/export?connectionId=expired')).status, 409);
  assert.equal((await h.get('/api/events?connectionId=expired')).status, 409);
  assert.equal(h.calls.length, 0);
});

test('HTTP ask streams a real commit and exact ACK persists the displayed answer and export', async t => {
  const h = await fixture(t);
  const session = (await h.get('/api/session')).json;
  const sse = await openEvents(h.port, session.connectionId); t.after(() => sse.close());
  const asked = await h.post('/api/ask', anchor(session, { question: 'Set a to 3 and explain.' }));
  assert.equal(asked.status, 202);
  const commit = await sse.wait('commit', data => data.turnId === asked.json.turnId);
  assert.equal(commit.state.pages[session.state.pageId].a, 3);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].snapshot.facts.a, 1);
  assert.equal(h.calls[0].snapshot.candidateFacts.a, 3);
  const ackInput = { connectionId: session.connectionId, turnId: asked.json.turnId,
    revision: commit.revision, clientTurnId: 'http-client-turn', renderedMs: 19.25 };
  const wrong = await h.post('/api/ack', { ...ackInput, clientTurnId: 'wrong' });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.error.code, 'WRONG_CLIENT_TURN');
  const ack = await h.post('/api/ack', ackInput);
  assert.equal(ack.status, 200);
  assert.equal(ack.json.metrics.renderedMs, 19.25);
  assert.equal(ack.json.unit.text, 'The local slope is 6.');
  assert.equal((await h.post('/api/ack', ackInput)).status, 409);
  const exported = await h.get(`/api/export?connectionId=${session.connectionId}`);
  assert.equal(exported.status, 200);
  assert.equal(exported.json.format, 'lesson-lab-session');
  assert.equal(exported.json.state.pages[session.state.pageId].notes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'session.json'))).state.pages[session.state.pageId].a, 3);
  const recorded = fs.readFileSync(path.join(h.dataDir, 'turns.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, 'completed');
  assert.equal(recorded[0].metrics.metadata.model, 'fake-test-model');
});

test('a replacement HTTP session closes old SSE, aborts generation, and rejects stale exports/ACKs', async t => {
  let resolve, called;
  const pending = new Promise(yes => { resolve = yes; });
  const h = await fixture(t, { generateImpl: args => { called = args; return pending; } });
  const first = (await h.get('/api/session')).json;
  const sse = await openEvents(h.port, first.connectionId); t.after(() => sse.close());
  const ask = await h.post('/api/ask', anchor(first));
  assert.equal(ask.status, 202);
  const second = (await h.get('/api/session')).json;
  await sse.wait('replaced'); await sse.closed;
  assert.notEqual(first.connectionId, second.connectionId);
  assert.equal(called.signal.aborted, true);
  resolve(generated(called));
  await new Promise(done => setImmediate(done));
  assert.equal(h.app.core.snapshot().conversation.filter(item => item.role === 'assistant').length, 0);
  assert.equal((await h.get(`/api/export?connectionId=${first.connectionId}`)).status, 409);
  assert.equal((await h.post('/api/ack', { connectionId: first.connectionId, turnId: ask.json.turnId })).status, 409);
  assert.equal((await h.get(`/api/export?connectionId=${second.connectionId}`)).status, 200);
});

test('provider failures cross SSE as a safe error without applying content or leaking raw details', async t => {
  const h = await fixture(t, { generateImpl: async () => {
    throw Object.assign(new Error('FAKE_PRIVATE_PROVIDER_DETAIL'), { metadata: { apiKey: 'FAKE_PRIVATE_METADATA' } });
  } });
  const session = (await h.get('/api/session')).json;
  const sse = await openEvents(h.port, session.connectionId); t.after(() => sse.close());
  const ask = await h.post('/api/ask', anchor(session));
  assert.equal(ask.status, 202);
  const failure = await sse.wait('failure', value => value.turnId === ask.json.turnId);
  assert.equal(failure.code, 'GENERATION_FAILED');
  assert.equal(JSON.stringify(failure).includes('FAKE_PRIVATE'), false);
  assert.equal(h.app.core.snapshot().pages[session.state.pageId].notes.length, 0);
  assert.equal(h.app.core.snapshot().conversation.filter(item => item.role === 'assistant').length, 0);
  assert.equal(fs.readFileSync(path.join(h.dataDir, 'turns.jsonl'), 'utf8').includes('FAKE_PRIVATE'), false);
});

test('invalid session/lesson uploads leave current state, connection, save, and active request intact', async t => {
  let resolve, called;
  const h = await fixture(t, { generateImpl: args => { called = args; return new Promise(yes => { resolve = yes; }); } });
  const session = (await h.get('/api/session')).json;
  const sse = await openEvents(h.port, session.connectionId); t.after(() => sse.close());
  const ask = await h.post('/api/ask', anchor(session));
  const before = h.app.core.snapshot();
  const saved = fs.readFileSync(path.join(h.dataDir, 'session.json'), 'utf8');
  const payload = (await h.get(`/api/export?connectionId=${session.connectionId}`)).json;
  payload.state.pages[before.pageId].a = 99;
  const badSession = await h.post('/api/import', { connectionId: session.connectionId, payload });
  assert.equal(badSession.status, 400);
  const badLesson = structuredClone(session.lesson); badLesson.pages[0].steps[0].targetId = 'unknown-block';
  assert.equal((await h.post('/api/lesson', { connectionId: session.connectionId, lesson: badLesson })).status, 400);
  assert.deepEqual(h.app.core.snapshot(), before);
  assert.equal(h.app.core.connectionId, session.connectionId);
  assert.equal(called.signal.aborted, false);
  assert.equal(fs.readFileSync(path.join(h.dataDir, 'session.json'), 'utf8'), saved);
  resolve(generated(called));
  const commit = await sse.wait('commit', value => value.turnId === ask.json.turnId);
  assert.equal((await h.post('/api/ack', { connectionId: session.connectionId, turnId: ask.json.turnId, revision: commit.revision, clientTurnId: 'http-client-turn', renderedMs: null })).status, 200);
});

test('valid session import restores values, rotates connection, and invalidates previous anchors', async t => {
  const h = await fixture(t);
  const session = (await h.get('/api/session')).json;
  const original = (await h.get(`/api/export?connectionId=${session.connectionId}`)).json;
  await h.post('/api/control', { connectionId: session.connectionId, action: 'parameter', a: 4 });
  const sse = await openEvents(h.port, session.connectionId); t.after(() => sse.close());
  const restored = await h.post('/api/import', { connectionId: session.connectionId, payload: original });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.state.pages[original.state.pageId].a, 1);
  assert.ok(restored.json.state.revision > original.state.revision);
  assert.notEqual(restored.json.connectionId, session.connectionId);
  await sse.wait('replaced');
  assert.equal((await h.post('/api/ask', anchor(session))).status, 409);
  assert.equal((await h.get(`/api/export?connectionId=${restored.json.connectionId}`)).status, 200);
});

test('legacy saved lesson and exported session upgrade the bound without resetting notes or teaching progress', async t => {
  const h = await fixture(t); const session = (await h.get('/api/session')).json;
  const sse = await openEvents(h.port, session.connectionId); t.after(() => sse.close());
  await h.post('/api/control', { connectionId: session.connectionId, action: 'page', pageId: 'p2' });
  await h.post('/api/control', { connectionId: session.connectionId, action: 'next' });
  await h.post('/api/control', { connectionId: session.connectionId, action: 'parameter', a: 5 });
  const current = { ...session, state: h.app.core.snapshot() };
  const asked = await h.post('/api/ask', anchor(current));
  const commit = await sse.wait('commit', data => data.turnId === asked.json.turnId);
  await h.post('/api/ack', { connectionId: session.connectionId, turnId: asked.json.turnId,
    revision: commit.revision, clientTurnId: 'http-client-turn', renderedMs: 10 });
  const noteId = h.app.core.snapshot().pages.p2.notes[0].id;
  await h.post('/api/control', { connectionId: session.connectionId, action: 'review_note', noteId });
  await h.post('/api/control', { connectionId: session.connectionId, action: 'select', selectedId: noteId });
  const legacy = (await h.get(`/api/export?connectionId=${session.connectionId}`)).json;
  legacy.lesson.example.maxA = 5;
  await h.close();
  fs.writeFileSync(path.join(h.dataDir, 'session.json'), JSON.stringify({ lesson: legacy.lesson, state: legacy.state }));
  const reopened = createStudioServer({ dataDir: h.dataDir, port: 0, keyConfigured: false,
    generateImpl: async () => { throw new Error('A migration must never call inference'); } });
  await reopened.listen(); const port = reopened.server.address().port;
  try {
    assert.deepEqual(reopened.core.snapshot(), legacy.state);
    assert.equal(reopened.core.lesson.example.maxA, 10);
    const loaded = (await request(port, '/api/session')).json;
    assert.equal(loaded.config.startupNotice, null); assert.equal(loaded.lesson.version, '1.0.0');
    assert.equal(loaded.config.version, '0.6.0');
    const restored = await request(port, '/api/import', { method: 'POST', body: { connectionId: loaded.connectionId, payload: legacy } });
    assert.equal(restored.status, 200);
    const state = restored.json.state;
    assert.deepEqual({ ...state, revision: legacy.state.revision, viewEpoch: legacy.state.viewEpoch, delivery: legacy.state.delivery }, legacy.state);
    assert.equal(restored.json.lesson.example.maxA, 10); assert.equal(state.selectedId, noteId);
    assert.equal(state.pages.p2.notes[0].kind, 'needs_review');
    const connectionId = restored.json.connectionId;
    const continued = await request(port, '/api/control', { method: 'POST', body: { connectionId, action: 'continue' } });
    assert.equal(continued.json.step.id, 'p2.s2'); assert.deepEqual(continued.json.state.cursor, legacy.state.resumePoint);
    const changed = await request(port, '/api/control', { method: 'POST', body: { connectionId, action: 'parameter', a: 10 } });
    assert.equal(changed.status, 200); assert.equal(changed.json.state.pages.p2.a, 10);
    const saved = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'session.json'), 'utf8'));
    assert.equal(saved.lesson.example.maxA, 10); assert.equal(saved.state.pages.p2.a, 10);
    assert.deepEqual(saved.state.pages.p2.notes, legacy.state.pages.p2.notes);
    assert.deepEqual(saved.state.conversation, legacy.state.conversation);
    assert.equal(fs.readdirSync(h.dataDir).some(name => /session-(?:invalid|unreadable|archive)/.test(name)), false);
  } finally { await new Promise(done => { reopened.server.once('close', done); reopened.close(); }); }
});

test('a valid session larger than 256 KB survives export and re-import within the state budget', async t => {
  const h = await fixture(t);
  const session = (await h.get('/api/session')).json;
  const payload = (await h.get(`/api/export?connectionId=${session.connectionId}`)).json;
  // Synthetic history is a size-boundary fixture, not recorded model output or learner evidence.
  payload.state.conversation = Array.from({ length: 100 }, (_, index) => ({
    id: `size-fixture-${index}`, role: index % 2 ? 'assistant' : 'user',
    text: 'Synthetic conversation text for the import size boundary. '.repeat(55),
    pageId: payload.state.pageId, turnId: `size-turn-${index}`, at: '2026-09-18T12:00:00.000Z',
  }));
  const bytes = Buffer.byteLength(JSON.stringify({ connectionId: session.connectionId, payload }));
  assert.ok(bytes > 256000 && bytes < 2000000, `Fixture is ${bytes} bytes`);
  const imported = await h.post('/api/import', { connectionId: session.connectionId, payload });
  assert.equal(imported.status, 200);
  const exported = await h.get(`/api/export?connectionId=${imported.json.connectionId}`);
  assert.equal(exported.status, 200);
  assert.ok(Buffer.byteLength(exported.text) > 256000);
  assert.deepEqual(exported.json.state.conversation, payload.state.conversation);
  const restored = await h.post('/api/import', { connectionId: imported.json.connectionId, payload: exported.json });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.json.state.conversation, payload.state.conversation);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'session.json'))).state.conversation, payload.state.conversation);
  assert.equal(h.calls.length, 0);
});

test('validated lesson replacement archives the prior lesson and survives a server restart', async t => {
  const h = await fixture(t);
  const session = (await h.get('/api/session')).json;
  await h.post('/api/control', { connectionId: session.connectionId, action: 'parameter', a: 2.5 });
  const lesson = structuredClone(session.lesson); lesson.id = 'http-test-course'; lesson.title = 'An original HTTP test course';
  lesson.example.initialA = 3;
  const replaced = await h.post('/api/lesson', { connectionId: session.connectionId, lesson });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.json.lesson.id, lesson.id);
  assert.equal(replaced.json.state.pages[replaced.json.state.pageId].a, 3);
  assert.equal((await h.get('/api/lesson-template')).json.id, lesson.id);
  const archives = fs.readdirSync(h.dataDir).filter(name => name.startsWith('session-archive-'));
  assert.equal(archives.length, 1);
  const archived = JSON.parse(fs.readFileSync(path.join(h.dataDir, archives[0])));
  assert.equal(archived.lesson.id, session.lesson.id);
  assert.equal(archived.state.pages[session.state.pageId].a, 2.5);
  await h.post('/api/control', { connectionId: replaced.json.connectionId, action: 'model', model: 'gptoss' });
  await h.close();
  const reopened = createStudioServer({ dataDir: h.dataDir, port: 0, keyConfigured: false,
    generateImpl: async () => { throw new Error('No provider call is expected on restart'); } });
  await reopened.listen();
  try {
    const loaded = (await request(reopened.server.address().port, '/api/session')).json;
    assert.equal(loaded.lesson.id, lesson.id);
    assert.equal(loaded.state.model, 'gptoss');
    assert.equal(loaded.state.pages[loaded.state.pageId].a, 3);
    assert.equal(loaded.config.startupNotice, null);
    assert.notEqual(loaded.connectionId, replaced.json.connectionId);
  } finally { await new Promise(done => { reopened.server.once('close', done); reopened.close(); }); }
});

test('HTTP malformed and oversized bodies return a bounded JSON error without changing state', async t => {
  const h = await fixture(t);
  const session = (await h.get('/api/session')).json;
  const before = h.app.core.snapshot();
  assert.equal((await request(h.port, '/api/control', { method: 'POST', raw: '{broken' })).status, 400);
  const oversized = await h.post('/api/control', { connectionId: session.connectionId, action: 'cancel', padding: 'x'.repeat(257000) });
  assert.equal(oversized.status, 400);
  assert.match(oversized.json.error.message, /too large|below 256/i);
  assert.deepEqual(h.app.core.snapshot(), before);
  assert.equal((await h.get('/api/health')).status, 200);
});

test('an invalid saved state is backed up and recovery is disclosed without any provider request', async t => {
  const h = await fixture(t);
  const session = (await h.get('/api/session')).json;
  await h.close();
  const savedPath = path.join(h.dataDir, 'session.json');
  const saved = JSON.parse(fs.readFileSync(savedPath));
  saved.state.pages[session.state.pageId].a = 42;
  const invalid = JSON.stringify(saved);
  fs.writeFileSync(savedPath, invalid);
  const reopened = createStudioServer({ dataDir: h.dataDir, port: 0, keyConfigured: false,
    generateImpl: async () => { throw new Error('Recovery must not call a provider'); } });
  await reopened.listen();
  try {
    const loaded = (await request(reopened.server.address().port, '/api/session')).json;
    assert.equal(loaded.state.pages[loaded.state.pageId].a, session.lesson.example.initialA);
    assert.match(loaded.config.startupNotice, /backup|fresh/i);
    const backups = fs.readdirSync(h.dataDir).filter(name => name.startsWith('session-invalid-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(h.dataDir, backups[0]), 'utf8'), invalid);
    assert.equal(h.calls.length, 0);
  } finally { await new Promise(done => { reopened.server.once('close', done); reopened.close(); }); }
});

for (const [operation, busy] of [['import', false], ['lesson', false], ['import', true], ['lesson', true]]) {
  test(`failed ${operation} persistence rolls back state and disk${busy ? ' with an active request' : ''}`, async t => {
    let resolve, called;
    const pending = new Promise(yes => { resolve = yes; });
    const h = await fixture(t, { generateImpl: args => { called = args; return pending; } });
    const session = (await h.get('/api/session')).json;
    const sse = await openEvents(h.port, session.connectionId); t.after(() => sse.close());
    const ask = busy ? await h.post('/api/ask', anchor(session)) : null;
    const before = h.app.core.snapshot();
    const savedPath = path.join(h.dataDir, 'session.json');
    const saved = fs.readFileSync(savedPath, 'utf8');
    const payload = (await h.get(`/api/export?connectionId=${session.connectionId}`)).json;
    payload.state.pages[session.state.pageId].a = 4;
    payload.state.pages[session.state.pageId].functionCode = '4*x**2';
    const lesson = structuredClone(session.lesson); lesson.id = 'replacement-that-cannot-save';
    fs.mkdirSync(savedPath + '.tmp'); // Deliberately force only the temporary fixture's atomic write to fail.
    let response;
    try {
      response = await h.post(`/api/${operation}`, { connectionId: session.connectionId, ...(operation === 'import' ? { payload } : { lesson }) });
    } finally { fs.rmSync(savedPath + '.tmp', { recursive: true, force: true }); }
    assert.equal(response.status, 500);
    assert.equal(response.json.error.code, 'internal_error');
    assert.equal(fs.readFileSync(savedPath, 'utf8'), saved);
    assert.deepEqual(h.app.core.snapshot(), before);
    assert.equal(h.app.core.connectionId, session.connectionId);
    assert.equal((await h.get(`/api/export?connectionId=${session.connectionId}`)).status, 200);
    if (busy) {
      assert.equal(called.signal.aborted, false, 'A rejected save must not cancel the existing request');
      assert.equal(h.app.core.active.id, ask.json.turnId);
      resolve(generated(called));
      const commit = await sse.wait('commit', value => value.turnId === ask.json.turnId);
      assert.equal((await h.post('/api/ack', { connectionId: session.connectionId, turnId: ask.json.turnId,
        revision: commit.revision, clientTurnId: 'http-client-turn', renderedMs: null })).status, 200);
    }
  });
}
