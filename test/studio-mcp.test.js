import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridgeClient, BridgeClientError } from '../studio/mcp-client.js';
import { serveMCP } from '../studio/mcp-server.js';

const TOKEN = 'abcdeff0'.repeat(8); // Deliberately fake, never read from the workspace.
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) {
  for (let n = 0; n < 300; n++) { if (predicate()) return; await delay(2); }
  assert.fail('Fixture condition did not arrive');
}
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
function mcp(t, client) {
  const input = new PassThrough(); const output = new PassThrough(); const messages = []; let buffer = '';
  output.setEncoding('utf8');
  output.on('data', text => { buffer += text; let end; while ((end = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  const reader = serveMCP({ input, output, client });
  t.after(() => { reader.close(); input.destroy(); output.destroy(); });
  return { messages, input,
    send(value) { input.write(JSON.stringify(value) + '\n'); },
    async response(id) { await until(() => messages.some(m => m.id === id)); return messages.find(m => m.id === id); },
  };
}
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const content = response => JSON.parse(response.result.content[0].text);

async function fakeHTTP(t, handler, clientOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-lab-mcp-test-'));
  fs.writeFileSync(path.join(dataDir, 'bridge.token'), TOKEN, { mode: 0o600 });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : undefined;
    const entry = { route: req.url, method: req.method, authorization: req.headers.authorization, body }; requests.push(entry);
    try {
      if (await handler(entry, res, req) !== false) return;
      if (entry.route === '/api/health') return json(res, { ok: true, bridgeVersion: '1' });
      if (entry.route === '/api/bridge/cancel') return json(res, { id: body.id, status: 'failed' });
      json(res, { error: { code: 'NOT_FOUND', message: 'Fixture route missing.' } }, 404);
    } catch { if (!res.destroyed) json(res, { error: { code: 'FIXTURE_ERROR', message: 'Fixture handler failed.' } }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const client = createBridgeClient({ port, dataDir, launch: false, pollMs: 2, waitMs: 500, ...clientOptions });
  return { client, dataDir, port, requests };
}

test('MCP stdio initializes, lists four bounded tools, and pings without invoking a client', async t => {
  const h = mcp(t, new Proxy({}, { get() { assert.fail('Initialization must not call HTTP'); } }));
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'fixture', version: '1' } } });
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.equal((await h.response(1)).result.protocolVersion, '2025-11-25');
  const tools = (await h.response(2)).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['open_lesson', 'get_lesson_context', 'ask_tutor', 'control_lesson']);
  assert.equal(tools.find(tool => tool.name === 'get_lesson_context').annotations.readOnlyHint, true);
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.deepEqual((await h.response(3)).result, {});
  assert.equal(h.messages.length, 3);
});

test('MCP rejects unknown methods, tools, invalid questions and extra top-level arguments before dispatch', async t => {
  let dispatched = 0; const h = mcp(t, { command() { dispatched++; return {}; } });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'unknown' }, call(2, 'unknown'),
    call(3, 'ask_tutor', { question: '' }), call(4, 'ask_tutor', { question: 'a'.repeat(2001) }),
    call(5, 'ask_tutor', { question: 'Valid', secret: 'not-an-argument' }),
    call(6, 'control_lesson', { action: 'run_shell' }), call(7, 'ask_tutor', []),
  ];
  for (const request of requests) h.send(request);
  for (const request of requests) assert.ok((await h.response(request.id)).error);
  assert.equal(dispatched, 0);
});

test('MCP enforces advertised nested anchor and control payload types before dispatch', async t => {
  let dispatched = 0; const h = mcp(t, { command() { dispatched++; return {}; } });
  const requests = [
    call(1, 'ask_tutor', { question: 'Valid', expected: [] }),
    call(2, 'ask_tutor', { question: 'Valid', expected: { revision: '7' } }),
    call(3, 'ask_tutor', { question: 'Valid', expected: { injected: true } }),
    call(4, 'control_lesson', { action: 'parameter', payload: { a: '3' } }),
    call(5, 'control_lesson', { action: 'start', payload: { command: 'unexpected' } }),
  ];
  for (const request of requests) h.send(request);
  for (const request of requests) assert.equal((await h.response(request.id)).error?.code, -32602);
  assert.equal(dispatched, 0);
});

