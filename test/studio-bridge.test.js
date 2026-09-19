import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../studio/server.js';

// Only loopback HTTP and injected fake generation: no inference or paid calls.
const generated = ({ snapshot }) => ({ unit: {
  title: 'Accepted fixture', text: 'The slope is twice the current coefficient.', kind: 'grounded',
  sourceIds: [snapshot.sources[0].id], focusId: snapshot.state.selectedId,
  scene: { tangent: true, secant: false, comparison: false }, note: null,
  claims: [{ key: 'slope', value: snapshot.facts.slope }], reviewReason: null, functionCode: null,
}, metadata: { model: 'fixture', usage: { completion_tokens: 20 } } });

function request(port, route, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent: false,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(payload);
  });
}
function events(port, connectionId) {
  return new Promise((resolve, reject) => {
    const all = [], waits = [];
    const req = http.get({ hostname: '127.0.0.1', port, agent: false, path: `/api/events?connectionId=${connectionId}` }, res => {
      let buffer = ''; res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk; let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!name || !data) continue;
          const entry = { name, data: JSON.parse(data) }; all.push(entry);
          for (const wait of [...waits]) if (wait.name === name) {
            waits.splice(waits.indexOf(wait), 1); clearTimeout(wait.timer); wait.resolve(entry.data);
          }
        }
      });
      resolve({ close: () => req.destroy(), wait: name => {
        const found = all.find(entry => entry.name === name); if (found) return Promise.resolve(found.data);
        return new Promise((yes, no) => { const wait = { name, resolve: yes };
          wait.timer = setTimeout(() => no(new Error(`Missing SSE ${name}`)), 1500); waits.push(wait); });
      } });
    }); req.on('error', reject);
  });
}
async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bridge-test-'));
  const app = createStudioServer({ dataDir, port: 0, keyConfigured: false,
    generateImpl: async args => generated(args), speechImpl: { available: false }, ...options });
  await app.listen(); const port = app.server.address().port;
  const token = fs.readFileSync(path.join(dataDir, 'bridge.token'), 'utf8').trim();
  const peers = []; let closed = false;
  t.after(async () => { peers.forEach(peer => peer.close()); if (!closed) await new Promise(done => { app.server.once('close', done); app.close(); });
    fs.rmSync(dataDir, { recursive: true, force: true }); });
  const h = { app, dataDir, token,
    get: (route, auth = true) => request(port, route, { token: auth ? token : undefined }),
    post: (route, body, auth = false) => request(port, route, { method: 'POST', body, token: auth ? token : undefined }),
    async reader() {
      const session = (await h.get('/api/session', false)).body;
      const peer = await events(port, session.connectionId); peers.push(peer); return { session, peer };
    },
    async close() { if (!closed) { await new Promise(done => { app.server.once('close', done); app.close(); }); closed = true; } },
  };
  return h;
}
async function command(h, body = { kind: 'ask', question: 'Explain the current slope.' }) {
  const submitted = await h.post('/api/bridge/command', body, true); assert.equal(submitted.status, 202);
  const job = submitted.body;
  const claimed = await h.post('/api/bridge/claim', { id: job.id, connectionId: job.anchor.connectionId });
  assert.equal(claimed.status, 200); return claimed.body;
}
const askInput = claim => ({ ...claim.anchor, bridgeId: claim.id, clientTurnId: claim.clientTurnId, question: claim.command.question });
const resultInput = (claim, state) => ({ id: claim.id, connectionId: claim.anchor.connectionId,
  status: 'completed', visible: true, revision: state.revision, viewEpoch: state.viewEpoch });

