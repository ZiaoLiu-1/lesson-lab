import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTeachingFocus } from '../studio/public/focus.js';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../studio/public/app.js', import.meta.url), 'utf8');
function actual(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(appSource); assert.ok(match, name);
  const next = /\n(?:async )?function \w+\(/g; next.lastIndex = match.index + match[0].length;
  return appSource.slice(match.index, next.exec(appSource)?.index ?? appSource.length);
}

function fixture() {
  return {
    lesson: { pages: [
      { id: 'p1', blocks: [{ id: 'p1.a', title: 'Selected passage' }, { id: 'p1.b', title: 'Explained passage' }] },
      { id: 'p2', blocks: [{ id: 'p2.a', title: 'Another page' }] },
    ] },
    state: { pageId: 'p1', selectedId: 'p1.a', revision: 7, viewEpoch: 4, delivery: 'idle', pages: {
      p1: { notes: [{ id: 'note-1', title: 'Saved clarification', targetId: 'p1.a' }, { id: 'note-2', title: '' }] },
      p2: { notes: [] },
    } },
    marker: { kind: 'lesson', id: 'step-1', targetId: 'p1.b', pageId: 'p1', connectionId: 'connection-1', revision: 7, viewEpoch: 4, phase: 'ready' },
    audio: null, connectionId: 'connection-1', connected: true,
  };
}

function audioFor(input, overrides = {}) {
  return { connectionId: input.connectionId, revision: input.state.revision, viewEpoch: input.state.viewEpoch,
    identity: input.marker.kind === 'lesson' ? { stepId: input.marker.id } : { turnId: input.marker.id },
    started: false, cancelled: false, ...overrides };
}

test('selection and saved delivery alone never create a teaching marker', () => {
  const input = fixture(); input.marker = null;
  for (const delivery of ['idle', 'speaking', 'done', 'interrupted']) {
    input.state.delivery = delivery;
    assert.equal(resolveTeachingFocus(input), null);
  }
  input.state = null;
  assert.equal(resolveTeachingFocus(input), null);
});

test('current teaching target remains distinct from the selected question passage without mutating state', () => {
  const input = fixture(); const before = structuredClone(input);
  assert.deepEqual(resolveTeachingFocus(input), { targetId: 'p1.b', title: 'Explained passage', phase: 'ready', label: 'Current step' });
  assert.deepEqual(input, before);
  input.state.selectedId = 'note-1';
  assert.equal(resolveTeachingFocus(input).targetId, 'p1.b');
});

test('an acknowledged reply uses its own marker label and can target a whole saved note', () => {
  const input = fixture();
  Object.assign(input.marker, { kind: 'reply', id: 'turn-1', targetId: 'note-1' });
  assert.deepEqual(resolveTeachingFocus(input), { targetId: 'note-1', title: 'Saved clarification', phase: 'ready', label: 'Explaining this' });
  input.marker.targetId = 'note-2';
  assert.equal(resolveTeachingFocus(input).title, 'Saved note');
});

test('removed targets and another page cannot retain a marker box', () => {
  const input = fixture(); input.marker.targetId = 'missing';
  assert.equal(resolveTeachingFocus(input), null);
  input.marker.targetId = 'p1.b'; input.state.pageId = 'p2';
  assert.equal(resolveTeachingFocus(input), null);
  input.marker.pageId = 'p2';
  assert.equal(resolveTeachingFocus(input), null);
});

test('disconnected or stale connection, revision, and view epoch downgrade to paused, even with started audio', () => {
  for (const change of [
    input => { input.connected = false; },
    input => { input.connectionId = 'replacement'; },
    input => { input.state.revision++; },
    input => { input.state.viewEpoch++; },
  ]) {
    const input = fixture(); input.audio = audioFor(input, { started: true }); change(input);
    const focus = resolveTeachingFocus(input);
    assert.equal(focus.targetId, 'p1.b');
    assert.equal(focus.phase, 'paused');
    assert.equal(focus.label, 'Paused here');
  }
});

test('queued, actual playback, and actual end have distinct phases for lesson and reply identities', () => {
  for (const kind of ['lesson', 'reply']) {
    const input = fixture(); input.marker.kind = kind;
    input.audio = audioFor(input);
    assert.equal(resolveTeachingFocus(input).phase, 'preparing');
    assert.equal(resolveTeachingFocus(input).label, 'Preparing to read');
    input.audio.started = true;
    assert.equal(resolveTeachingFocus(input).phase, 'speaking');
    assert.equal(resolveTeachingFocus(input).label, 'Now explaining');
    // The network may still report speaking after local playback actually ended.
    input.state.delivery = 'speaking'; input.audio.ended = true;
    assert.equal(resolveTeachingFocus(input).phase, 'done');
    assert.equal(resolveTeachingFocus(input).label, 'Just covered');
  }
});

test('cancelled, unrelated, or stale audio cannot promote the current marker to speaking', () => {
  for (const change of [
    audio => { audio.cancelled = true; },
    audio => { audio.connectionId = 'old'; },
    audio => { audio.revision--; },
    audio => { audio.viewEpoch--; },
    audio => { audio.identity = { stepId: 'another-step' }; },
    audio => { audio.identity = { turnId: 'step-1' }; },
  ]) {
    const input = fixture(); input.audio = audioFor(input, { started: true }); change(input.audio);
    assert.equal(resolveTeachingFocus(input).phase, 'ready');
    assert.equal(resolveTeachingFocus(input).label, 'Current step');
  }
  const reply = fixture(); reply.marker.kind = 'reply';
  reply.audio = audioFor(reply, { identity: { stepId: reply.marker.id }, started: true });
  assert.equal(resolveTeachingFocus(reply).phase, 'ready');
});

test('paused and completed markers remain correctly labeled after audio is released', () => {
  const input = fixture(); input.marker.phase = 'paused';
  assert.equal(resolveTeachingFocus(input).label, 'Paused here');
  input.marker.phase = 'done'; input.state.delivery = 'speaking';
  assert.equal(resolveTeachingFocus(input).phase, 'done');
  assert.equal(resolveTeachingFocus(input).label, 'Just covered');
});

function browserFixture() {
  const ui = { ...fixture(), view: 'study' }, scrolls = [], transitions = [], cancelled = [];
  const node = id => ({ dataset: { passageId: id }, isConnected: true, top: 100, width: 300,
    getBoundingClientRect() { return { left: 20, right: 20 + this.width, top: this.top, bottom: this.top + 100, width: this.width, height: 100 }; } });
  const nodes = [node('p1.a'), node('p1.b'), node('reply-turn-1')];
  const overlay = { style: {}, firstElementChild: { setAttribute() {} } };
  const follow = { checked: true };
  const context = vm.createContext({ ui, nodes, resolveTeachingFocus, innerHeight: 800, scrollY: 0,
    document: { hidden: false, documentElement: { scrollHeight: 3000 }, querySelectorAll: () => nodes },
    window: { scrollTo: value => scrolls.push(value.top) },
    $(id) { return id === 'follow-teaching' ? follow : id === 'passage-halo' ? overlay : id === 'live-answer' ? nodes[2] : null; },
    visible: target => target.isConnected && target.top < 700 && target.top + 100 > 0,
    unobscuredBottom: () => 700,
    motion: { cancel: key => cancelled.push(key), to(key, spec) { transitions.push({ key, duration: spec.duration }); spec.update(spec.to); return Promise.resolve(); } },
  });
  const names = ['teachingFocus', 'teachingFollowKey', 'cancelTeachingFollow', 'followTeachingFocus', 'focusTarget', 'positionPassageHalo'];
  vm.runInContext(`let haloTarget = nodes[0], haloValue = null, haloPaintTarget = null, haloDesired = null;\n${names.map(actual).join('\n')}`, context);
  return { ui, context, nodes, overlay, follow, scrolls, transitions, cancelled };
}

test('an acknowledged reply keeps its inline answer as the visual target while source selection stays intact', () => {
  const f = browserFixture(); f.ui.marker.kind = 'reply'; f.ui.marker.id = 'turn-1';
  f.ui.accepted = { turnId: 'turn-1', unit: { title: 'A new explanation', focusId: 'p1.b' } };
  f.nodes[2].dataset.turnId = 'turn-1';
  assert.equal(f.context.teachingFocus().targetId, 'reply-turn-1');
  assert.equal(f.ui.marker.targetId, 'p1.b'); assert.equal(f.ui.state.selectedId, 'p1.a');
});

test('a visible passage never causes centering, and repeated playback follow calls scroll once per step', () => {
  const f = browserFixture(); f.nodes[1].top = 650;
  f.context.followTeachingFocus(); assert.equal(f.scrolls.length, 0, 'Even a partly visible current passage should not bounce to center');
  f.ui.marker.id = 'step-2'; f.nodes[1].top = 900;
  f.context.followTeachingFocus(); f.context.followTeachingFocus(); f.context.followTeachingFocus();
  assert.equal(f.scrolls.length, 1);
});

test('manual scrolling suppresses that step until explicit Show passage or a new step, preserving Follow preference', () => {
  const f = browserFixture(); f.nodes[1].top = 900;
  f.context.followTeachingFocus(); f.context.cancelTeachingFollow();
  f.context.followTeachingFocus(); assert.equal(f.scrolls.length, 1); assert.equal(f.follow.checked, true);
  f.context.followTeachingFocus(true); assert.equal(f.scrolls.length, 2);
  f.context.cancelTeachingFollow(); f.ui.marker.id = 'step-2'; f.context.followTeachingFocus(); assert.equal(f.scrolls.length, 3);
  f.follow.checked = false; f.ui.marker.id = 'step-3'; f.context.followTeachingFocus(); assert.equal(f.scrolls.length, 3);
  f.ui.active = {}; f.context.cancelTeachingFollow(); assert.equal(f.ui.active.userScrolled, true);
});

test('scroll and resize track one halo without repeatedly starting 360ms transitions', () => {
  const f = browserFixture(); f.context.positionPassageHalo();
  assert.equal(f.transitions.filter(item => item.key === 'focus').length, 1);
  f.nodes[0].top = 60; f.context.positionPassageHalo(); f.nodes[0].width = 340; f.context.positionPassageHalo();
  assert.equal(f.transitions.filter(item => item.key === 'focus').length, 1);
  assert.match(f.overlay.style.transform, /58px/);
  f.nodes[0].top = 900; f.context.positionPassageHalo(); assert.equal(f.overlay.style.opacity, '0');
  f.nodes[0].top = 60; f.context.positionPassageHalo(); assert.equal(f.overlay.style.opacity, '1');
  vm.runInContext('haloTarget = nodes[1]', f.context); f.context.positionPassageHalo();
  assert.equal(f.transitions.filter(item => item.key === 'focus').length, 2, 'A genuinely new passage may animate');
});