test('MCP dispatch preserves command kind and optional expected anchor', async t => {
  const received = []; const h = mcp(t, { command(command, options) { received.push({ command, signal: options.signal }); return { visible: true, narration: null }; } });
  h.send(call(1, 'ask_tutor', { question: 'Explain the tangent.', expected: { revision: 7, pageId: 'p1' } }));
  h.send(call(2, 'control_lesson', { action: 'parameter', payload: { a: 3 } }));
  await h.response(1); await h.response(2);
  assert.deepEqual(received.map(item => item.command), [
    { kind: 'ask', question: 'Explain the tangent.', expected: { revision: 7, pageId: 'p1' } },
    { kind: 'control', action: 'parameter', payload: { a: 3 } },
  ]);
  assert.ok(received.every(item => item.signal instanceof AbortSignal));
});

test('MCP cancellation targets its own in-flight request and cannot cancel another tool call', async t => {
  const operations = new Map();
  const h = mcp(t, { command(command, { signal }) {
    const gate = deferred(); operations.set(command.question, { signal, gate });
    signal.addEventListener('abort', () => gate.reject(new Error('fixture cancellation detail')));
    return gate.promise;
  } });
  h.send(call(1, 'ask_tutor', { question: 'First' })); h.send(call(2, 'ask_tutor', { question: 'Second' }));
  await until(() => operations.size === 2);
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  assert.equal(content(await h.response(1)).error.code, 'CANCELLED');
  assert.equal(operations.get('First').signal.aborted, true);
  assert.equal(operations.get('Second').signal.aborted, false);
  operations.get('Second').gate.resolve({ narration: 'Confirmed fixture.' });
  assert.equal(content(await h.response(2)).narration, 'Confirmed fixture.');
});

test('closing MCP input cancels active commands', async t => {
  const gate = deferred(); let signal;
  const h = mcp(t, { command(_command, options) { signal = options.signal; signal.addEventListener('abort', () => gate.reject(new Error('closed'))); return gate.promise; } });
  h.send(call(1, 'ask_tutor', { question: 'Pending' })); await until(() => signal);
  h.input.end(); await until(() => signal.aborted);
});

test('real fake-HTTP polling produces no MCP narration until the job is completed', async t => {
  let completed = false;
  const h = await fakeHTTP(t, (req, res) => {
    if (req.route === '/api/bridge/command') return json(res, { id: 'job-1', status: 'queued' });
    if (req.route === '/api/bridge/jobs/job-1') return json(res, { id: 'job-1', status: completed ? 'completed' : 'running', result: { unit: { title: 'Tangent', text: 'The local slope is two.' } } });
    return false;
  });
  const pipe = mcp(t, h.client); pipe.send(call(1, 'ask_tutor', { question: 'Explain.' }));
  await until(() => h.requests.some(req => req.route === '/api/bridge/jobs/job-1'));
  await delay(10); assert.equal(pipe.messages.length, 0);
  completed = true;
  const result = content(await pipe.response(1));
  assert.equal(result.narration, 'Tangent. The local slope is two.'); assert.equal(result.visible, true);
  assert.ok(h.requests.filter(req => req.route === '/api/health').every(req => !req.authorization));
  assert.ok(h.requests.filter(req => req.route.startsWith('/api/bridge/')).every(req => req.authorization === `Bearer ${TOKEN}`));
  assert.ok(!JSON.stringify(pipe.messages).includes(TOKEN));
});

test('open and read-only context reuse an existing service without rotating a browser session', async t => {
  const h = await fakeHTTP(t, (req, res) => {
    if (req.route === '/api/bridge/context') return json(res, { connected: false, anchor: { connectionId: 'existing-reader', revision: 4 } });
    return false;
  });
  const opened = await h.client.open();
  const context = await h.client.context();
  assert.equal(opened.url, `http://127.0.0.1:${h.port}/`);
  assert.equal(opened.connected, false, 'An available server is not a connected reader');
  assert.deepEqual(context.anchor, { connectionId: 'existing-reader', revision: 4 });
  assert.match(opened.nextAction, /open_in_codex/);
  assert.ok(h.requests.every(req => ['/api/health', '/api/bridge/context'].includes(req.route)));
});

test('a failed job propagates a safe error and never returns its unconfirmed result', async t => {
  const h = await fakeHTTP(t, (req, res) => {
    if (req.route === '/api/bridge/command') return json(res, { id: 'job-failed' });
    if (req.route === '/api/bridge/jobs/job-failed') return json(res, { status: 'failed', error: { code: 'BRIDGE_STALE_VIEW', message: 'The page changed.' }, result: { unit: { title: 'Unconfirmed', text: 'Never narrate this.' } } });
    return false;
  });
  const pipe = mcp(t, h.client); pipe.send(call(1, 'ask_tutor', { question: 'Explain.' }));
  const response = await pipe.response(1); assert.equal(response.result.isError, true);
  assert.deepEqual(content(response), { error: { code: 'BRIDGE_STALE_VIEW', message: 'The page changed.' }, speakable: false });
  assert.equal(h.requests.filter(req => req.route === '/api/bridge/cancel').length, 0);
});