test('bridge requires a private persistent token and context reads never rotate the reader', async t => {
  const h = await fixture(t);
  assert.equal(fs.statSync(path.join(h.dataDir, 'bridge.token')).mode & 0o777, 0o600);
  for (const route of ['/api/bridge/context', '/api/bridge/jobs/unknown']) assert.equal((await h.get(route, false)).status, 401);
  for (const route of ['/api/bridge/command', '/api/bridge/cancel']) assert.equal((await h.post(route, {})).status, 401);
  const initial = (await h.get('/api/bridge/context')).body;
  assert.equal(initial.connected, false); assert.equal(initial.anchor.connectionId, null);
  assert.equal(h.app.core.state.revision, 0);
  const { session } = await h.reader(); const before = h.app.core.snapshot();
  for (let index = 0; index < 3; index++) {
    const context = (await h.get('/api/bridge/context')).body;
    assert.equal(context.connected, true); assert.equal(context.anchor.connectionId, session.connectionId);
    assert.deepEqual(context.state, before); assert.ok(context.selectedBlock.id); assert.ok(context.facts.slope);
    assert.equal(JSON.stringify(context).includes(h.token), false);
  }
  assert.equal(JSON.stringify(session).includes(h.token), false);
  assert.equal(JSON.stringify(h.app.core.exportSession()).includes(h.token), false);
  await h.close();
  const reopened = createStudioServer({ dataDir: h.dataDir, port: 0, generateImpl: async args => generated(args), speechImpl: { available: false } });
  assert.equal(fs.readFileSync(path.join(h.dataDir, 'bridge.token'), 'utf8').trim(), h.token);
  reopened.close();
});

test('commands need a current SSE peer, exact expected fields, allowed payloads and one outstanding job', async t => {
  const h = await fixture(t);
  assert.equal((await h.post('/api/bridge/command', { kind: 'ask', question: 'Help.' }, true)).body.error.code, 'BRIDGE_NO_READER');
  const { session, peer } = await h.reader();
  const stale = await h.post('/api/bridge/command', { kind: 'ask', question: 'Help.', expected: { revision: 99 } }, true);
  assert.equal(stale.body.error.code, 'BRIDGE_STALE_VIEW');
  for (const body of [{ kind: 'control', action: 'model', payload: { model: 'gptoss' } },
    { kind: 'control', action: 'parameter', payload: { a: 2, selectedId: 'injected' } },
    { kind: 'ask', question: 'Help.', expected: { unauthorized: 1 } }]) {
    assert.equal((await h.post('/api/bridge/command', body, true)).status, 400);
  }
  const submitted = await h.post('/api/bridge/command', { kind: 'ask', question: 'Help.', expected: { connectionId: session.connectionId } }, true);
  assert.equal(submitted.status, 202);
  assert.deepEqual(await peer.wait('bridge_command'), { id: submitted.body.id });
  assert.equal((await h.post('/api/bridge/command', { kind: 'ask', question: 'Again.' }, true)).body.error.code, 'BRIDGE_BUSY');
  assert.equal(h.app.core.active, null);
});

test('claim is one-shot and stale page/connection changes prevent its execution', async t => {
  const h = await fixture(t); const { session } = await h.reader();
  const first = await command(h);
  assert.equal(first.clientTurnId, `bridge-${first.id}`);
  assert.equal((await h.post('/api/bridge/claim', { id: first.id, connectionId: session.connectionId })).status, 409);
  const target = session.lesson.pages[1].id;
  await h.post('/api/control', { connectionId: session.connectionId, action: 'page', pageId: target });
  const failed = (await h.get(`/api/bridge/jobs/${first.id}`)).body;
  assert.equal(failed.status, 'failed'); assert.equal(failed.result, undefined);
  assert.equal((await h.post('/api/ask', askInput(first))).status, 409);
  const next = await h.post('/api/bridge/command', { kind: 'control', action: 'start' }, true);
  await h.get('/api/session', false);
  assert.equal((await h.post('/api/bridge/claim', { id: next.body.id, connectionId: session.connectionId })).status, 409);
  assert.equal((await h.get(`/api/bridge/jobs/${next.body.id}`)).body.status, 'failed');
});

