import test from 'node:test';
import assert from 'node:assert/strict';
import lesson from '../studio/course/lesson.json' with { type: 'json' };
import { StudioCore, computeFacts } from '../studio/core.js';
import { computeExample, expressionFor, formatFunction, parseFunctionCode, materialFor, sceneForStep } from '../studio/public/math.js';
import { validateUnit, unitSchema, buildPrompt } from '../studio/provider.js';
import { StudioBridge } from '../studio/bridge.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const output = (facts = computeFacts(10, 3), overrides = {}) => ({ unit: {
  title: 'The changed function', text: 'The new cubic has slope 30 at x equals one. Its tangent reaches 40 while the curve reaches 80 at x equals two.',
  kind: 'extension', sourceIds: ['source.local'], focusId: 'p1.derivative',
  scene: { tangent: true, secant: false, comparison: true },
  note: { targetId: 'p1.derivative', text: 'The endpoint vertical gap is 40, not an area.' },
  claims: Object.entries(facts).map(([key, value]) => ({ key, value })), reviewReason: null,
  functionCode: expressionFor(facts.a, facts.power), ...overrides
}, metadata: { providerId: 'fake-function-test' } });
function fixture(t, generate = async () => output(), options = {}) {
  const core = new StudioCore({ lesson, generate, ...options });
  const { connectionId } = core.session();
  t.after(() => core.invalidate('TEST_END'));
  const ask = question => { const state = core.snapshot(); return core.ask({ connectionId, question, clientTurnId: 'function-test',
    revision: state.revision, viewEpoch: state.viewEpoch, pageId: state.pageId, selectedId: state.selectedId }); };
  const ack = turnId => core.ack({ connectionId, turnId, revision: core.state.revision, clientTurnId: 'function-test', renderedMs: 12 });
  return { core, connectionId, ask, ack };
}

test('trusted shared monomial computation gives exact cubic points, tangent and finite changes without eval', () => {
  assert.deepEqual(computeExample(10, 3), { a: 10, power: 3, x: 1, endX: 2, y: 10, endY: 80, slope: 30,
    tangentEndY: 40, curveChange: 70, tangentChange: 30, secantSlope: 70, error: 40 });
  assert.equal(computeExample(0.5, 5).endY, 16);
  assert.equal(computeExample(10, 1).error, 0);
  assert.equal(formatFunction(10, 3), 'f(x) = 10x³');
  assert.equal(expressionFor(10, 3), '10*x**3');
  assert.deepEqual(parseFunctionCode(' 10 * x ** 3 '), { a: 10, power: 3 });
  for (const source of ['10*x**3;process.exit()', 'Math.pow(x,3)', '10*x**3+1', '10*x**6', '0*x**3', '11*x**3', 'x.constructor', '10*x**2.5', '10*x**03']) assert.throws(() => parseFunctionCode(source));
});

test('explicit function instructions and actual Whisper phrasing bind a cubic candidate without changing the graph early', async t => {
  const prompts = ['Change f(x) to 10x cubed', 'Change the function to ten x cubed', 'Set f(x) = 10*x**3',
    'Change fx to 10 x cubed', 'Change f(x) to 10x³ and explain what changes.',
    'Change f of x to 10x cubed. Show the tangent and the finite step comparison.',
    'Change f(x) to 10x cubed. Show the tangent and the finite-step comparison, and add a short note explaining the new function.'];
  for (const prompt of prompts) {
    const pending = deferred(); let snapshot;
    const h = fixture(t, args => { snapshot = args.snapshot; return pending.promise; });
    const { turnId } = h.ask(prompt);
    assert.deepEqual(snapshot.candidateFacts, computeFacts(10, 3), prompt);
    assert.equal(snapshot.candidateFunctionCode, '10*x**3');
    assert.equal(snapshot.facts.power, 2);
    assert.equal(h.core.state.pages.p1.functionCode, '1*x**2');
    assert.equal(h.core.state.pages.p1.notes.length, 0);
    assert.equal(snapshot.candidatePage.materialKind, 'program-derived');
    assert.equal(snapshot.candidatePage.quiz, undefined);
    pending.resolve(output(undefined, { functionCode: ' 10 * x ** 3 ' })); await tick();
    assert.equal(h.core.state.pages.p1.a, 10); assert.equal(h.core.state.pages.p1.power, 3);
    assert.equal(h.core.state.pages.p1.functionCode, ' 10 * x ** 3 ', 'Keep the actual validated model source.');
    assert.equal(h.core.state.pages.p1.notes.length, 1);
    assert.equal(h.core.latestCompleted, null); assert.equal(h.core.audioAnchor, null);
    assert.equal(h.ack(turnId).unit.functionCode, ' 10 * x ** 3 ');
  }
});

