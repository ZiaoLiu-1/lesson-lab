import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BenchmarkProviderError, WALL_TIMEOUT_MS } from './providers.js';

const EFFORTS = ['low', 'medium', 'high'];
const ROUTES = Object.freeze({
  astra: { model: 'gpt-6-astra', endpoint: 'https://api.openai.com/v1/chat/completions', key: 'OPENAI_API_KEY' },
  'cerebras-qwen': { model: 'qwen-3.8-27b', endpoint: 'https://api.cerebras.ai/v1/chat/completions', key: 'CEREBRAS_API_KEY' },
});
const SCHEMA = { type: 'object', properties: { html: { type: 'string' }, summary: { type: 'string' } },
  required: ['html', 'summary'], additionalProperties: false };
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new BenchmarkProviderError(code, message); };

export function apiConfigs(effort = 'low') {
  if (!EFFORTS.includes(effort)) fail('INVALID_INPUT', 'Reasoning effort must be low, medium, or high.');
  return Object.fromEntries(Object.entries(ROUTES).map(([lane, route]) => [lane, {
    model: route.model, endpoint: route.endpoint, reasoningEffort: effort,
    maxCompletionTokens: 8192, streaming: false, temperature: null,
    transport: 'Direct Chat Completions API', tools: false, retries: 0, timeoutMs: WALL_TIMEOUT_MS,
  }]));
}