test('client abort during an HTTP poll sends a targeted cancel for that job', async t => {
  const h = await fakeHTTP(t, (req, res) => {
    if (req.route === '/api/bridge/command') return json(res, { id: 'only-this-job' });
    if (req.route === '/api/bridge/jobs/only-this-job') return; // Held open until client aborts.
    return false;
  });
  const abort = new AbortController(); const pending = h.client.command({ kind: 'ask', question: 'Pending' }, { signal: abort.signal });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await until(() => h.requests.some(req => req.route === '/api/bridge/jobs/only-this-job')); abort.abort();
  await rejected;
  assert.deepEqual(h.requests.filter(req => req.route === '/api/bridge/cancel').map(req => req.body), [{ id: 'only-this-job' }]);
  assert.equal(h.requests.some(req => req.route === '/api/control'), false);
});

test('poll timeout cancels its job and returns no narration', async t => {
  const h = await fakeHTTP(t, (req, res) => {
    if (req.route === '/api/bridge/command') return json(res, { id: 'timeout-job' });
    if (req.route === '/api/bridge/jobs/timeout-job') return json(res, { status: 'claimed' });
    return false;
  }, { waitMs: 25 });
  await assert.rejects(h.client.command({ kind: 'control', action: 'start' }), error => error.code === 'TIMEOUT');
  assert.deepEqual(h.requests.filter(req => req.route === '/api/bridge/cancel').map(req => req.body), [{ id: 'timeout-job' }]);
});

test('wrong health version is rejected before reading the token or sending a bearer', async t => {
  const h = await fakeHTTP(t, (req, res) => req.route === '/api/health' ? json(res, { ok: true, bridgeVersion: 'unrelated-service' }) : false);
  const original = fs.readFileSync; let tokenReads = 0;
  fs.readFileSync = function(file, ...args) { if (String(file) === path.join(h.dataDir, 'bridge.token')) tokenReads++; return original.call(this, file, ...args); };
  try { await assert.rejects(h.client.context(), error => error.code === 'SERVER_VERSION'); }
  finally { fs.readFileSync = original; }
  assert.equal(tokenReads, 0);
  assert.ok(h.requests.every(req => req.route === '/api/health' && req.authorization === undefined));
});

test('invalid local pairing token never reaches an authenticated request', async t => {
  const h = await fakeHTTP(t, () => false); fs.writeFileSync(path.join(h.dataDir, 'bridge.token'), 'invalid-fixture-token');
  await assert.rejects(h.client.context(), error => error.code === 'PAIRING' && !error.message.includes('invalid-fixture-token'));
  assert.ok(h.requests.every(req => req.route === '/api/health' && !req.authorization));
});

test('unexpected client exceptions are sanitized in MCP results', async t => {
  const h = mcp(t, { context() { throw new Error(`private diagnostic Bearer ${TOKEN}`); } });
  h.send(call(1, 'get_lesson_context'));
  const response = await h.response(1);
  assert.equal(content(response).error.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(response).includes(TOKEN));
});

test('authorization-bearing HTTP error text cannot be reflected into MCP output', async t => {
  const h = await fakeHTTP(t, (req, res) => {
    if (req.route === '/api/bridge/context') return json(res, { error: { code: 'BRIDGE_AUTH_REQUIRED', message: `Diagnostic Authorization: Bearer ${TOKEN}` } }, 401);
    return false;
  });
  const pipe = mcp(t, h.client); pipe.send(call(1, 'get_lesson_context'));
  const response = await pipe.response(1);
  assert.equal(response.result.isError, true);
  assert.ok(!JSON.stringify(response).includes(TOKEN), 'Never return the local authorization token');
});

test('null JSON input cannot crash the stdio server or prevent a later ping', async () => {
  const moduleURL = new URL('../studio/mcp-server.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {serveMCP} from ${JSON.stringify(moduleURL)}; serveMCP({client:{}});`], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let stderr = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise(resolve => child.once('close', code => resolve(code)));
  child.stdin.end('null\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  const code = await exit; clearTimeout(timer);
  assert.equal(code, 0, `stdio process should survive malformed messages: ${stderr.slice(0, 200)}`);
  const messages = output.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(messages.some(m => m.id === null && m.error?.code === -32600));
  assert.ok(messages.some(m => m.id === 1 && m.result));
});