test('unsupported or conflicting function syntax fails before model work and preserves an active turn', t => {
  const pending = deferred(); let calls = 0;
  const h = fixture(t, () => { calls++; return pending.promise; });
  h.ask('Explain the current function.'); const active = h.core.active, before = h.core.snapshot();
  for (const prompt of ['Change f(x) to 10x cubed plus one', 'Change f(x) to sin(x)', 'Change f(x) to 10*x**6',
    'Change f(x) to 11x cubed', 'Change f(x) to 0x cubed', 'Change f(x) to 10*x**3+1',
    'Change f(x) to 10x cubed or five x squared', 'Change f(x) to 10x cubed. Change the function to 3x squared.',
    'Set a to three and change f(x) to 10x cubed', 'Restore the quadratic function to cubic',
    'Change f(x) to 10x cubed, plus one.', 'Change f(x) to 10*x**3; +1', 'Change f(x) to 10x cubed and add x.',
    'Change f(x) to 10x cubed. Explain the slope, and add x.', 'Restore the quadratic function, minus one.']) {
    assert.throws(() => h.ask(prompt), undefined, prompt);
    assert.deepEqual(h.core.snapshot(), before); assert.equal(h.core.active, active);
    assert.equal(active.abort.signal.aborted, false);
  }
  assert.equal(calls, 1);
});

test('all cubic followups require extension or review labels, including coefficient-only edits and bridge context', async t => {
  let responseKind = 'extension';
  const h = fixture(t, async ({ snapshot }) => output(snapshot.candidateFacts ?? snapshot.facts, {
    kind: responseKind, functionCode: snapshot.candidateFunctionCode,
    reviewReason: responseKind === 'needs_review' ? 'The requested interpretation needs review.' : null,
    note: null
  }));
  const turn = h.ask('Change f(x) to 10x cubed'); await tick(); h.ack(turn.turnId);
  responseKind = 'grounded';
  for (const prompt of ['Explain the slope again.', 'Change the coefficient to four and explain.']) {
    const before = structuredClone(h.core.state.pages.p1);
    h.ask(prompt); await tick();
    assert.equal(h.core.records.at(-1).code, 'UNSUPPORTED_GROUNDING');
    assert.deepEqual(h.core.state.pages.p1, before);
  }
  responseKind = 'needs_review';
  const reviewed = h.ask('Explain an unsupported interpretation.'); await tick(); h.ack(reviewed.turnId);
  const bridge = new StudioBridge({ getCore: () => h.core, hasPeer: () => true, sendCommand: () => {} });
  assert.match(bridge.context().lesson.sources[0].title, /quadratic foundation.*program-derived/);
  assert.equal(bridge.context().facts.power, 3);
  assert.deepEqual(h.core.lesson.sources, lesson.sources, 'Source annotations must not rewrite the canonical lesson.');
});

test('built-in prepared steps reveal their required scene before speech while preserving cubic source and notes', async t => {
  const h = fixture(t);
  const turn = h.ask('Change f(x) to 10x cubed'); await tick(); h.ack(turn.turnId);
  const payload = h.core.exportSession();
  for (const content of Object.values(payload.state.pages)) {
    content.a = 10; content.power = 3; content.functionCode = '10*x**3';
  }
  h.core.restoreSession(payload);
  const notes = structuredClone(h.core.state.pages.p1.notes);
  for (const page of lesson.pages) {
    h.core.control({ connectionId: h.connectionId, action: 'page', pageId: page.id });
    for (let index = 0; index < page.steps.length; index++) {
      const result = h.core.control({ connectionId: h.connectionId, action: index ? 'next' : 'start' });
      assert.deepEqual(result.state.pages[page.id].scene, sceneForStep(result.step.id));
      assert.equal(result.state.pages[page.id].functionCode, '10*x**3');
      assert.equal(h.core.audioAnchor.phase, 'ready');
      if (result.step.id === 'p1.s3') { assert.equal(result.state.pages.p1.scene.tangent, true); assert.match(result.step.text, /40/); }
      if (result.step.id === 'p2.s3') assert.equal(result.state.pages.p2.scene.secant, true);
    }
  }
  assert.deepEqual(h.core.state.pages.p1.notes, notes);
  assert.deepEqual(h.core.lesson, { ...lesson, example: { ...lesson.example, maxA: 10 } });
  h.core.control({ connectionId: h.connectionId, action: 'page', pageId: 'p1' });
  h.core.control({ connectionId: h.connectionId, action: 'start' });
  h.core.control({ connectionId: h.connectionId, action: 'next' });
  const pending = deferred(); h.core.generate = () => pending.promise;
  h.ask('Pause to explain this.');
  const continued = h.core.control({ connectionId: h.connectionId, action: 'continue' });
  assert.equal(continued.step.id, 'p1.s2'); assert.equal(continued.state.pages.p1.scene.tangent, true);
  assert.match(continued.step.text, /30/);
});