/** Public evidence contains the submitted task, never headers or credentials. */
export function buildApiRequest({ lane, prompt, schema, effort = 'low' } = {}) {
  const config = apiConfigs(effort)[lane];
  if (!Object.hasOwn(ROUTES, lane) || !config || typeof prompt !== 'string' || !prompt.trim()
      || prompt.length > 200_000 || !isDeepStrictEqual(schema, SCHEMA)) {
    fail('INVALID_INPUT', 'A supported lane, nonempty prompt and the HTML/summary schema are required.');
  }
  const body = {
    model: config.model, reasoning_effort: effort, max_completion_tokens: 8192, stream: false,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_schema', json_schema: { name: 'edited_lesson', strict: true, schema: structuredClone(SCHEMA) } },
  };
  const { model: _model, ...matchedBody } = body;
  return { endpoint: config.endpoint, body, bodyHash: hash(JSON.stringify(body)), matchedBodyHash: hash(JSON.stringify(matchedBody)) };
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,200}$/.test(value) ? value : null;
}
function usageCounts(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  const copy = (from, fields) => Object.fromEntries(fields.filter(key => Number.isSafeInteger(from?.[key]) && from[key] >= 0).map(key => [key, from[key]]));
  Object.assign(result, copy(value, ['prompt_tokens', 'completion_tokens', 'total_tokens']));
  for (const [key, fields] of [
    ['prompt_tokens_details', ['cached_tokens', 'audio_tokens']],
    ['completion_tokens_details', ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']],
  ]) {
    const details = copy(value[key], fields);
    if (Object.keys(details).length) result[key] = details;
  }
  return Object.keys(result).length ? result : null;
}
function parseOutput(text) {
  if (typeof text !== 'string' || text.length > 600_000) fail('INVALID_OUTPUT', 'The provider did not return the required final JSON.');
  let value;
  try { value = JSON.parse(text); } catch { fail('INVALID_OUTPUT', 'The provider did not return valid final JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join() !== 'html,summary'
      || typeof value.html !== 'string' || !value.html.trim() || value.html.length > 500_000
      || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 5000) {
    fail('INVALID_OUTPUT', 'The provider did not return the required HTML and summary.');
  }
  return value;
}

// Also discards late results from an injected transport that ignores AbortSignal.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Aborted.'));
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function discardBody(response) {
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* No raw diagnostics retained. */ }
}

/** Both lanes use this exact fetch/body/completion path. No CLI, tools or retries. */
export function createApiCodeGenerator({ effort = 'low', fetchImpl = (...args) => globalThis.fetch(...args),
  env = process.env, timeoutMs = WALL_TIMEOUT_MS } = {}) {
  const configs = apiConfigs(effort);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('INVALID_INPUT', 'A positive request deadline is required.');
  return async function generateApiCode({ lane, prompt, schema, signal, onEvent } = {}) {
    const started = performance.now();
    const stamp = () => +(performance.now() - started).toFixed(3);
    const metadata = {
      lane: Object.hasOwn(ROUTES, lane) ? lane : null, model: configs[lane]?.model ?? null,
      modelReported: null, modelSource: 'requested configuration', providerId: null, providerIdKind: null,
      requestId: null, usage: null, finishReason: null, httpStatus: null,
      effectiveConfig: configs[lane] ? { ...configs[lane], timeoutMs } : null,
      startedAt: new Date().toISOString(), elapsedMs: 0, firstOutputMs: null, firstOutputKind: null,
      requestEvidence: null, dispatchAt: null, dispatchMs: null, responseHeadersMs: null, bodyCompleteMs: null,
      responseHeadersAfterDispatchMs: null, bodyCompleteAfterDispatchMs: null,
    };
    const emit = (name, data = {}) => {
      if (typeof onEvent !== 'function') return;
      try {
        const returned = onEvent(name, structuredClone({ elapsedMs: stamp(), ...data }));
        if (returned && typeof returned.catch === 'function') returned.catch(() => {});
      } catch { /* Observers must not alter or fail a request. */ }
    };
    const deadline = new AbortController();
    let combined, timer, response;
    try {
      if (signal && !(signal instanceof AbortSignal)) fail('INVALID_INPUT', 'The cancellation signal is invalid.');
      combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      timer = setTimeout(() => deadline.abort(), timeoutMs);
      combined.throwIfAborted();
      const request = buildApiRequest({ lane, prompt, schema, effort });
      metadata.requestEvidence = structuredClone(request);
      const apiKey = env[ROUTES[lane].key];
      if (typeof apiKey !== 'string' || !apiKey.trim()) fail('API_CONFIGURATION', 'The selected API credential is not configured.');
      emit('started', { lane, effectiveConfig: metadata.effectiveConfig, requestEvidence: request });
      combined.throwIfAborted();
      metadata.dispatchAt = new Date().toISOString();
      metadata.dispatchMs = stamp();
      // Captured immediately before invoking fetch; not an upstream network wire timestamp.
      const pending = fetchImpl(request.endpoint, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(request.body),
      });
      emit('dispatch', { dispatchAt: metadata.dispatchAt, dispatchMs: metadata.dispatchMs, endpoint: request.endpoint });
      response = await abortable(pending, combined);
      combined.throwIfAborted();
      metadata.responseHeadersMs = stamp();
      metadata.responseHeadersAfterDispatchMs = +(metadata.responseHeadersMs - metadata.dispatchMs).toFixed(3);
      metadata.httpStatus = Number.isInteger(response.status) ? response.status : null;
      metadata.requestId = identifier(response.headers?.get('x-request-id'));
      emit('response_headers', { httpStatus: metadata.httpStatus, requestId: metadata.requestId,
        responseHeadersMs: metadata.responseHeadersMs, responseHeadersAfterDispatchMs: metadata.responseHeadersAfterDispatchMs });
      combined.throwIfAborted();
      if (!response.ok) {
        discardBody(response);
        if (response.status === 401 || response.status === 403) fail('API_AUTH', 'API authentication or model access was rejected.');
        if (response.status === 429) fail('API_RATE_LIMIT', 'The selected API is rate limited.');
        fail('API_HTTP', 'The selected API returned an unsuccessful HTTP status.');
      }
      const text = await abortable(response.text(), combined);
      combined.throwIfAborted();
      metadata.bodyCompleteMs = stamp();
      metadata.bodyCompleteAfterDispatchMs = +(metadata.bodyCompleteMs - metadata.dispatchMs).toFixed(3);
      emit('body_complete', { bodyCompleteMs: metadata.bodyCompleteMs, bodyCompleteAfterDispatchMs: metadata.bodyCompleteAfterDispatchMs });
      combined.throwIfAborted();
      if (text.length > 8_000_000) fail('INVALID_OUTPUT', 'The API response exceeded the response limit.');
      let body;
      try { body = JSON.parse(text); } catch { fail('INVALID_OUTPUT', 'The API response was not valid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.error) fail('INVALID_OUTPUT', 'The API did not return a completed generation.');
      metadata.providerId = identifier(body.id);
      metadata.providerIdKind = metadata.providerId ? 'chat_completion' : null;
      metadata.modelReported = identifier(body.model);
      metadata.modelSource = metadata.modelReported ? 'provider response' : 'requested configuration';
      metadata.usage = usageCounts(body.usage);
      const choice = Array.isArray(body.choices) && body.choices.length === 1 ? body.choices[0] : null;
      metadata.finishReason = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice?.finish_reason) ? choice.finish_reason : null;
      if (choice?.finish_reason === 'length') fail('TRUNCATED', 'The generated source reached the output limit and was not applied.');
      if (choice?.finish_reason !== 'stop' || choice.message?.refusal || choice.message?.tool_calls || choice.message?.function_call) {
        fail('INVALID_OUTPUT', 'The API did not finish one complete code response.');
      }
      const output = parseOutput(choice.message?.content);
      combined.throwIfAborted();
      metadata.elapsedMs = stamp();
      emit('complete', { metadata });
      combined.throwIfAborted();
      return { output, metadata: structuredClone(metadata) };
    } catch (error) {
      discardBody(response);
      const snapshot = { ...structuredClone(metadata), elapsedMs: stamp() };
      if (signal?.aborted) throw new BenchmarkProviderError('CANCELLED', 'The API request was cancelled.', snapshot);
      if (deadline.signal.aborted) throw new BenchmarkProviderError('TIMEOUT', 'The API request exceeded the shared deadline.', snapshot);
      if (error instanceof BenchmarkProviderError) { error.metadata = snapshot; throw error; }
      throw new BenchmarkProviderError('API_FAILED', 'The API connection or response failed.', snapshot);
    } finally { clearTimeout(timer); }
  };
}