test('browser completion cannot bypass correlated execution or the real core display ACK', async t => {
  const h = await fixture(t); const { session, peer } = await h.reader(); const claim = await command(h);
  const fabricated = await h.post('/api/bridge/result', { ...resultInput(claim, session.state), unit: { text: 'Invented.' } });
  assert.equal(fabricated.body.error.code, 'BRIDGE_UNCONFIRMED_VIEW');
  assert.equal((await h.post('/api/ask', { ...askInput(claim), question: 'A substituted question.' })).status, 409);
  assert.equal(h.app.core.active, null);
  const asked = await h.post('/api/ask', askInput(claim)); assert.equal(asked.status, 202);
  const commit = await peer.wait('commit');
  const withoutAck = await h.post('/api/bridge/result', resultInput(claim, commit.state));
  assert.equal(withoutAck.body.error.code, 'BRIDGE_ACK_REQUIRED');
  const ack = await h.post('/api/ack', { connectionId: session.connectionId, turnId: asked.body.turnId,
    revision: commit.revision, clientTurnId: claim.clientTurnId, renderedMs: 22 });
  assert.equal(ack.status, 200);
  assert.equal((await h.post('/api/bridge/result', { ...resultInput(claim, commit.state), visible: false })).status, 409);
  const completed = await h.post('/api/bridge/result', { ...resultInput(claim, commit.state), unit: { text: 'Still invented.' } });
  assert.equal(completed.status, 200); assert.equal(completed.body.status, 'completed');
  assert.deepEqual(completed.body.result.unit, ack.body.unit);
  assert.equal(completed.body.result.metrics.renderedMs, 22);
  assert.equal(completed.body.result.metrics.timeline.some(event => event.event.startsWith('audio_')), false);
  assert.deepEqual((await h.get(`/api/bridge/jobs/${claim.id}`)).body.result, completed.body.result);
  await h.post('/api/control', { connectionId: session.connectionId, action: 'select', selectedId: session.state.selectedId });
  const stale = (await h.get(`/api/bridge/jobs/${claim.id}`)).body;
  assert.equal(stale.status, 'failed'); assert.equal(stale.result, undefined);
});

test('prepared controls return canonical interpolated text only after exact execution and visible confirmation', async t => {
  const h = await fixture(t); const { session } = await h.reader();
  await h.post('/api/control', { connectionId: session.connectionId, action: 'parameter', a: 3 });
  const claim = await command(h, { kind: 'control', action: 'start' });
  const response = await h.post('/api/control', { connectionId: session.connectionId, bridgeId: claim.id, action: 'start' });
  assert.equal(response.status, 200);
  const stale = await h.post('/api/bridge/result', resultInput(claim, session.state)); assert.equal(stale.status, 409);
  const done = await h.post('/api/bridge/result', resultInput(claim, response.body.state));
  assert.equal(done.body.status, 'completed'); assert.deepEqual(done.body.result.step, response.body.step);
  assert.equal(done.body.result.step.text.includes('{a}'), false);
  assert.deepEqual(done.body.result.focusIds, [response.body.step.targetId]);
  assert.equal(h.app.core.audioAnchor.phase, 'ready'); assert.equal(h.app.core.state.cursor.delivered, false);
  assert.equal(done.body.result.metrics, undefined);
});

test('actual non-speaking control results are checked; coincident state never manufactures prepared speech', async t => {
  const h = await fixture(t); const { session } = await h.reader();
  const claim = await command(h, { kind: 'control', action: 'parameter', payload: { a: 2 } });
  assert.equal((await h.post('/api/control', { connectionId: session.connectionId, bridgeId: claim.id, action: 'parameter', a: 4 })).status, 409);
  assert.equal(h.app.core.state.pages[session.state.pageId].a, 1);
  const applied = await h.post('/api/control', { connectionId: session.connectionId, bridgeId: claim.id, action: 'parameter', a: 2 });
  const done = (await h.post('/api/bridge/result', resultInput(claim, applied.body.state))).body;
  assert.equal(done.status, 'completed'); assert.equal(done.result.step, undefined); assert.equal(done.result.unit, undefined);
  assert.equal(h.app.core.state.pages[session.state.pageId].a, 2);
});

test('bridge parameter accepts the expanded upper boundary and rejects values above it without applying changes', async t => {
  const h = await fixture(t); const { session } = await h.reader();
  const claim = await command(h, { kind: 'control', action: 'parameter', payload: { a: 10 } });
  const applied = await h.post('/api/control', { connectionId: session.connectionId, bridgeId: claim.id, action: 'parameter', a: 10 });
  assert.equal(applied.status, 200);
  assert.equal((await h.post('/api/bridge/result', resultInput(claim, applied.body.state))).body.status, 'completed');
  const before = (await h.get('/api/bridge/context')).body;
  assert.equal(before.facts.y, 10); assert.equal(before.facts.slope, 20); assert.equal(before.facts.endY, 40); assert.equal(before.facts.tangentEndY, 30);
  const invalid = await h.post('/api/bridge/command', { kind: 'control', action: 'parameter', payload: { a: 10.01 }, expected: before.anchor }, true);
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'INVALID_PARAMETER');
  assert.deepEqual((await h.get('/api/bridge/context')).body.state, before.state);
});

