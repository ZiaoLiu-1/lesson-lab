import assert from 'node:assert/strict';
import test from 'node:test';
import { StudioCore, StudioError, computeFacts, MAX_STATE_BYTES } from '../studio/core.js';

const lesson = {
  id: 'test-lesson', version: '1.0.0', title: 'Local change', subtitle: 'A prepared quadratic lesson.',
  example: { kind: 'quadratic', initialA: 1, minA: 0.5, maxA: 5 },
  sources: [{ id: 'source.quadratic', title: 'Prepared quadratic facts' }],
  pages: [1, 2].map(number => ({ id: `p${number}`, title: `Page ${number}`, eyebrow: 'Study', summary: 'Explore the curve.',
    blocks: [{ id: `p${number}.curve`, title: 'The curve', text: 'The curve is a times x squared.', formula: 'f(x) = ax²' },
      { id: `p${number}.slope`, title: 'The slope', text: 'The slope at x = 1 is 2a.' }],
    steps: [{ id: `p${number}.s1`, targetId: `p${number}.curve`, text: 'With a = {a}, height is {y} and end height is {endY}.' },
      { id: `p${number}.s2`, targetId: `p${number}.slope`, text: 'Slope {slope}; tangent end {tangentEndY}; curve change {curveChange}; tangent change {tangentChange}; secant {secantSlope}; error {error}.' }],
    quickQuestions: ['Explain the tangent.'] })),
};
const unit = (overrides = {}) => ({ title: 'Local slope', text: 'The derivative describes the local slope at the marked point.',
  kind: 'grounded', sourceIds: ['source.quadratic'], focusId: 'p1.curve',
  scene: { tangent: true, secant: false, comparison: false },
  note: { targetId: 'p1.curve', text: 'The local slope belongs to this point.' },
  claims: [{ key: 'slope', value: 2 }], reviewReason: null, functionCode: null, ...overrides });
