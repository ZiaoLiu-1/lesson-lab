import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createApiCodeGenerator, buildApiRequest, apiConfigs } from '../benchmark/api-provider.js';
import { BenchmarkProviderError } from '../benchmark/providers.js';
import { outputSchema as schema, promptFor } from '../benchmark/tasks.js';

const prompt = promptFor('T1');
const output = { html: '<div id="lesson-root">Ready</div>', summary: 'Ready.' };
const secret = 'offline-secret-not-a-real-key';
const privateText = 'private-error-or-reasoning-text';
const env = { OPENAI_API_KEY: secret, CEREBRAS_API_KEY: secret };
const hash = value => createHash('sha256').update(value).digest('hex');
const packet = overrides => ({ id: 'chatcmpl-test', model: 'resolved-test-model',
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output), reasoning_content: privateText } }],
  usage: { prompt_tokens: 42, completion_tokens: 24, total_tokens: 66, unknown: privateText,
    prompt_tokens_details: { cached_tokens: 3, secret }, completion_tokens_details: { reasoning_tokens: 12, text: privateText } }, ...overrides });
const response = body => new Response(JSON.stringify(body), { headers: { 'x-request-id': 'req-test' } });
function safeError(code) {
  return error => {
    assert(error instanceof BenchmarkProviderError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert(!JSON.stringify(error).includes(secret));
    assert(!JSON.stringify(error).includes(privateText));
    assert(!error.message.includes(secret));
    return true;
  };
}

for (const effort of ['low', 'medium', 'high']) {
  test(`common API ${effort}: actual fetch bodies differ only by model, with matching evidence`, async () => {
    const requests = [], results = [], events = [];
    const generate = createApiCodeGenerator({ effort, env, fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${secret}`);
      assert(options.signal instanceof AbortSignal);
      return response(packet({ model: JSON.parse(options.body).model }));
    } });
    for (const lane of ['astra', 'cerebras-qwen']) {
      const currentEvents = [];
      const result = await generate({ lane, prompt, schema, onEvent: (name, data) => currentEvents.push({ name, data }) });
      results.push(result); events.push(currentEvents);
      assert.deepEqual(result.output, output);
      assert.deepEqual(currentEvents.map(e => e.name), ['started', 'dispatch', 'response_headers', 'body_complete', 'complete']);
      assert.deepEqual(currentEvents.at(-1).data.metadata, result.metadata);
      assert.equal(result.metadata.effectiveConfig.reasoningEffort, effort);
      assert.equal(result.metadata.effectiveConfig.timeoutMs, 90000);
      assert.equal(result.metadata.firstOutputMs, null);
      assert.equal(result.metadata.firstOutputKind, null);
      assert.equal(result.metadata.requestId, 'req-test'); assert.equal(result.metadata.providerId, 'chatcmpl-test');
      assert(Number.isFinite(Date.parse(result.metadata.dispatchAt)));
      assert(result.metadata.dispatchMs <= result.metadata.responseHeadersMs);
      assert(result.metadata.responseHeadersMs <= result.metadata.bodyCompleteMs);
      assert(result.metadata.bodyCompleteMs <= result.metadata.elapsedMs);
      assert.deepEqual(result.metadata.usage, { prompt_tokens: 42, completion_tokens: 24, total_tokens: 66,
        prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 12 } });
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(requests[1].url, 'https://api.cerebras.ai/v1/chat/completions');
    const bodies = requests.map(r => JSON.parse(r.options.body));
    const matched = bodies.map(({ model, ...rest }) => rest);
    assert.deepEqual(matched[0], matched[1]);
    assert.deepEqual(matched[0], { reasoning_effort: effort, max_completion_tokens: 8192, stream: false,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'edited_lesson', strict: true, schema } } });
    assert.equal(bodies[0].model, 'gpt-6-astra'); assert.equal(bodies[1].model, 'qwen-3.8-27b');
    for (let index = 0; index < 2; index++) {
      const evidence = results[index].metadata.requestEvidence;
      assert.deepEqual(evidence.body, bodies[index]);
      assert.equal(evidence.bodyHash, hash(requests[index].options.body));
      assert.equal(evidence.matchedBodyHash, hash(JSON.stringify(matched[index])));
      assert.equal(results[index].metadata.modelReported, bodies[index].model);
    }
    assert.equal(results[0].metadata.requestEvidence.matchedBodyHash, results[1].metadata.requestEvidence.matchedBodyHash);
    assert.notEqual(results[0].metadata.requestEvidence.bodyHash, results[1].metadata.requestEvidence.bodyHash);
    for (const text of [JSON.stringify(results), JSON.stringify(events)]) {
      assert(!text.includes(secret)); assert(!text.includes(privateText)); assert(!text.includes('Authorization'));
    }
  });
}

test('preflight is deterministic, detached, validates inputs, and exposes no credential fields', () => {
  const first = buildApiRequest({ lane: 'astra', prompt, schema });
  first.body.messages[0].content = 'changed';
  assert.equal(buildApiRequest({ lane: 'astra', prompt, schema }).body.messages[0].content, prompt);
  const configs = apiConfigs(); configs.astra.model = 'changed';
  assert.equal(apiConfigs().astra.model, 'gpt-6-astra');
  for (const input of [{ lane: 'cerebras', prompt, schema }, { lane: 'astra', prompt: '', schema },
    { lane: 'astra', prompt, schema: { ...schema, additionalProperties: true } },
    { lane: 'astra', prompt, schema, effort: 'extreme' }]) {
    assert.throws(() => buildApiRequest(input), safeError('INVALID_INPUT'));
  }
  assert.throws(() => createApiCodeGenerator({ timeoutMs: 0 }), safeError('INVALID_INPUT'));
});

test('each endpoint uses only its own credential; neither credential enters stored evidence', async () => {
  const keys = { OPENAI_API_KEY: 'offline-openai-only', CEREBRAS_API_KEY: 'offline-cerebras-only' };
  const generate = createApiCodeGenerator({ env: keys, fetchImpl: async (url, request) => {
    assert.equal(request.headers.Authorization, `Bearer ${url.includes('openai.com') ? keys.OPENAI_API_KEY : keys.CEREBRAS_API_KEY}`);
    return response(packet());
  } });
  for (const lane of ['astra', 'cerebras-qwen']) {
    const result = await generate({ lane, prompt, schema });
    for (const value of Object.values(keys)) assert(!JSON.stringify(result).includes(value));
  }
});

test('invalid lane/schema and missing credentials never dispatch; pre-abort starts no transport', async () => {
  let calls = 0;
  const generate = createApiCodeGenerator({ env: {}, fetchImpl: () => { calls++; throw new Error(secret); } });
  await assert.rejects(generate({ lane: 'astra', prompt, schema }), safeError('API_CONFIGURATION'));
  await assert.rejects(generate({ lane: 'cerebras-qwen', prompt, schema }), safeError('API_CONFIGURATION'));
  await assert.rejects(generate({ lane: 'unknown', prompt, schema }), safeError('INVALID_INPUT'));
  await assert.rejects(generate({ lane: 'astra', prompt, schema: {} }), safeError('INVALID_INPUT'));
  const controller = new AbortController(); controller.abort(new Error(secret));
  await assert.rejects(generate({ lane: 'astra', prompt, schema, signal: controller.signal }), error => {
    safeError('CANCELLED')(error); assert.equal(error.metadata.dispatchAt, null); return true;
  });
  assert.equal(calls, 0);
});

test('HTTP failures never read or expose the error body, and never retry', async () => {
  for (const [status, code] of [[401, 'API_AUTH'], [403, 'API_AUTH'], [429, 'API_RATE_LIMIT'], [500, 'API_HTTP']]) {
    let calls = 0, discarded = 0;
    const generate = createApiCodeGenerator({ env, fetchImpl: async () => {
      calls++;
      return { ok: false, status, headers: new Headers({ 'x-request-id': 'request-failed' }),
        body: { cancel: async () => { discarded++; } }, text: () => { throw new Error(`${secret} ${privateText}`); } };
    } });
    await assert.rejects(generate({ lane: 'astra', prompt, schema }), error => {
      safeError(code)(error); assert.equal(error.metadata.httpStatus, status);
      assert.equal(error.metadata.requestId, 'request-failed'); assert.equal(error.metadata.bodyCompleteMs, null); return true;
    });
    assert.equal(calls, 1); assert(discarded >= 1);
  }
});

test('truncation preserves safe usage but never returns partial output or raw reasoning', async () => {
  const generate = createApiCodeGenerator({ env, fetchImpl: async () => response(packet({
    choices: [{ finish_reason: 'length', message: { content: privateText } }],
  })) });
  await assert.rejects(generate({ lane: 'cerebras-qwen', prompt, schema }), error => {
    safeError('TRUNCATED')(error); assert.equal(error.metadata.usage.completion_tokens, 24);
    assert.equal(error.metadata.finishReason, 'length'); assert.equal(error.output, undefined); return true;
  });
});

test('strict output gate rejects malformed JSON, extra keys, refusals, tool calls and incomplete choices', async () => {
  const bad = [
    packet({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{}\n```' } }] }),
    packet({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...output, reasoning: privateText }) } }] }),
    packet({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...output, summary: '' }) } }] }),
    packet({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output), refusal: privateText } }] }),
    packet({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output), tool_calls: [] } }] }),
    packet({ choices: [] }), packet({ error: { message: `${secret} ${privateText}` } }),
  ];
  for (const body of bad) {
    const generate = createApiCodeGenerator({ env, fetchImpl: async () => response(body) });
    await assert.rejects(generate({ lane: 'astra', prompt, schema }), safeError('INVALID_OUTPUT'));
  }
});