test('native cancellation aborts its running question and rejects late display or results', async t => {
  let args, resolve;
  const h = await fixture(t, { generateImpl: input => { args = input; return new Promise(done => { resolve = done; }); } });
  const { session } = await h.reader(); const claim = await command(h);
  await h.post('/api/ask', askInput(claim));
  const cancelled = await h.post('/api/bridge/cancel', { id: claim.id }, true);
  assert.equal(cancelled.body.error.code, 'BRIDGE_CANCELLED'); assert.equal(args.signal.aborted, true);
  resolve(generated(args)); await new Promise(done => setImmediate(done));
  assert.equal(h.app.core.state.conversation.filter(item => item.role === 'assistant').length, 0);
  assert.equal((await h.post('/api/bridge/result', resultInput(claim, session.state))).status, 409);
});

test('cancelling an expired bridge job never cancels a newer local question', async t => {
  const calls = [];
  const h = await fixture(t, { generateImpl: input => { calls.push(input); return new Promise(() => {}); } });
  const { session } = await h.reader(); const claim = await command(h);
  await h.post('/api/ask', askInput(claim));
  const state = h.app.core.snapshot();
  await h.post('/api/ask', { connectionId: session.connectionId, revision: state.revision, viewEpoch: state.viewEpoch,
    pageId: state.pageId, selectedId: state.selectedId, clientTurnId: 'local-question', question: 'A newer local question.' });
  assert.equal(calls[0].signal.aborted, true); assert.equal(calls[1].signal.aborted, false);
  await h.post('/api/bridge/cancel', { id: claim.id }, true);
  assert.equal(calls[1].signal.aborted, false); assert.equal(h.app.core.active.clientTurnId, 'local-question');
});

test('explicit Stop preempts queued or claimed remote work before any provider execution', async t => {
  for (const claimed of [false, true]) {
    const h = await fixture(t); const { session } = await h.reader();
    const submitted = await h.post('/api/bridge/command', { kind: 'ask', question: 'Explain the slope.' }, true);
    const old = submitted.body;
    const priorClaim = claimed ? (await h.post('/api/bridge/claim', { id: old.id, connectionId: session.connectionId })).body : null;
    const stop = await command(h, { kind: 'control', action: 'cancel', payload: {}, expected: old.anchor });
    const cancelled = (await h.get(`/api/bridge/jobs/${old.id}`)).body;
    assert.equal(cancelled.status, 'failed'); assert.equal(cancelled.error.code, 'BRIDGE_CANCELLED');
    assert.equal(cancelled.result, undefined); assert.deepEqual(stop.anchor, old.anchor);
    assert.equal(h.app.core.active, null);
    if (priorClaim) assert.equal((await h.post('/api/ask', askInput(priorClaim))).status, 409);
    else assert.equal((await h.post('/api/bridge/claim', { id: old.id, connectionId: session.connectionId })).status, 409);
    const applied = await h.post('/api/control', { connectionId: session.connectionId, bridgeId: stop.id, action: 'cancel' });
    const completed = await h.post('/api/bridge/result', resultInput(stop, applied.body.state));
    assert.equal(completed.body.status, 'completed'); assert.equal(completed.body.result.action, 'cancel');
    assert.equal(completed.body.result.unit, undefined); assert.equal(completed.body.result.step, undefined);
  }
});

test('explicit Stop aborts the running bridge turn and binds its own command to the fresh view', async t => {
  let captured, resolve;
  const h = await fixture(t, { generateImpl: args => { captured = args; return new Promise(done => { resolve = done; }); } });
  const { session } = await h.reader(); const old = await command(h);
  await h.post('/api/ask', askInput(old));
  const before = (await h.get('/api/bridge/context')).body.anchor;
  const stop = await command(h, { kind: 'control', action: 'cancel', expected: before });
  assert.equal(captured.signal.aborted, true); assert.equal(h.app.core.active, null);
  assert.equal(stop.anchor.revision, before.revision + 1);
  assert.equal(stop.anchor.viewEpoch, before.viewEpoch + 1);
  assert.deepEqual(stop.anchor, (await h.get('/api/bridge/context')).body.anchor);
  assert.equal((await h.get(`/api/bridge/jobs/${old.id}`)).body.error.code, 'BRIDGE_CANCELLED');
  resolve(generated(captured)); await new Promise(done => setImmediate(done));
  assert.equal(h.app.core.state.conversation.filter(item => item.role === 'assistant').length, 0);
  const applied = await h.post('/api/control', { connectionId: session.connectionId, bridgeId: stop.id, action: 'cancel' });
  assert.equal(applied.status, 200);
  assert.equal((await h.post('/api/bridge/result', resultInput(stop, applied.body.state))).body.status, 'completed');
});