const result = overrides => ({ unit: unit(overrides), metadata: { model: 'qwen-3.8-27b', providerId: 'chatcmpl-test', usage: { completion_tokens: 20 } } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(t, options = {}) {
  const events = [], saved = [], records = [];
  const core = new StudioCore({ lesson, generate: async () => result(), persist: state => saved.push(state),
    record: entry => records.push(entry), emit: (name, data) => events.push({ name, data }), ...options });
  const session = core.session();
  t.after(() => core.invalidate('TEST_END'));
  return { core, events, saved, records, connectionId: session.connectionId };
}
function anchor(core, connectionId, extra = {}) {
  const state = core.snapshot();
  return { connectionId, revision: state.revision, viewEpoch: state.viewEpoch, pageId: state.pageId,
    selectedId: state.selectedId, question: 'Explain the current example.', clientTurnId: 'client-turn', ...extra };
}
function acknowledge(core, connectionId, turnId, extra = {}) {
  return core.ack({ connectionId, turnId, revision: core.snapshot().revision, clientTurnId: 'client-turn', renderedMs: 25, ...extra });
}
const errorCode = code => error => error instanceof StudioError && error.code === code;
test('studio rejects draft narration before committing a candidate parameter, note or speech', async t => {
  for (const overrides of [
    { text: '<think>Plan the page change.</think>The slope is 6.' },
    { text: 'I need to generate a final explanation.' },
    { note: { targetId: 'p1.curve', text: 'Analysis: choose a helpful example.' } },
  ]) {
    const { core, connectionId } = setup(t, { generate: async () => result({ claims: [{ key: 'slope', value: 6 }], ...overrides }) });
    const before = structuredClone(core.state.pages);
    core.ask(anchor(core, connectionId, { question: 'Change the coefficient to three.' })); await tick();
    assert.equal(core.records.at(-1).code, 'UNSAFE_NARRATION');
    assert.deepEqual(core.state.pages, before);
    assert.equal(core.audioAnchor, null);
    assert.throws(() => core.speechText(), errorCode('STALE_AUDIO'));
  }
});

test('studio speech uses final narration without repeating its title and never mutates legacy text', async t => {
  const { core, connectionId } = setup(t);
  const { turnId } = core.ask(anchor(core, connectionId)); await tick();
  assert.throws(() => core.speechText(), errorCode('STALE_AUDIO'), 'No speech before visible ACK.');
  acknowledge(core, connectionId, turnId);
  assert.equal(core.speechText(), unit().text);
  assert.equal(core.latestCompleted.unit.title, unit().title);
  const legacyText = '<think>A historical draft.</think>The local slope is 2.';
  core.latestCompleted.unit.text = legacyText;
  assert.equal(core.speechText(), 'The local slope is 2.');
  assert.equal(core.latestCompleted.unit.text, legacyText, 'Playback cleaning does not rewrite the stored historical unit.');
  core.latestCompleted.unit.text = '<think>Only a historical draft.</think>';
  assert.throws(() => core.speechText(), errorCode('UNSAFE_NARRATION'));
  core.control({ connectionId, action: 'continue' });
  assert.equal(core.speechText(), 'With a = 1, height is 1 and end height is 4.');
  core.audio({ connectionId, phase: 'start', stepId: core.preparedStep().id });
  assert.throws(() => core.speechText(), errorCode('STALE_AUDIO'));
});
function stateWithBytes(target) {
  const state = new StudioCore({ lesson, generate: async () => result() }).snapshot();
  const bytes = () => Buffer.byteLength(JSON.stringify(state), 'utf8');
  let index = 0;
  for (const page of [...lesson.pages].reverse()) {
    for (let slot = 0; slot < 100; slot++) {
      const note = { id: `note-fill-${index}`, pageId: page.id, targetId: page.blocks[0].id,
        title: 'Earlier annotation', text: '', kind: 'extension', sourceIds: [], turnId: `fill-${index++}` };
      state.pages[page.id].notes.push(note);
      const remaining = target - bytes();
      assert(remaining > 0, 'The fixture needs room for the next annotation header.');
      const contentBytes = Math.min(12000, remaining);
      note.text = '漢'.repeat(Math.floor(contentBytes / 3)) + 'x'.repeat(contentBytes % 3);
      if (bytes() === target) return state;
    }
  }
  assert.fail('The fixture target exceeded available note capacity.');
}

test('studio facts distinguish local slope, tangent change and actual finite curve change', () => {
  assert.deepEqual(computeFacts(3), { a: 3, power: 2, x: 1, endX: 2, y: 3, endY: 12, slope: 6,
    tangentEndY: 9, curveChange: 9, tangentChange: 6, secantSlope: 9, error: 3 });
  assert.deepEqual(computeFacts(10), { a: 10, power: 2, x: 1, endX: 2, y: 10, endY: 40, slope: 20,
    tangentEndY: 30, curveChange: 30, tangentChange: 20, secantSlope: 30, error: 10 });
  assert.equal(computeFacts(0.5).y, 0.5);
  for (const value of [0.49, 10.01, NaN, Infinity, '3', null]) assert.throws(() => computeFacts(value), errorCode('INVALID_PARAMETER'));
});

test('studio session and snapshots are detached from canonical lesson and persisted state', t => {
  const { core, saved, connectionId } = setup(t);
  const snapshot = core.snapshot(); snapshot.pages.p1.a = 5;
  saved.at(-1).pages.p1.a = 4;
  const exported = core.exportSession(); exported.lesson.pages[0].blocks[0].text = 'Changed outside the core';
  assert.equal(core.snapshot().pages.p1.a, 1);
  assert.equal(core.exportSession().lesson.pages[0].blocks[0].text, lesson.pages[0].blocks[0].text);
  assert.doesNotThrow(() => core.authorize(connectionId));
});

test('studio passes the actual page, selection, notes, scene and separate undisplayed candidate to generation', async t => {
  const pending = deferred(); let context;
  const { core, connectionId } = setup(t, { generate: args => { context = args; return pending.promise; } });
  core.control({ connectionId, action: 'select', selectedId: 'p1.slope' });
  const { turnId } = core.ask(anchor(core, connectionId, { question: 'Set a to 3 and show the tangent.' }));
  assert.equal(context.model, 'qwen');
  assert.equal(context.snapshot.page.id, 'p1');
  assert.equal(context.snapshot.selectedBlock.id, 'p1.slope');
  assert.deepEqual(context.snapshot.sources, lesson.sources);
  assert.equal(context.snapshot.facts.a, 1);
  assert.equal(context.snapshot.candidateFacts.a, 3);
  assert.equal(context.snapshot.state.pages.p1.a, 1);
  assert.equal(core.snapshot().pages.p1.a, 1);
  assert.equal(context.snapshot.state.cursor.stepIndex, 0);
  assert.equal(context.snapshot.conversation.at(-1).role, 'user');
  pending.resolve(result({ focusId: 'p1.slope', claims: [{ key: 'slope', value: 6 }, { key: 'curveChange', value: 9 }] }));
  await tick();
  assert.equal(core.snapshot().pages.p1.a, 3);
  const ack = acknowledge(core, connectionId, turnId);
  assert.equal(ack.turnId, turnId);
  assert.equal(ack.unit.title, 'Local slope');
  assert.equal(ack.metrics.renderedMs, 25);
});

test('studio wrong numerical claims reject the whole candidate, scene and annotation transaction', async t => {
  const { core, connectionId, events, records } = setup(t, { generate: async () => result({ claims: [{ key: 'curveChange', value: 6 }] }) });
  core.ask(anchor(core, connectionId, { question: 'Set a to 3.' }));
  await tick();
  assert.equal(core.snapshot().pages.p1.a, 1);
  assert.equal(core.snapshot().pages.p1.notes.length, 0);
  assert.equal(core.snapshot().pages.p1.scene.tangent, false);
  assert.equal(events.at(-1).data.code, 'MATH_MISMATCH');
  assert.equal(records[0].status, 'failed');
  assert.equal(core.snapshot().conversation.filter(item => item.role === 'assistant').length, 0);
});

test('studio unit validation rejects unsupported sources, cross-page targets and unknown claim keys', async t => {
  for (const [override, code] of [
    [{ sourceIds: ['invented-source'] }, 'UNKNOWN_SOURCE'],
    [{ focusId: 'p2.curve' }, 'UNKNOWN_TARGET'],
    [{ focusId: 'note-invented' }, 'UNKNOWN_TARGET'],
    [{ note: { targetId: 'p2.curve', text: 'Not here.' } }, 'INVALID_NOTE'],
    [{ note: { targetId: 'note-invented', text: 'Not here.' } }, 'INVALID_NOTE'],
    [{ claims: [{ key: 'mystery', value: 2 }] }, 'INVALID_CLAIMS'],
    [{ claims: [{ key: 'slope', value: 2 }, { key: 'slope', value: 2 }] }, 'INVALID_CLAIMS'],
  ]) {
    const { core, connectionId, records } = setup(t, { generate: async () => result(override) });
    core.ask(anchor(core, connectionId)); await tick();
    assert.equal(records[0].code, code);
    assert.equal(core.snapshot().pages.p1.notes.length, 0);
  }
});

test('studio uncertain answers require a reason and cannot change parameters or scenes', async t => {
  const { core, connectionId } = setup(t, { generate: async () => result({ kind: 'needs_review',
    reviewReason: 'The prepared material does not establish that extension.', claims: [] }) });
  const { turnId } = core.ask(anchor(core, connectionId, { question: 'Change a to 4 and explain an unsupported extension.' }));
  await tick();
  assert.equal(core.snapshot().pages.p1.a, 1);
  assert.equal(core.snapshot().pages.p1.scene.tangent, false);
  assert.equal(core.snapshot().pages.p1.notes[0].kind, 'needs_review');
  assert.equal(acknowledge(core, connectionId, turnId).unit.reviewReason, 'The prepared material does not establish that extension.');
  const invalid = setup(t, { generate: async () => result({ kind: 'needs_review', reviewReason: null }) });
  invalid.core.ask(anchor(invalid.core, invalid.connectionId)); await tick();
  assert.equal(invalid.records[0].code, 'MISSING_REVIEW_REASON');
});

test('studio parameter instructions reject malformed, out-of-range and conflicting requests before generation', t => {
  let calls = 0;
  const { core, connectionId } = setup(t, { generate: () => { calls++; return Promise.resolve(result()); } });
  for (const question of ['set a to banana', 'change a to 10.01', 'set a to 3/4', 'set a to 2e0',
    'set a to 3 and change a to 4', 'set a to 2 or 3', 'change a 3', 'set a to 3.5.2',
    'Change the coefficient to zero.', 'Change coefficient a to eleven.', 'Change the coefficient three.',
    'Set a to 3 or four.', 'Change the coefficient to three through five.',
    'Set coefficient to three and change the coefficient a to four.', 'Change coefficient a to three and set a to 4.',
    'Change the coefficient to three point five.', 'Set coefficient a to one hundred.', 'Set a to three and a half.']) {
    const before = core.snapshot();
    assert.throws(() => core.ask(anchor(core, connectionId, { question })), StudioError, question);
    assert.deepEqual(core.snapshot(), before);
  }
  assert.equal(calls, 0);
});

test('studio negated or hypothetical parameter mentions remain plain questions', async t => {
  const seen = [];
  const { core, connectionId } = setup(t, { generate: async args => { seen.push(args.snapshot.candidateFacts); return result(); } });
  const questions = ['Do not set a to 3.', "Don't change a to 4.", 'If a is 5, what would the slope be?', 'Why might I set a to 3?',
    'Do not change the coefficient to three.', 'If the coefficient were three, what would change?', 'Set it to three.', 'Please change it to ten.'];
  for (const question of questions) {
    const { turnId } = core.ask(anchor(core, connectionId, { question })); await tick();
    acknowledge(core, connectionId, turnId);
  }
  assert.deepEqual(seen, questions.map(() => null));
  assert.equal(core.snapshot().pages.p1.a, 1);
});

test('clear spoken coefficient commands support one through ten and retain atomic candidate validation', async t => {
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const targets = ['a', 'coefficient', 'the coefficient', 'coefficient a', 'the coefficient a'];
  const cases = words.map((word, index) => [`Please change ${targets[index % targets.length]} to ${word}, and explain the slope.`, index + 1]);
  cases.push(['Set the coefficient to .5 and explain.', 0.5], ['Change coefficient a to 3.5.', 3.5],
    ['Set a to three and change the coefficient a to 3.', 3]);
  for (const [question, a] of cases) {
    const pending = deferred(); let snapshot;
    const { core, connectionId } = setup(t, { generate: input => { snapshot = input.snapshot; return pending.promise; } });
    const asked = core.ask(anchor(core, connectionId, { question }));
    assert.deepEqual(snapshot.candidateFacts, computeFacts(a), question);
    assert.equal(snapshot.facts.a, 1); assert.equal(core.snapshot().pages.p1.a, 1);
    assert.equal(core.snapshot().pages.p1.notes.length, 0);
    pending.resolve(result({ claims: [{ key: 'a', value: a }, { key: 'slope', value: 2 * a }] }));
    await tick();
    assert.equal(core.snapshot().pages.p1.a, a); assert.equal(core.snapshot().pages.p1.notes.length, 1);
    assert.equal(core.latestCompleted, null, 'A validated commit is still awaiting display ACK.');
    acknowledge(core, connectionId, asked.turnId);
    assert.equal(core.latestCompleted.id, asked.turnId);
  }
  const rejected = setup(t, { generate: async () => result({ claims: [{ key: 'slope', value: 2 }] }) });
  rejected.core.ask(anchor(rejected.core, rejected.connectionId, { question: 'Change the coefficient to three, and explain.' }));
  await tick();
  assert.equal(rejected.records[0].code, 'MATH_MISMATCH');
  assert.equal(rejected.core.snapshot().pages.p1.a, 1); assert.equal(rejected.core.snapshot().pages.p1.notes.length, 0);
});

test('studio hypothetical prose can coexist with actual facts but hypothetical values cannot impersonate current claims', async t => {
  const actual = setup(t, { generate: async () => result({
    text: 'If a were 5, the slope at x = 1 would be 10. The displayed value remains a = 1 with slope 2.',
    claims: [{ key: 'a', value: 1 }, { key: 'slope', value: 2 }], note: null,
  }) });
  const accepted = actual.core.ask(anchor(actual.core, actual.connectionId, { question: 'If a were 5, what would the slope be?' }));
  await tick(); acknowledge(actual.core, actual.connectionId, accepted.turnId);
  assert.equal(actual.core.snapshot().pages.p1.a, 1);
  const falseCurrent = setup(t, { generate: async () => result({ claims: [{ key: 'a', value: 5 }, { key: 'slope', value: 10 }] }) });
  falseCurrent.core.ask(anchor(falseCurrent.core, falseCurrent.connectionId, { question: 'If a were 5, what would the slope be?' }));
  await tick();
  assert.equal(falseCurrent.records[0].code, 'MATH_MISMATCH');
  assert.equal(falseCurrent.core.snapshot().pages.p1.a, 1);
  assert.equal(falseCurrent.core.snapshot().conversation.filter(item => item.role === 'assistant').length, 0);
});

test('studio live annotations can be selected and become actual context and annotation targets', async t => {
  const snapshots = [];
  const { core, connectionId } = setup(t, { generate: async args => {
    snapshots.push(args.snapshot);
    return result({ focusId: args.snapshot.selectedBlock.id,
      note: { targetId: args.snapshot.selectedBlock.id, text: 'A response about the selected passage.' } });
  } });
  const first = core.ask(anchor(core, connectionId)); await tick(); acknowledge(core, connectionId, first.turnId);
  const note = core.snapshot().pages.p1.notes[0];
  core.control({ connectionId, action: 'select', selectedId: note.id });
  const second = core.ask(anchor(core, connectionId)); await tick(); acknowledge(core, connectionId, second.turnId);
  assert.equal(snapshots[1].selectedBlock.id, note.id);
  assert.equal(snapshots[1].selectedBlock.text, note.text);
  assert.equal(snapshots[1].state.pages.p1.notes[0].id, note.id);
  assert.equal(snapshots[1].state.pages.p1.scene.tangent, true);
  assert.equal(core.snapshot().pages.p1.notes[1].targetId, note.id);
});

test('studio reviewing an unknown note preserves active work; a valid flag persists, restores and reaches model context', async t => {
  const pending = deferred(); const contexts = []; let calls = 0; let activeSignal;
  const { core, connectionId, saved, records, events } = setup(t, { generate: args => {
    contexts.push(args.snapshot); calls++;
    if (calls === 2) { activeSignal = args.signal; return pending.promise; }
    return Promise.resolve(result({ note: calls === 1 ? unit().note : null }));
  } });
  const first = core.ask(anchor(core, connectionId)); await tick(); acknowledge(core, connectionId, first.turnId);
  const noteId = core.snapshot().pages.p1.notes[0].id;
  core.ask(anchor(core, connectionId));
  const before = core.snapshot();
  assert.throws(() => core.control({ connectionId, action: 'review_note', noteId: 'note-missing' }), errorCode('UNKNOWN_TARGET'));
  assert.throws(() => core.control({ connectionId, action: 'review_note', noteId: 'p1.curve' }), errorCode('UNKNOWN_TARGET'));
  assert.deepEqual(core.snapshot(), before);
  assert.equal(activeSignal.aborted, false);
  const flagged = core.control({ connectionId, action: 'review_note', noteId }).state;
  assert.equal(activeSignal.aborted, true);
  assert.equal(flagged.pages.p1.notes[0].kind, 'needs_review');
  assert.equal(saved.at(-1).pages.p1.notes[0].kind, 'needs_review');
  assert.equal(events.at(-1).name, 'state');
  assert.equal(records[0].unit.kind, 'grounded', 'Flagging the saved note must preserve the original generated record.');
  pending.resolve(result()); await tick();
  assert.equal(core.snapshot().pages.p1.notes.length, 1, 'The cancelled late answer must not add another note.');
  core.control({ connectionId, action: 'select', selectedId: noteId });
  const next = core.ask(anchor(core, connectionId)); await tick(); acknowledge(core, connectionId, next.turnId);
  assert.equal(contexts.at(-1).selectedBlock.kind, 'needs_review');
  assert.equal(contexts.at(-1).state.pages.p1.notes[0].kind, 'needs_review');
  const restored = setup(t, { savedState: core.snapshot() });
  assert.equal(restored.core.snapshot().pages.p1.notes[0].kind, 'needs_review');
});

test('studio question anchor includes exact selection and cancel invalidates pending transcription with no request', t => {
  const { core, connectionId } = setup(t);
  const captured = anchor(core, connectionId);
  core.control({ connectionId, action: 'cancel' });
  assert(core.snapshot().viewEpoch > captured.viewEpoch);
  assert.throws(() => core.ask(captured), errorCode('STALE_QUESTION'));
  assert.throws(() => core.ask(anchor(core, connectionId, { selectedId: 'p1.slope' })), errorCode('STALE_QUESTION'));
});

test('studio controls abort generation and ignore late results across page, selection, parameter and model changes', async t => {
  for (const input of [{ action: 'page', pageId: 'p2' }, { action: 'select', selectedId: 'p1.slope' },
    { action: 'parameter', a: 4 }, { action: 'model', model: 'gptoss' }, { action: 'cancel' }]) {
    const pending = deferred(); let signal;
    const { core, connectionId, events, records } = setup(t, { generate: args => { signal = args.signal; return pending.promise; } });
    core.ask(anchor(core, connectionId, { question: 'Set a to 3.' }));
    core.control({ connectionId, ...input });
    const after = core.snapshot();
    assert.equal(signal.aborted, true);
    pending.resolve(result({ claims: [{ key: 'slope', value: 6 }] })); await tick();
    assert.deepEqual(core.snapshot(), after);
    assert.equal(events.filter(event => event.name === 'commit').length, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'cancelled');
  }
});

test('studio superseding question preserves one resume cursor and commits only its own response', async t => {
  const pending = [deferred(), deferred()]; let calls = 0;
  const { core, connectionId, records } = setup(t, { generate: () => pending[calls++].promise });
  core.control({ connectionId, action: 'next' });
  const cursor = core.snapshot().cursor;
  const first = core.ask(anchor(core, connectionId));
  const second = core.ask(anchor(core, connectionId, { clientTurnId: 'second-client' }));
  pending[1].resolve(result({ title: 'Latest answer' })); await tick();
  acknowledge(core, connectionId, second.turnId, { clientTurnId: 'second-client' });
  pending[0].resolve(result({ title: 'Old answer' })); await tick();
  assert.deepEqual(core.snapshot().resumePoint, cursor);
  assert.equal(core.snapshot().pages.p1.notes.length, 1);
  assert.equal(core.snapshot().pages.p1.notes[0].title, 'Latest answer');
  assert.deepEqual(records.map(record => [record.turnId, record.status]), [[first.turnId, 'cancelled'], [second.turnId, 'completed']]);
});

test('studio session rotation cancels old connection, generation and audio without replay', async t => {
  const pending = deferred();
  const { core, connectionId } = setup(t, { generate: () => pending.promise });
  core.ask(anchor(core, connectionId));
  const current = core.session();
  assert.notEqual(current.connectionId, connectionId);
  assert.throws(() => core.authorize(connectionId), errorCode('STALE_CONNECTION'));
  pending.resolve(result()); await tick();
  assert.equal(core.snapshot().pages.p1.notes.length, 0);
  assert.equal(core.snapshot().delivery, 'interrupted');
});

test('studio precise ACK gates answer audio and rejects wrong connection, revision, client or duplicate ACK', async t => {
  const pending = deferred();
  const { core, connectionId, records } = setup(t, { generate: () => pending.promise });
  const { turnId } = core.ask(anchor(core, connectionId));
  assert.throws(() => acknowledge(core, connectionId, turnId), errorCode('STALE_ACK'));
  pending.resolve(result()); await tick();
  assert.throws(() => core.audio({ connectionId, turnId, phase: 'start' }), errorCode('STALE_AUDIO'));
  assert.throws(() => acknowledge(core, 'expired', turnId), errorCode('STALE_CONNECTION'));
  assert.throws(() => acknowledge(core, connectionId, turnId, { revision: 0 }), errorCode('STALE_ACK'));
  assert.throws(() => acknowledge(core, connectionId, turnId, { clientTurnId: 'wrong-client' }), errorCode('WRONG_CLIENT_TURN'));
  const ack = acknowledge(core, connectionId, turnId);
  assert.equal(ack.state.pages.p1.notes.length, 1);
  assert.equal(ack.metrics.metadata.providerId, 'chatcmpl-test');
  assert.equal(records[0].status, 'completed');
  assert.throws(() => acknowledge(core, connectionId, turnId), errorCode('STALE_ACK'));
  core.audio({ connectionId, turnId, phase: 'start' });
  assert.equal(core.snapshot().delivery, 'speaking');
  core.audio({ connectionId, turnId, phase: 'end' });
  assert.equal(core.snapshot().delivery, 'done');
  assert.equal(core.snapshot().cursor.delivered, false, 'Answer audio must not complete the interrupted prepared step.');
});

test('studio missing render ACK retains committed content but fails delivery and never permits speech', async t => {
  const { core, connectionId, records } = setup(t, { ackTimeoutMs: 10 });
  const { turnId } = core.ask(anchor(core, connectionId)); await tick();
  await delay(25);
  assert.equal(core.snapshot().pages.p1.notes.length, 1);
  assert.equal(core.snapshot().delivery, 'interrupted');
  assert.equal(core.snapshot().cursor.delivered, false);
  assert.equal(records[0].code, 'RENDER_TIMEOUT');
  assert.throws(() => acknowledge(core, connectionId, turnId), errorCode('STALE_ACK'));
  assert.throws(() => core.audio({ connectionId, turnId, phase: 'start' }), errorCode('STALE_AUDIO'));
});

test('studio independent generation deadline aborts and ignores a provider that resolves after timeout', async t => {
  const pending = deferred(); let signal;
  const { core, connectionId, records } = setup(t, { timeoutMs: 10, generate: args => { signal = args.signal; return pending.promise; } });
  core.ask(anchor(core, connectionId)); await delay(25);
  assert.equal(signal.aborted, true);
  assert.equal(records[0].code, 'REQUEST_TIMEOUT');
  const after = core.snapshot(); pending.resolve(result()); await tick();
  assert.deepEqual(core.snapshot(), after);
  assert.equal(records.length, 1);
});

test('studio provider failures and lifecycle metadata never expose raw errors or response bodies', async t => {
  const secret = 'private-provider-error-and-key';
  const { core, connectionId, events, records } = setup(t, { generate: async ({ onEvent }) => {
    onEvent('response_headers', { apiKey: secret, rawContent: secret, model: 'qwen-3.8-27b', usage: { completion_tokens: 7, raw: secret } });
    throw Object.assign(new Error(secret), { code: secret, cause: secret });
  } });
  core.ask(anchor(core, connectionId)); await tick();
  assert.equal(records[0].code, 'GENERATION_FAILED');
  assert(!JSON.stringify([events, records, core.snapshot()]).includes(secret));
  assert.equal(records[0].metrics.metadata.model, 'qwen-3.8-27b');
});

test('studio actionable provider failures retain only safe usage and configuration metadata', async t => {
  const secret = 'private-error-body';
  const { core, connectionId, events, records } = setup(t, { generate: async () => {
    throw Object.assign(new Error(secret), { code: 'key_missing', metadata: { model: 'qwen-3.8-27b',
      modelReported: null, providerId: null, elapsedMs: 1, raw: secret,
      usage: { completion_tokens: 8192, reasoning_tokens: 8100 }, config: { reasoningEffort: 'low', maxCompletionTokens: 8192, apiKey: secret } } });
  } });
  core.ask(anchor(core, connectionId)); await tick();
  assert.equal(records[0].code, 'KEY_MISSING');
  assert.match(events.at(-1).data.message, /CEREBRAS_API_KEY/);
  assert.equal(records[0].metrics.metadata.usage.completion_tokens, 8192);
  assert.equal(records[0].metrics.metadata.modelReported, null);
  assert.equal(records[0].metrics.metadata.config.maxCompletionTokens, 8192);
  assert(!JSON.stringify([events, records]).includes(secret));
});

test('studio current parameters are interpolated into prepared speech without modifying canonical steps', t => {
  const { core, connectionId } = setup(t);
  core.control({ connectionId, action: 'parameter', a: 3 });
  const start = core.control({ connectionId, action: 'start' });
  assert.equal(start.step.text, 'With a = 3, height is 3 and end height is 12.');
  const next = core.control({ connectionId, action: 'next' });
  assert.equal(next.step.text, 'Slope 6; tangent end 9; curve change 9; tangent change 6; secant 9; error 3.');
  assert.equal(core.exportSession().lesson.pages[0].steps[0].text, lesson.pages[0].steps[0].text);
});

test('studio accepts explicit a = 10 with exact candidate facts and preserves the previous graph until commit', async t => {
  const pending = deferred(); let context;
  const { core, connectionId } = setup(t, { generate: args => { context = args.snapshot; return pending.promise; } });
  const { turnId } = core.ask(anchor(core, connectionId, { question: 'Set a to 10 and compare the heights.' }));
  assert.equal(core.snapshot().pages.p1.a, 1);
  assert.equal(context.facts.a, 1); assert.deepEqual(context.candidateFacts, computeFacts(10));
  pending.resolve(result({ claims: [{ key: 'a', value: 10 }, { key: 'y', value: 10 },
    { key: 'slope', value: 20 }, { key: 'endY', value: 40 }, { key: 'tangentEndY', value: 30 }] }));
  await tick(); acknowledge(core, connectionId, turnId);
  assert.equal(core.snapshot().pages.p1.a, 10);
  const continued = core.control({ connectionId, action: 'continue' });
  assert.equal(continued.step.text, 'With a = 10, height is 10 and end height is 40.');
  const next = core.control({ connectionId, action: 'next' });
  assert.equal(next.step.text, 'Slope 20; tangent end 30; curve change 30; tangent change 20; secant 30; error 10.');
  const saved = core.exportSession();
  const restored = setup(t, { savedState: saved.state });
  assert.equal(restored.core.snapshot().pages.p1.a, 10);
  const before = core.snapshot();
  assert.throws(() => core.control({ connectionId, action: 'parameter', a: 10.01 }), errorCode('INVALID_PARAMETER'));
  assert.deepEqual(core.snapshot(), before);
});

test('studio continue restores the exact interrupted main step without silently advancing it', async t => {
  const { core, connectionId } = setup(t);
  core.control({ connectionId, action: 'start' });
  const next = core.control({ connectionId, action: 'next' });
  core.audio({ connectionId, stepId: next.step.id, phase: 'start' });
  const { turnId } = core.ask(anchor(core, connectionId)); await tick(); acknowledge(core, connectionId, turnId);
  assert.equal(core.snapshot().resumePoint.stepIndex, 1);
  assert.equal(core.snapshot().resumePoint.delivered, false);
  assert.throws(() => core.control({ connectionId, action: 'next' }), errorCode('CONTINUE_FIRST'));
  assert.throws(() => core.audio({ connectionId, stepId: next.step.id, phase: 'end' }), errorCode('STALE_AUDIO'));
  const continued = core.control({ connectionId, action: 'continue' });
  assert.equal(continued.step.id, next.step.id);
  assert.equal(continued.state.cursor.stepIndex, 1);
  assert.equal(continued.state.cursor.delivered, false);
  assert.equal(continued.state.resumePoint, null);
  core.audio({ connectionId, stepId: continued.step.id, phase: 'start' });
  core.audio({ connectionId, stepId: continued.step.id, phase: 'end' });
  assert.equal(core.snapshot().cursor.delivered, true);
});

test('studio queued or speaking prepared audio cancellation never completes a step', t => {
  const { core, connectionId } = setup(t);
  const { step } = core.control({ connectionId, action: 'start' });
  assert.throws(() => core.audio({ connectionId, stepId: step.id, phase: 'end' }), errorCode('AUDIO_ORDER'));
  core.audio({ connectionId, stepId: step.id, phase: 'cancel' });
  assert.equal(core.snapshot().cursor.delivered, false);
  assert.throws(() => core.audio({ connectionId, stepId: step.id, phase: 'start' }), errorCode('AUDIO_ORDER'));
  core.control({ connectionId, action: 'continue' });
  core.audio({ connectionId, stepId: step.id, phase: 'start' });
  core.control({ connectionId, action: 'complete_step', stepId: step.id });
  assert.equal(core.snapshot().cursor.delivered, true);
  assert.throws(() => core.audio({ connectionId, stepId: step.id, phase: 'end' }), errorCode('STALE_AUDIO'));
});

test('studio edits after commit reject late ACK and answer audio without removing the existing note', async t => {
  const { core, connectionId } = setup(t);
  const { turnId } = core.ask(anchor(core, connectionId)); await tick();
  const revision = core.snapshot().revision;
  core.control({ connectionId, action: 'select', selectedId: 'p1.slope' });
  assert.throws(() => acknowledge(core, connectionId, turnId, { revision }), errorCode('STALE_ACK'));
  assert.equal(core.snapshot().pages.p1.notes.length, 1);
  const newer = core.ask(anchor(core, connectionId)); await tick(); acknowledge(core, connectionId, newer.turnId);
  core.control({ connectionId, action: 'model', model: 'gptoss' });
  assert.throws(() => core.audio({ connectionId, turnId: newer.turnId, phase: 'start' }), errorCode('STALE_AUDIO'));
});

test('studio undo restores the previous page content, keeps the conversation and invalidates old audio', async t => {
  const { core, connectionId } = setup(t, { generate: async () => result({ claims: [{ key: 'slope', value: 6 }] }) });
  const baseline = core.snapshot().pages.p1;
  const { turnId } = core.ask(anchor(core, connectionId, { question: 'Set a to 3.' })); await tick(); acknowledge(core, connectionId, turnId);
  const noteId = core.snapshot().pages.p1.notes[0].id;
  core.control({ connectionId, action: 'select', selectedId: noteId });
  const before = core.snapshot();
  const after = core.control({ connectionId, action: 'undo' }).state;
  assert.deepEqual(after.pages.p1, baseline);
  assert.deepEqual(after.conversation, before.conversation);
  assert(after.revision > before.revision && after.viewEpoch > before.viewEpoch);
  assert.equal(after.selectedId, 'p1.curve');
  assert.throws(() => core.audio({ connectionId, turnId, phase: 'start' }), errorCode('STALE_AUDIO'));
  assert.throws(() => core.control({ connectionId, action: 'undo' }), errorCode('NOTHING_TO_UNDO'));
});

test('studio invalid controls do not cancel a valid in-flight answer', async t => {
  const pending = deferred(); let signal;
  const { core, connectionId } = setup(t, { generate: args => { signal = args.signal; return pending.promise; } });
  const { turnId } = core.ask(anchor(core, connectionId));
  const before = core.snapshot();
  for (const invalid of [{ action: 'parameter', a: 99 }, { action: 'select', selectedId: 'missing' },
    { action: 'model', model: 'unknown' }, { action: 'page', pageId: 'missing' }, { action: 'undo' }]) {
    assert.throws(() => core.control({ connectionId, ...invalid }), StudioError);
    assert.deepEqual(core.snapshot(), before);
  }
  assert.equal(signal.aborted, false);
  pending.resolve(result()); await tick();
  assert.doesNotThrow(() => acknowledge(core, connectionId, turnId));
});

test('studio invalid imports preserve the entire state, active generation and original lesson', async t => {
  const pending = deferred(); let signal;
  const { core, connectionId } = setup(t, { generate: args => { signal = args.signal; return pending.promise; } });
  const { turnId } = core.ask(anchor(core, connectionId));
  const before = core.snapshot();
  const changes = [
    payload => { payload.format = 'other'; },
    payload => { payload.lesson.id = 'other-lesson'; },
    payload => { payload.state.lessonVersion = '2.0'; },
    payload => { payload.state.pages.p1.a = 100; },
    payload => { payload.state.pageId = 'missing'; },
    payload => { payload.state.selectedId = 'p2.curve'; },
    payload => { payload.state.cursor.stepIndex = 999; },
    payload => { payload.state.revision = Number.MAX_SAFE_INTEGER; },
    payload => { payload.state.pages.p1.scene.tangent = 'yes'; },
    payload => { payload.state.conversation[0].text = 'x'.repeat(4001); },
    payload => { payload.state.pages.p1.notes = [{ id: 'note-test', pageId: 'p1', targetId: 'missing', title: 'Note', text: 'Text', kind: 'grounded', sourceIds: [], turnId: 'old' }]; },
    payload => { payload.state.extra = 'not in contract'; },
    payload => { payload.lesson.pages[0].blocks[0].text = 'Altered canonical facts'; },
  ];
  for (const change of changes) {
    const payload = core.exportSession(); change(payload);
    assert.throws(() => core.restoreSession(payload), StudioError);
    assert.deepEqual(core.snapshot(), before);
    assert.equal(signal.aborted, false);
  }
  pending.resolve(result()); await tick(); acknowledge(core, connectionId, turnId);
});

test('studio valid import restores content with fresh anchors and no replay; old generation cannot overwrite it', async t => {
  const pending = deferred();
  const { core, connectionId } = setup(t, { generate: () => pending.promise });
  core.control({ connectionId, action: 'parameter', a: 4 });
  const exported = core.exportSession();
  exported.lesson = Object.fromEntries(Object.entries(exported.lesson).reverse());
  core.control({ connectionId, action: 'parameter', a: 2 });
  const { turnId } = core.ask(anchor(core, connectionId));
  const before = core.snapshot();
  core.authorize(connectionId);
  core.restoreSession(exported);
  assert.equal(core.snapshot().pages.p1.a, 4);
  assert(core.snapshot().revision > before.revision && core.snapshot().viewEpoch > before.viewEpoch);
  const restored = core.session();
  assert.notEqual(restored.connectionId, connectionId);
  pending.resolve(result()); await tick();
  assert.equal(core.snapshot().pages.p1.notes.length, 0);
  assert.equal(core.snapshot().delivery, 'idle');
  assert.throws(() => core.audio({ connectionId: restored.connectionId, turnId, phase: 'start' }), errorCode('STALE_AUDIO'));
});

test('studio persisted live notes and conversation survive reload but speech and undo are not replayed', async t => {
  const first = setup(t);
  const { turnId } = first.core.ask(anchor(first.core, first.connectionId)); await tick(); acknowledge(first.core, first.connectionId, turnId);
  first.core.audio({ connectionId: first.connectionId, turnId, phase: 'start' });
  const savedState = first.core.snapshot();
  const second = setup(t, { savedState });
  assert.equal(second.core.snapshot().pages.p1.notes.length, 1);
  assert.deepEqual(second.core.snapshot().conversation, savedState.conversation);
  assert.equal(second.core.snapshot().delivery, 'interrupted');
  assert.throws(() => second.core.audio({ connectionId: second.connectionId, turnId, phase: 'start' }), errorCode('STALE_AUDIO'));
  assert.throws(() => second.core.control({ connectionId: second.connectionId, action: 'undo' }), errorCode('NOTHING_TO_UNDO'));
});

test('legacy maxA 5 sessions upgrade metadata while preserving notes, selection, main cursor and resume point', async t => {
  const first = setup(t);
  first.core.control({ connectionId: first.connectionId, action: 'next' });
  const { turnId } = first.core.ask(anchor(first.core, first.connectionId));
  await tick(); acknowledge(first.core, first.connectionId, turnId);
  const noteId = first.core.snapshot().pages.p1.notes[0].id;
  first.core.control({ connectionId: first.connectionId, action: 'review_note', noteId });
  first.core.control({ connectionId: first.connectionId, action: 'select', selectedId: noteId });
  const legacy = first.core.exportSession(); legacy.lesson.example.maxA = 5;
  const upgradedLesson = structuredClone(lesson); upgradedLesson.example.maxA = 10;
  const second = setup(t, { lesson: upgradedLesson });
  second.core.restoreSession(legacy);
  const restored = second.core.snapshot();
  assert.deepEqual({ ...restored, revision: legacy.state.revision, viewEpoch: legacy.state.viewEpoch, delivery: legacy.state.delivery }, legacy.state);
  assert.equal(restored.pages.p1.notes[0].kind, 'needs_review');
  assert.equal(second.core.lesson.version, '1.0.0'); assert.equal(second.core.lesson.example.maxA, 10);
  assert.equal(legacy.lesson.example.maxA, 5, 'Import must not rewrite the caller payload.');
  const continued = second.core.control({ connectionId: second.connectionId, action: 'continue' });
  assert.equal(continued.step.id, 'p1.s2'); assert.deepEqual(continued.state.cursor, legacy.state.resumePoint);
  assert.deepEqual(continued.state.pages.p1.notes, legacy.state.pages.p1.notes);
  const changedContent = structuredClone(legacy); changedContent.lesson.pages[0].blocks[0].text = 'Different lesson text.';
  const before = second.core.snapshot();
  assert.throws(() => second.core.restoreSession(changedContent), errorCode('LESSON_MISMATCH'));
  assert.deepEqual(second.core.snapshot(), before);
});

test('studio model context only includes recent conversation while persisted history remains available', async t => {
  const contexts = [];
  const { core, connectionId } = setup(t, { generate: async args => { contexts.push(args.snapshot); return result({ note: null }); } });
  for (let i = 0; i < 6; i++) {
    const { turnId } = core.ask(anchor(core, connectionId, { question: `Question number ${i}?` })); await tick(); acknowledge(core, connectionId, turnId);
  }
  assert.equal(core.snapshot().conversation.length, 12);
  assert.equal(contexts.at(-1).conversation.length, 8);
  assert.equal(contexts.at(-1).state.conversation.length, 8);
  assert.equal(contexts.at(-1).state.pages.p1.scene.tangent, true);
});

test('studio state limit counts UTF-8 bytes and rejects oversized saved/imported state atomically', t => {
  const over = stateWithBytes(MAX_STATE_BYTES + 1);
  assert(JSON.stringify(over).length < MAX_STATE_BYTES, 'Character count alone would miss this oversized Unicode session.');
  assert.throws(() => new StudioCore({ lesson, generate: async () => result(), savedState: over }), errorCode('SESSION_FULL'));
  const { core } = setup(t);
  const original = core.snapshot();
  const payload = core.exportSession(); payload.state = over;
  assert.throws(() => core.restoreSession(payload), errorCode('SESSION_FULL'));
  assert.deepEqual(core.snapshot(), original);
});

test('studio full-session question preflight leaves state, persistence and provider untouched', t => {
  let calls = 0;
  const { core, connectionId, saved } = setup(t, { savedState: stateWithBytes(MAX_STATE_BYTES - 200),
    generate: async () => { calls++; return result(); } });
  const before = core.snapshot(); const savesBefore = saved.length;
  assert.throws(() => core.ask(anchor(core, connectionId, { question: 'Explain this. '.repeat(100) })), error => {
    assert.equal(error.code, 'SESSION_FULL'); assert.match(error.message, /Export.*lesson pack/); return true;
  });
  assert.equal(calls, 0);
  assert.deepEqual(core.snapshot(), before);
  assert.equal(saved.length, savesBefore);
});

test('studio full-session model preflight applies no parameter, note, scene, answer or undo entry', async t => {
  const { core, connectionId, records } = setup(t, { savedState: stateWithBytes(MAX_STATE_BYTES - 1500),
    generate: async () => result({ text: 'A'.repeat(2200), note: { targetId: 'p1.curve', text: 'B'.repeat(1600) },
      claims: [{ key: 'a', value: 3 }, { key: 'slope', value: 6 }] }) });
  const before = core.snapshot();
  core.ask(anchor(core, connectionId, { question: 'Set a to 3.' }));
  await tick();
  const after = core.snapshot();
  assert.equal(records[0].code, 'SESSION_FULL');
  assert.equal(records[0].unit, undefined, 'An uncommitted answer must not be recorded as an applied unit.');
  assert.deepEqual(after.pages, before.pages);
  assert.equal(after.selectedId, before.selectedId);
  assert.equal(after.conversation.length, before.conversation.length + 1, 'Only the accepted user question remains.');
  assert.equal(after.conversation.at(-1).role, 'user');
  assert.throws(() => core.control({ connectionId, action: 'undo' }), errorCode('NOTHING_TO_UNDO'));
  assert(Buffer.byteLength(JSON.stringify(after), 'utf8') <= MAX_STATE_BYTES);
});

test('studio an oversized replacement question cannot cancel an already accepted pending turn', async t => {
  const pending = deferred(); let signal; let calls = 0;
  const { core, connectionId } = setup(t, { savedState: stateWithBytes(MAX_STATE_BYTES - 1500),
    generate: args => { calls++; signal = args.signal; return pending.promise; } });
  const accepted = core.ask(anchor(core, connectionId));
  const before = core.snapshot();
  assert.throws(() => core.ask(anchor(core, connectionId, { question: 'x'.repeat(2000) })), errorCode('SESSION_FULL'));
  assert.equal(signal.aborted, false);
  assert.equal(calls, 1);
  assert.deepEqual(core.snapshot(), before);
  pending.resolve(result({ note: null })); await tick();
  assert.doesNotThrow(() => acknowledge(core, connectionId, accepted.turnId));
});

test('studio a large valid exported session restores within the declared state and import transport budgets', t => {
  const first = setup(t, { savedState: stateWithBytes(1_500_000) });
  const payload = first.core.exportSession();
  assert(Buffer.byteLength(JSON.stringify(payload.state), 'utf8') <= MAX_STATE_BYTES);
  assert(Buffer.byteLength(JSON.stringify({ connectionId: first.connectionId, payload }), 'utf8') < 3_000_000);
  const second = setup(t);
  second.core.restoreSession(payload);
  assert.deepEqual(second.core.snapshot().pages, first.core.snapshot().pages);
});