test('prepared controls never impose bundled scene changes on a custom authored pack', t => {
  const custom = structuredClone(lesson); custom.pages[0].blocks[0].text = 'An authored explanation.';
  const h = fixture(t, async () => output(), { lesson: custom });
  const before = structuredClone(h.core.state.pages.p1.scene);
  for (const action of ['start', 'next', 'next', 'continue']) {
    const result = h.core.control({ connectionId: h.connectionId, action });
    assert.deepEqual(result.state.pages.p1.scene, before);
  }
});

test('hypothetical and negated function requests do not authorize source edits', async t => {
  for (const prompt of ['What if f(x) were 10x cubed?', 'Do not change f(x) to 10x cubed.', 'Could a cubic have a different slope?', 'Change it to ten x cubed.']) {
    let snapshot;
    const h = fixture(t, async args => { snapshot = args.snapshot; return output(computeFacts(1), { functionCode: '10*x**3' }); });
    h.ask(prompt); await tick();
    assert.equal(snapshot.candidateFacts, null); assert.equal(snapshot.candidateFunctionCode, null);
    assert.equal(h.core.records.at(-1).code, 'UNREQUESTED_FUNCTION');
    assert.equal(h.core.state.pages.p1.functionCode, '1*x**2');
  }
});

test('wrong source, unsafe source, missing source, false grounding and wrong claims reject the complete function edit', async t => {
  for (const overrides of [{ functionCode: '10*x**2' }, { functionCode: '10*x**3;alert(1)' }, { functionCode: null },
    { kind: 'grounded' }, { claims: [{ key: 'slope', value: 20 }] }]) {
    const h = fixture(t, async () => output(undefined, overrides));
    h.ask('Change f(x) to 10x cubed'); await tick();
    assert.equal(h.core.records.at(-1).status, 'failed');
    assert.deepEqual(h.core.state.pages.p1, { a: 1, power: 2, functionCode: '1*x**2',
      scene: { tangent: false, secant: false, comparison: false }, notes: [] });
    assert.equal(h.core.undoStack.length, 0);
  }
});

test('cubic state, exact source, notes and progress survive export/import; legacy pages default to power two', async t => {
  const h = fixture(t);
  h.core.control({ connectionId: h.connectionId, action: 'start' });
  h.core.control({ connectionId: h.connectionId, action: 'next' });
  const { turnId } = h.ask('Change the function to ten x cubed'); await tick(); h.ack(turnId);
  const payload = h.core.exportSession();
  const restored = fixture(t, async () => output(), { savedState: payload.state });
  assert.deepEqual(restored.core.state.pages, payload.state.pages);
  assert.deepEqual(restored.core.state.cursor, payload.state.cursor);
  assert.deepEqual(restored.core.state.resumePoint, payload.state.resumePoint);
  const resumed = restored.core.control({ connectionId: restored.connectionId, action: 'continue' });
  assert.equal(resumed.step.id, 'p1.s2'); assert.match(resumed.step.text, /30/); assert.doesNotMatch(resumed.step.text, /two times a/);
  assert.match(restored.core.context(null).selectedBlock.formula, /30/);
  assert.match(restored.core.context(null).sources[0].title, /program-derived/);
  const before = restored.core.snapshot();
  for (const mutate of [s => { s.pages.p1.functionCode = '10*x**2'; }, s => { s.pages.p1.power = 6; }]) {
    const bad = structuredClone(payload); mutate(bad.state);
    assert.throws(() => restored.core.restoreSession(bad)); assert.deepEqual(restored.core.snapshot(), before);
  }
  const legacy = fixture(t).core.exportSession();
  for (const page of Object.values(legacy.state.pages)) { delete page.power; delete page.functionCode; }
  restored.core.restoreSession(legacy);
  assert.equal(restored.core.state.pages.p1.power, 2); assert.equal(restored.core.state.pages.p1.functionCode, '1*x**2');
});

