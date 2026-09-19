import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioCanvas, CanvasError, createCanvasGenerator, validateCanvasHtml } from '../studio/canvas.js';
import { StudioCore } from '../studio/core.js';
import { createStudioServer } from '../studio/server.js';
import lesson from '../studio/course/lesson.json' with { type: 'json' };

const html = (body = '<section id="intro" data-block-id="intro"><h1>A new lesson</h1><p>Look at the curve.</p></section>', css = 'body { color: #123; background: #fff; }') => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Canvas</title><style>${css}</style></head><body><main>${body}</main></body></html>`;
const changed = html('<article id="new-section" data-block-id="new-section"><h1>A redesigned page</h1><svg viewBox="0 0 100 100" aria-label="A curve"><path d="M 0 100 Q 50 100 100 0" fill="none" stroke="blue"/></svg><a href="https://example.org/lesson">Read more</a></article>', 'body { background: #172c23; color: #fff; }');
const output = overrides => ({ html: changed, narration: 'Notice how the curve gets steeper as x increases.', title: 'A redesigned lesson', focusId: 'new-section', ...overrides });
const generated = overrides => ({ output: output(overrides), metadata: { model: 'qwen-3.8-27b', providerId: 'test-canvas', providerMs: 4, usage: { prompt_tokens: 10, completion_tokens: 20 } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-test-')); let canvas, owner;
  const makeCore = () => new StudioCore({ lesson, generate: async () => { throw new Error('Old Study inference must not run'); }, emit: () => canvas?.refresh() });
  owner = makeCore(); const session = owner.session();
  canvas = new StudioCanvas({ dataDir, getCore: () => owner, generate: async () => generated(), speechImpl: { synthesize: async () => Buffer.from('WAV') }, ...options });
  const anchor = () => { const state = owner.snapshot(); return { connectionId: owner.connectionId, revision: state.revision, viewEpoch: state.viewEpoch, pageId: state.pageId, selectedId: state.selectedId }; };
  const input = extra => { const document = canvas.read(owner.connectionId).document; return { anchor: anchor(), canvasRevision: document?.revision ?? 0,
    question: 'Redesign this lesson and show the curve.', ...(document ? {} : { html: html() }), ...extra }; };
  const identity = document => ({ anchor: anchor(), canvasRevision: document.revision, sourceHash: document.sourceHash });
  t.after(() => { canvas.disconnect(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { canvas, dataDir, session, anchor, input, identity, get core() { return owner; }, replaceCore() { owner = makeCore(); owner.session(); canvas.refresh(); } };
}

test('canvas validates complete static source rewrites, SVG, internal IDs, data images and user-click links', () => {
  const checked = validateCanvasHtml(changed);
  assert.equal(checked.html, changed); assert(checked.blockIds.has('new-section'));
  assert.doesNotThrow(() => validateCanvasHtml(html('<svg viewBox="0 0 10 10"><defs><linearGradient id="shade"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#shade)" vector-effect="non-scaling-stroke"/></svg>', 'svg { clip-path:url(#localClip); }')));
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.doesNotThrow(() => validateCanvasHtml(html(`<img src="${png}" alt="A raster"/><a href="#intro">Jump</a><p id="intro">Point</p>`)));
  assert.doesNotThrow(() => validateCanvasHtml(html('<p>Responsive content</p>', '@media (max-width:600px) { body { padding:1rem; } }')));
});

test('canvas rejects executable markup, navigation/resource attributes and CSS resource obfuscation', () => {
  const forbidden = ['<script>alert(1)</script>', '<iframe srcdoc="hello"></iframe>', '<object></object>', '<embed>', '<form></form>', '<base href="https://example.org/">',
    '<meta http-equiv="refresh" content="0;url=https://example.org">', '<link rel="stylesheet" href="https://example.org/a.css">',
    '<p onclick="bad()">x</p>', '<svg onload="bad()"></svg>', '<a href="jav&#x61;script:bad()">x</a>', '<a href="javascript&colon;bad()">x</a>',
    '<a href="/api/session">x</a>', '<img src="https://example.org/x.png">', '<img srcset="https://example.org/x.png 2x">',
    '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">', '<svg><foreignObject><p>bad</p></foreignObject></svg>',
    '<a href="https://example.org" target="_top">x</a>', '<a href="https://example.org" ping="https://bad.example">x</a>',
    '<p style="background:url(https://example.org/x)">x</p>', '<p style="background:u\\72l(https://example.org)">x</p>', '<p autofocus>x</p>'];
  for (const fragment of forbidden) assert.throws(() => validateCanvasHtml(html(fragment)), error => error.code === 'CANVAS_INVALID_HTML', fragment);
  for (const css of ['@import "https://example.org/x.css";', '@im/**/port "https://example.org/x.css";', 'p{background:image-set("https://example.org/x" 1x)}', 'p{width:expression(alert(1))}']) assert.throws(() => validateCanvasHtml(html('<p>x</p>', css)), undefined, css);
});

test('canvas rejects malformed documents, duplicate targets, mismatched tags, size overflow and bogus numeric declarations', () => {
  for (const source of ['<html><head></head><body></body></html>', '<!DOCTYPE html><html><body></body></html>', html('<div><p>x</div></p>'), html('<p id="same">a</p><p id="same">b</p>'),
    html('<p data-block-id="x">a</p><p data-block-id="x">b</p>'), html('<p>' + 'x'.repeat(80000) + '</p>'), html('<!--><img src=x onerror=bad()>-->')]) assert.throws(() => validateCanvasHtml(source));
  assert.throws(() => validateCanvasHtml(html('<p data-math-key="slope" data-math-value="20">20</p>'), { slope: 30 }), error => error.code === 'CANVAS_MATH_MISMATCH');
  assert.equal(validateCanvasHtml(html('<p data-math-key="slope" data-math-value="30">30</p>'), { slope: 30 }).numericChecks, 1);
});

test('canvas provider sends entire source and selection, returns only final content and never exposes parsed reasoning', async () => {
  let request;
  const generate = createCanvasGenerator({ env: { CEREBRAS_API_KEY: 'test-secret' }, fetchImpl: async (_, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'canvas-id', model: 'qwen-3.8-27b', usage: { completion_tokens: 50 },
      reasoning: 'PRIVATE_TOP_REASONING', choices: [{ finish_reason: 'stop', message: { reasoning: 'PRIVATE_REASONING', content: JSON.stringify(output()) } }] }));
  } });
  const result = await generate({ html: html(), question: 'Add a new section and change the theme.', selectionId: 'intro', model: 'qwen', reference: null });
  assert.equal(request.model, 'qwen-3.8-27b'); assert.equal(request.reasoning_format, 'parsed'); assert.equal(request.reasoning_effort, 'low'); assert.equal(request.max_completion_tokens, 16384);
  assert.equal(request.response_format.json_schema.strict, true); assert.match(request.messages[0].content, /CURRENT COMPLETE SOURCE/);
  assert(request.messages[0].content.includes(html())); assert.match(request.messages[0].content, /SELECTED ID: "intro"/);
  assert.equal(result.output.html, changed); assert.equal(result.output.narration, output().narration);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|test-secret|reasoning/);
});

test('canvas provider rejects planning narration, truncated output, malformed source and sanitizes failures without retries', async () => {
  for (const narration of ['<think>Private reasoning</think>Here is the answer.', 'I will update the code now.', 'Analysis: I need to respond.']) {
    const generate = createCanvasGenerator({ env: { CEREBRAS_API_KEY: 'test-secret' }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output({ narration })) } }] })) });
    await assert.rejects(generate({ html: html(), question: 'Explain.', reference: null }), error => error.code === 'CANVAS_INVALID_OUTPUT');
  }
  const truncated = createCanvasGenerator({ env: { CEREBRAS_API_KEY: 'test-secret' }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })) });
  await assert.rejects(truncated({ html: html(), question: 'Explain.' }), error => error.code === 'CANVAS_TRUNCATED');
  let calls = 0;
  const failure = createCanvasGenerator({ env: { CEREBRAS_API_KEY: 'test-secret' }, fetchImpl: async () => { calls++; throw Error('test-secret private response'); } });
  await assert.rejects(failure({ html: html(), question: 'Explain.' }), error => error.code === 'CANVAS_PROVIDER_UNAVAILABLE' && !JSON.stringify(error).includes('test-secret'));
  assert.equal(calls, 1);
});

test('canvas commits full HTML independently of old parameter state, saves it, and GET never rotates the reader', async t => {
  let seen;
  const h = fixture(t, { generate: async input => { seen = input; return generated(); } }), before = h.core.snapshot();
  assert.equal(h.canvas.read(h.core.connectionId).document, null);
  const result = await h.canvas.edit(h.input({ selectionId: 'intro' }));
  assert.equal(seen.html, html()); assert.equal(seen.selectionId, 'intro'); assert.equal(seen.model, 'qwen');
  assert.equal(result.document.revision, 1); assert.equal(result.document.html, changed); assert.match(result.document.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(result.metrics.providerMs, 4); assert.match(result.metrics.numericCheckScope, /not proved/);
  assert.deepEqual(h.core.snapshot(), before); assert.equal(h.core.connectionId, h.session.connectionId);
  assert.equal(h.canvas.read(h.core.connectionId).document.html, changed);
  assert.equal(fs.statSync(path.join(h.dataDir, 'canvas.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(path.join(h.dataDir, 'canvas.json'), 'utf8'), /test-secret|reasoning|connectionId/);
});

test('explanation-only canvas turns keep source but receive a fresh revision and require a new ACK', async t => {
  const h = fixture(t); const first = await h.canvas.edit(h.input()); h.canvas.ack(h.identity(first.document));
  h.canvas.generate = async () => generated({ html: null, narration: 'This curve has a changing slope.', focusId: 'new-section' });
  const second = await h.canvas.edit(h.input());
  assert.equal(second.document.html, first.document.html); assert.equal(second.document.sourceHash, first.document.sourceHash);
  assert.equal(second.document.revision, 2); assert.equal(second.document.narration, 'This curve has a changing slope.');
  await assert.rejects(h.canvas.speech(h.identity(second.document)), error => error.code === 'CANVAS_NOT_ACKNOWLEDGED');
});

test('canvas rejects invalid seeds, stale revisions/selections and unsafe output before replacing accepted source', async t => {
  let calls = 0; const h = fixture(t, { generate: async () => { calls++; return generated(); } });
  await assert.rejects(h.canvas.edit(h.input({ selectionId: 'missing' })), error => error.code === 'CANVAS_UNKNOWN_SELECTION');
  await assert.rejects(h.canvas.edit(h.input({ canvasRevision: 1 })), error => error.code === 'CANVAS_STALE_REVISION');
  assert.equal(calls, 0); const accepted = await h.canvas.edit(h.input());
  await assert.rejects(h.canvas.edit(h.input({ html: html() })), error => error.code === 'CANVAS_INVALID_SEED');
  h.canvas.generate = async () => generated({ html: html('<script>bad()</script>') });
  await assert.rejects(h.canvas.edit(h.input()), error => error.code === 'CANVAS_INVALID_HTML');
  assert.deepEqual(h.canvas.read(h.core.connectionId).document, accepted.document);
  h.canvas.generate = async () => generated({ focusId: 'missing' });
  await assert.rejects(h.canvas.edit(h.input()), error => error.code === 'CANVAS_UNKNOWN_FOCUS');
});

test('canvas numerical checks accept coefficients above ten but only verify declared supported values', async t => {
  let reference;
  const page = html('<section id="answer"><p data-math-key="slope" data-math-value="60">60</p><svg viewBox="0 0 10 10"><path d="M 0 9 L 9 0"/></svg></section>');
  const h = fixture(t, { generate: async args => { reference = args.reference; return generated({ html: page, focusId: 'answer' }); } });
  const result = await h.canvas.edit(h.input({ question: 'Change f(x) to 20x cubed. Show the graph.' }));
  assert.equal(reference.a, 20); assert.equal(reference.endY, 160); assert.equal(reference.error, 80);
  assert.equal(result.metrics.checkedNumericClaims, 1);
  h.canvas.generate = async () => generated({ html: page.replace('data-math-value="60"', 'data-math-value="40"'), focusId: 'answer' });
  await assert.rejects(h.canvas.edit(h.input({ question: 'Change f(x) to 20x cubed.' })), error => error.code === 'CANVAS_MATH_MISMATCH');
  assert.equal(h.canvas.read(h.core.connectionId).document.revision, 1);
});

test('coefficient edits derive uncapped reference math and consistent rounded SVG geometry from one current graph', async t => {
  const seed = html('<section id="intro"><svg data-displayed-a="10" data-target-a="10" data-power="3" viewBox="0 0 640 335"><path d="M 0 0 L 1 1"/></svg><p>Earlier function.</p></section>');
  let reference;
  const h = fixture(t, { generate: async args => { reference = args.reference; return generated(); } });
  await h.canvas.edit(h.input({ html: seed, question: 'Change the coefficient to 15 and explain what changes.' }));
  assert.equal(reference.a, 15); assert.equal(reference.power, 3); assert.equal(reference.y, 15);
  assert.equal(reference.slope, 45); assert.equal(reference.endY, 120); assert.equal(reference.tangentEndY, 60); assert.equal(reference.error, 60);
  const g = reference.graph, round = value => Math.round(value * 100) / 100;
  const px = x => round(g.plot.left + (x + 1) / 3 * (g.plot.right - g.plot.left));
  const py = y => round(g.plot.bottom - (y - g.yMin) / (g.yMax - g.yMin) * (g.plot.bottom - g.plot.top));
  assert.equal(g.viewBox, '0 0 640 335'); assert.equal(g.curvePoints.length, 41);
  assert.deepEqual(g.markedPoint, { cx: px(1), cy: py(15) }); assert.deepEqual(g.endpoint, { cx: px(2), cy: py(120) });
  assert.deepEqual(g.tangent, { x1: px(-1), y1: py(-75), x2: px(2), y2: py(60) });
  for (const point of g.curvePoints) assert.deepEqual(point, { x: point.x, cx: px(point.x), cy: py(15 * point.x ** 3) });
  assert.equal(g.curvePath.split(' ').length, 41);
  assert(g.curvePoints.some(point => point.x === 0)); assert(g.curvePoints.some(point => point.x === 1));
});

test('coefficient reference declines missing, conflicting or multiple source graphs rather than inventing a power', async t => {
  for (const body of ['<p id="intro">No graph metadata.</p>',
    '<svg data-displayed-a="10" data-target-a="15" data-power="3"></svg>',
    '<svg data-displayed-a="10" data-power="3"></svg><svg data-displayed-a="10" data-power="2"></svg>']) {
    let reference = 'not called';
    const h = fixture(t, { generate: async args => { reference = args.reference; return generated(); } });
    await h.canvas.edit(h.input({ html: html(body), question: 'Change the coefficient to 15.' }));
    assert.equal(reference, null);
  }
});

test('new canvas edits supersede old work; late results and explicit cancellation cannot commit', async t => {
  const old = deferred(); let firstSignal, calls = 0;
  const h = fixture(t, { generate: args => { if (++calls === 1) { firstSignal = args.signal; return old.promise; } return generated(); } });
  const first = h.canvas.edit(h.input()); const rejected = assert.rejects(first, error => error.code === 'CANVAS_CANCELLED');
  const second = await h.canvas.edit(h.input()); await rejected;
  assert.equal(firstSignal.aborted, true); old.resolve(generated({ html: html(), focusId: 'intro' })); await tick();
  assert.deepEqual(h.canvas.read(h.core.connectionId).document, second.document);
  const pending = deferred(); h.canvas.generate = () => pending.promise;
  const third = h.canvas.edit(h.input()); const cancelled = assert.rejects(third, error => error.code === 'CANVAS_CANCELLED');
  h.canvas.cancel(h.core.connectionId); await cancelled; pending.resolve(generated()); await tick();
  assert.equal(h.canvas.read(h.core.connectionId).document.revision, 1);
});

test('canvas detects core state changes, owner replacement and caller cancellation even if a generator ignores abort', async t => {
  for (const change of ['state', 'owner', 'caller']) {
    const pending = deferred(); let signal;
    const h = fixture(t, { generate: args => { signal = args.signal; return pending.promise; } });
    const caller = new AbortController(), promise = h.canvas.edit(h.input(), { signal: caller.signal });
    const rejected = assert.rejects(promise, error => ['CANVAS_CANCELLED', 'CANVAS_STALE'].includes(error.code));
    if (change === 'state') h.core.control({ connectionId: h.core.connectionId, action: 'page', pageId: 'p2' });
    else if (change === 'owner') h.replaceCore(); else caller.abort();
    await rejected; assert.equal(signal.aborted, true); pending.resolve(generated()); await tick();
    assert.equal(h.canvas.pages.size, 0); assert.equal(fs.existsSync(path.join(h.dataDir, 'canvas.json')), false);
  }
});

test('canvas deadline rejects an uncooperative provider without losing accepted data', async t => {
  const h = fixture(t, { timeoutMs: 10 }); const accepted = await h.canvas.edit(h.input());
  h.canvas.generate = () => new Promise(() => {});
  await assert.rejects(h.canvas.edit(h.input()), error => error.code === 'CANVAS_TIMEOUT');
  assert.deepEqual(h.canvas.read(h.core.connectionId).document, accepted.document);
});

test('canvas persistence failure preserves memory, source and undo history atomically', async t => {
  const h = fixture(t); const accepted = await h.canvas.edit(h.input());
  const before = fs.readFileSync(path.join(h.dataDir, 'canvas.json'), 'utf8');
  fs.mkdirSync(path.join(h.dataDir, 'canvas.json.tmp'));
  await assert.rejects(h.canvas.edit(h.input()), error => error.code === 'CANVAS_SAVE_FAILED');
  assert.deepEqual(h.canvas.read(h.core.connectionId).document, accepted.document);
  assert.equal(fs.readFileSync(path.join(h.dataDir, 'canvas.json'), 'utf8'), before);
});

test('canvas reload restores source/history without speech authorization; undo restores source with a new monotonic revision', async t => {
  const h = fixture(t); let accepted;
  for (let index = 0; index < 7; index++) {
    h.canvas.generate = async () => generated({ html: html(`<p id="entry">Revision ${index}</p>`), title: `Edit ${index}`, focusId: 'entry' });
    accepted = await h.canvas.edit(h.input());
  }
  assert.equal([...h.canvas.pages.values()][0].history.length, 5);
  h.canvas.ack(h.identity(accepted.document));
  const reloaded = new StudioCanvas({ dataDir: h.dataDir, getCore: () => h.core, speechImpl: { synthesize: async () => Buffer.from('WAV') } });
  assert.deepEqual(reloaded.read(h.core.connectionId).document, accepted.document);
  await assert.rejects(reloaded.speech(h.identity(accepted.document)), error => error.code === 'CANVAS_NOT_ACKNOWLEDGED');
  const undone = reloaded.undo(h.identity(accepted.document));
  assert.equal(undone.document.revision, 8); assert.match(undone.document.html, /Revision 5/);
  assert.throws(() => reloaded.ack(h.identity(accepted.document)), error => error.code === 'CANVAS_STALE_REVISION');
});

test('canvas ACK binds exact source and speech derives only stored narration; state changes cancel pending audio', async t => {
  let spoken, speechSignal; const audio = deferred();
  const h = fixture(t, { speechImpl: { synthesize: (text, { signal }) => { spoken = text; speechSignal = signal; return audio.promise; } } });
  const accepted = await h.canvas.edit(h.input()), identity = h.identity(accepted.document);
  await assert.rejects(h.canvas.speech(identity), error => error.code === 'CANVAS_NOT_ACKNOWLEDGED');
  assert.throws(() => h.canvas.ack({ ...identity, sourceHash: 'fake' }), error => error.code === 'CANVAS_STALE_SOURCE');
  h.canvas.ack(identity);
  const speech = h.canvas.speech({ ...identity, text: 'DO NOT SPEAK THIS' });
  const rejected = assert.rejects(speech, error => error.code === 'CANVAS_CANCELLED');
  assert.equal(spoken, output().narration); assert.doesNotMatch(spoken, /redesigned lesson|DO NOT/);
  h.core.control({ connectionId: h.core.connectionId, action: 'cancel' });
  await rejected; assert.equal(speechSignal.aborted, true); audio.resolve(Buffer.from('late'));
});

async function httpFixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-http-'));
  const app = createStudioServer({ dataDir, port: 0, keyConfigured: false, canvasGenerateImpl: async () => generated(),
    generateImpl: async () => { throw Error('Old provider must not run'); }, speechImpl: { available: true, synthesize: async () => Buffer.from('RIFF_canvas_WAVE') },
    transcriptionImpl: { available: false }, ...options });
  await app.listen(); const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(done => { app.server.once('close', done); app.close(); }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const session = await (await fetch(base + '/api/session')).json();
  const anchor = () => ({ connectionId: app.core.connectionId, revision: app.core.state.revision, viewEpoch: app.core.state.viewEpoch, pageId: app.core.state.pageId, selectedId: app.core.state.selectedId });
  const post = (route, body, options = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
  return { app, base, session, anchor, post, input: () => ({ anchor: anchor(), canvasRevision: 0, html: html(), question: 'Redesign this page.', selectionId: 'intro' }) };
}

test('HTTP canvas preserves reader/core state, returns full source and gates native narration on exact visible ACK', async t => {
  let spoken; const h = await httpFixture(t, { speechImpl: { available: true, synthesize: async text => { spoken = text; return Buffer.from('RIFF_canvas_WAVE'); } } });
  const before = h.app.core.snapshot(), connection = h.app.core.connectionId;
  assert.equal((await fetch(h.base + '/api/canvas?connectionId=wrong')).status, 409);
  const initial = await (await fetch(h.base + `/api/canvas?connectionId=${connection}`)).json(); assert.equal(initial.document, null);
  assert.equal(h.app.core.connectionId, connection); assert.equal(h.session.config.canvas, true);
  const response = await h.post('/api/canvas/edit', h.input()); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.document.html, changed); assert.deepEqual(h.app.core.snapshot(), before);
  const identity = { anchor: h.anchor(), canvasRevision: 1, sourceHash: result.document.sourceHash };
  assert.equal((await h.post('/api/canvas/speech', identity)).status, 409);
  assert.equal((await h.post('/api/canvas/ack', identity)).status, 200);
  const audio = await h.post('/api/canvas/speech', { ...identity, narration: 'Caller injection' });
  assert.equal(audio.status, 200); assert.equal(audio.headers.get('content-type'), 'audio/wav'); assert.equal(spoken, output().narration);
  const undo = await h.post('/api/canvas/undo', identity); assert.equal(undo.status, 200); assert.equal((await undo.json()).document.html, html());
  assert.equal((await h.post('/api/canvas/speech', identity)).status, 409);
});

test('HTTP canvas cancels on core view changes, browser reload and explicit cancel', async t => {
  for (const change of ['state', 'reload', 'cancel']) {
    const started = deferred(), pending = deferred(); let signal;
    const h = await httpFixture(t, { canvasGenerateImpl: args => { signal = args.signal; started.resolve(); return pending.promise; } });
    const response = h.post('/api/canvas/edit', h.input()); await started.promise;
    if (change === 'state') await h.post('/api/control', { connectionId: h.app.core.connectionId, action: 'page', pageId: 'p2' });
    else if (change === 'reload') await fetch(h.base + '/api/session');
    else await h.post('/api/canvas/cancel', { connectionId: h.app.core.connectionId });
    assert.equal((await response).status, 409); assert.equal(signal.aborted, true); pending.resolve(generated()); await tick();
    const saved = await (await fetch(h.base + `/api/canvas?connectionId=${h.app.core.connectionId}`)).json(); assert.equal(saved.document, null);
  }
});

test('HTTP response disconnect aborts canvas work without treating a normal POST body completion as cancellation', async t => {
  const started = deferred(), pending = deferred(); let signal;
  const h = await httpFixture(t, { canvasGenerateImpl: args => { signal = args.signal; started.resolve(); return pending.promise; } });
  const caller = new AbortController();
  const response = h.post('/api/canvas/edit', h.input(), { signal: caller.signal });
  const aborted = assert.rejects(response, error => error.name === 'AbortError');
  await started.promise; assert.equal(signal.aborted, false); caller.abort(); await aborted;
  for (let index = 0; index < 30 && !signal.aborted; index++) await new Promise(done => setTimeout(done, 5));
  assert.equal(signal.aborted, true); pending.resolve(generated());
});