test('cancel while fetch is pending drops late completion even if a transport ignores abort', async () => {
  const controller = new AbortController(); let resolveFetch, requestSignal; const names = [];
  const generate = createApiCodeGenerator({ env, fetchImpl: (_url, options) => {
    requestSignal = options.signal;
    return new Promise(resolve => { resolveFetch = resolve; });
  } });
  const pending = generate({ lane: 'astra', prompt, schema, signal: controller.signal, onEvent: name => names.push(name) });
  controller.abort(new Error(`${secret} ${privateText}`));
  await assert.rejects(pending, safeError('CANCELLED'));
  resolveFetch(response(packet())); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requestSignal.aborted, true); assert.deepEqual(names, ['started', 'dispatch']);
});

test('the deadline also covers body download; timeout is not retried or misreported as model output', async () => {
  let calls = 0, requestSignal;
  const generate = createApiCodeGenerator({ env, timeoutMs: 15, fetchImpl: async (_url, options) => {
    calls++; requestSignal = options.signal;
    return { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}), body: { cancel: async () => {} } };
  } });
  await assert.rejects(generate({ lane: 'cerebras-qwen', prompt, schema }), error => {
    safeError('TIMEOUT')(error); assert(error.metadata.responseHeadersMs !== null);
    assert.equal(error.metadata.bodyCompleteMs, null); assert.equal(error.metadata.usage, null); return true;
  });
  assert.equal(requestSignal.aborted, true); assert.equal(calls, 1);
});