test('coefficient changes preserve the active power, restoration changes it explicitly, and undo restores exact source', async t => {
  const h = fixture(t, async ({ snapshot }) => output(snapshot.candidateFacts, {
    functionCode: snapshot.candidateFunctionCode, note: null,
    kind: snapshot.candidateFacts.power === 2 ? 'grounded' : 'extension'
  }));
  let turn = h.ask('Change f(x) to 10x cubed'); await tick(); h.ack(turn.turnId);
  h.core.control({ connectionId: h.connectionId, action: 'parameter', a: 3 });
  assert.equal(h.core.state.pages.p1.functionCode, '3*x**3');
  turn = h.ask('Change the coefficient to four and explain.'); await tick(); h.ack(turn.turnId);
  assert.equal(h.core.state.pages.p1.functionCode, '4*x**3');
  assert.equal(h.core.context(null).facts.slope, 12);
  turn = h.ask('Restore the quadratic function and explain what changes.'); await tick(); h.ack(turn.turnId);
  assert.equal(h.core.state.pages.p1.functionCode, '4*x**2');
  h.core.control({ connectionId: h.connectionId, action: 'undo' });
  assert.equal(h.core.state.pages.p1.functionCode, '4*x**3'); assert.equal(h.core.state.pages.p1.power, 3);
});

test('changed-power material removes quadratic-only formulas and quiz, handles linear case, and preserves canonical authored pages', () => {
  const before = structuredClone(lesson.pages);
  for (const page of lesson.pages) {
    const cubic = materialFor(page, computeFacts(10, 3));
    assert.equal(cubic.quiz, undefined); assert.equal(cubic.materialKind, 'program-derived');
    assert.doesNotMatch(JSON.stringify(cubic), /2a|3a|4a|ah²|quadratic term|two times a/);
    const linear = materialFor(page, computeFacts(3, 1));
    assert.match(JSON.stringify(linear), /linear|coincide|constant/);
    assert.deepEqual(materialFor(page, computeFacts(3, 2)), page);
  }
  assert.deepEqual(lesson.pages, before);
});

test('custom authored packs keep their formulas and reject nonquadratic state or live edits before generation', t => {
  const custom = structuredClone(lesson); custom.pages[0].blocks[0].text = 'An independently authored quadratic explanation.';
  let called = false; const h = fixture(t, () => { called = true; }, { lesson: custom });
  assert.throws(() => h.ask('Change f(x) to 10x cubed'), error => error.code === 'UNSUPPORTED_FUNCTION_LESSON');
  assert.equal(called, false); assert.equal(h.core.material().blocks[0].text, custom.pages[0].blocks[0].text);
  const state = h.core.snapshot(); state.pages.p1.power = 3; state.pages.p1.functionCode = '1*x**3';
  assert.throws(() => new StudioCore({ lesson: custom, generate: async () => output(), savedState: state }));
});

test('provider requires nullable function source, accepts every numeric fact including power and explains generalized context', () => {
  assert(unitSchema.required.includes('functionCode'));
  assert.equal(validateUnit(output().unit).functionCode, '10*x**3');
  const missing = output().unit; delete missing.functionCode; assert.throws(() => validateUnit(missing));
  assert.throws(() => validateUnit(output(undefined, { functionCode: '10*x**3+1' }).unit));
  const prompt = buildPrompt('Change f(x) to 10x cubed', { facts: computeFacts(1), candidateFacts: computeFacts(10, 3), candidateFunctionCode: '10*x**3' });
  assert.match(prompt, /candidateFunctionCode/); assert.match(prompt, /kind=extension/);
  assert.match(prompt, /power 2 only/i); assert.doesNotMatch(prompt, /the curve changes by 3a and the tangent by 2a/);
});