test('stale expectations and invalid Stop payloads preserve current remote and newer local work', async t => {
  const calls = [];
  const h = await fixture(t, { generateImpl: args => { calls.push(args); return new Promise(() => {}); } });
  const { session } = await h.reader(); const old = await command(h);
  await h.post('/api/ask', askInput(old));
  const current = (await h.get('/api/bridge/context')).body.anchor;
  const invalid = await h.post('/api/bridge/command', { kind: 'control', action: 'cancel', payload: { a: 2 }, expected: current }, true);
  assert.equal(invalid.body.error.code, 'BRIDGE_INVALID_PAYLOAD'); assert.equal(calls[0].signal.aborted, false);
  assert.equal((await h.get(`/api/bridge/jobs/${old.id}`)).body.status, 'running');
  const stale = await h.post('/api/bridge/command', { kind: 'control', action: 'cancel', expected: old.anchor }, true);
  assert.equal(stale.body.error.code, 'BRIDGE_STALE_VIEW'); assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual((await h.get('/api/bridge/context')).body.anchor, current);
  await h.post('/api/ask', { ...current, connectionId: session.connectionId, clientTurnId: 'new-local-turn', question: 'Explain a different point.' });
  assert.equal(calls[0].signal.aborted, true); assert.equal(calls[1].signal.aborted, false);
  const staleLocal = await h.post('/api/bridge/command', { kind: 'control', action: 'cancel', expected: current }, true);
  assert.equal(staleLocal.body.error.code, 'BRIDGE_STALE_VIEW'); assert.equal(calls[1].signal.aborted, false);
  assert.equal(h.app.core.active.clientTurnId, 'new-local-turn');
});

test('deadline expires claimed and running jobs without allowing late execution', async t => {
  let captured;
  const h = await fixture(t, { bridgeTimeoutMs: 70, generateImpl: args => { captured = args; return new Promise(() => {}); } });
  await h.reader(); const first = await command(h);
  await new Promise(done => setTimeout(done, 110));
  assert.equal((await h.get(`/api/bridge/jobs/${first.id}`)).body.error.code, 'BRIDGE_TIMEOUT');
  assert.equal((await h.post('/api/ask', askInput(first))).status, 409);
  const second = await command(h); await h.post('/api/ask', askInput(second));
  await new Promise(done => setTimeout(done, 110));
  const expired = (await h.get(`/api/bridge/jobs/${second.id}`)).body;
  assert.equal(expired.error.code, 'BRIDGE_TIMEOUT'); assert.equal(expired.result, undefined);
  assert.equal(captured.signal.aborted, true);
});

test('disconnect aborts the matching bridge execution and failed browser text is not reflected', async t => {
  let captured;
  const h = await fixture(t, { generateImpl: args => { captured = args; return new Promise(() => {}); } });
  const { peer } = await h.reader(); const claim = await command(h); await h.post('/api/ask', askInput(claim));
  peer.close(); await new Promise(done => setTimeout(done, 25));
  const failed = (await h.get(`/api/bridge/jobs/${claim.id}`)).body;
  assert.equal(failed.status, 'failed'); assert.equal(failed.result, undefined); assert.equal(captured.signal.aborted, true);
  await h.reader(); const second = await command(h);
  const browserFailure = await h.post('/api/bridge/result', { id: second.id, connectionId: second.anchor.connectionId,
    status: 'failed', message: 'PRIVATE_OR_UNTRUSTED_TEXT' });
  assert.equal(browserFailure.body.status, 'failed'); assert.equal(JSON.stringify(browserFailure.body).includes('PRIVATE_OR_UNTRUSTED_TEXT'), false);
});

test('bounded retention drops old jobs without exposing stale speakable output', async t => {
  const h = await fixture(t); await h.reader(); let oldest;
  for (let index = 0; index < 34; index++) {
    const submitted = await h.post('/api/bridge/command', { kind: 'control', action: 'cancel' }, true);
    assert.equal(submitted.status, 202); oldest ??= submitted.body.id;
    await h.post('/api/bridge/cancel', { id: submitted.body.id }, true);
  }
  assert.equal((await h.get(`/api/bridge/jobs/${oldest}`)).status, 404);
});