test('cancelling during body download discards its late complete source', async () => {
  const controller = new AbortController(); let resolveBody, bodyStarted;
  const ready = new Promise(resolve => { bodyStarted = resolve; });
  const names = [];
  const generate = createApiCodeGenerator({ env, fetchImpl: async () => ({
    ok: true, status: 200, headers: new Headers(), body: { cancel: async () => {} },
    text: () => { bodyStarted(); return new Promise(resolve => { resolveBody = resolve; }); },
  }) });
  const pending = generate({ lane: 'astra', prompt, schema, signal: controller.signal, onEvent: name => names.push(name) });
  await ready; controller.abort();
  await assert.rejects(pending, safeError('CANCELLED'));
  resolveBody(JSON.stringify(packet())); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(names, ['started', 'dispatch', 'response_headers']);
});

test('observer mutation/throw cannot alter the request, metadata or outcome', async () => {
  let body;
  const generate = createApiCodeGenerator({ env, fetchImpl: async (_url, options) => { body = options.body; return response(packet()); } });
  const result = await generate({ lane: 'astra', prompt, schema, onEvent(name, data) {
    if (data.requestEvidence) data.requestEvidence.body.messages[0].content = 'tampered';
    if (data.metadata) data.metadata.model = 'tampered';
    throw new Error(secret);
  } });
  assert.equal(JSON.parse(body).messages[0].content, prompt); assert.equal(result.metadata.model, 'gpt-6-astra');
  assert.equal(result.metadata.requestEvidence.body.messages[0].content, prompt);
});

test('cancellation from complete observer cannot allow stale successful output', async () => {
  const controller = new AbortController();
  const generate = createApiCodeGenerator({ env, fetchImpl: async () => response(packet()) });
  await assert.rejects(generate({ lane: 'astra', prompt, schema, signal: controller.signal,
    onEvent(name) { if (name === 'complete') controller.abort(); } }), safeError('CANCELLED'));
});

test('unexpected transport exceptions and invalid JSON expose no provider error or credential', async () => {
  for (const fetchImpl of [async () => { throw new Error(`${secret} ${privateText}`); },
    async () => new Response(`not-json ${privateText}`)]) {
    let error;
    try { await createApiCodeGenerator({ env, fetchImpl })({ lane: 'astra', prompt, schema }); } catch (caught) { error = caught; }
    assert(error); safeError(error.code)(error);
    assert(['API_FAILED', 'INVALID_OUTPUT'].includes(error.code));
  }
});
