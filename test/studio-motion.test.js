import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotion, interpolateValues, summarizeFrames, reconcileChildren } from '../studio/public/motion.js';

function clock(reduced = false) {
  let time = 0; let serial = 0; let reduce = reduced;
  const queue = new Map(); const callbacks = new Map(); const samples = [];
  const motion = createMotion({ now: () => time, reduced: () => reduce,
    requestFrame(fn) { const id = ++serial; queue.set(id, fn); callbacks.set(id, fn); return id; },
    cancelFrame(id) { queue.delete(id); }, onSample(sample) { samples.push(sample); } });
  return { motion, samples, callbacks, get lastId() { return serial; }, setReduced(value) { reduce = value; },
    at(value) { time = value; const jobs = [...queue.values()]; queue.clear(); for (const fn of jobs) fn(time); }, get pending() { return queue.size; } };
}

test('a parameter transition ends at exact final coordinates and records real callback gaps', async () => {
  const c = clock(); let shown;
  const done = c.motion.to('graph', { from: { a: 1, tangent: 0 }, to: { a: 5, tangent: 1 }, duration: 420, update: (value) => { shown = value; } });
  c.at(16); c.at(32); c.at(65);
  assert.ok(shown.a > 1 && shown.a < 5);
  c.at(420); assert.deepEqual(shown, { a: 5, tangent: 1 });
  assert.equal((await done).status, 'finished');
  assert.equal(c.samples[0].samples, 3); assert.equal(c.samples[0].maxMs, 355); assert.equal(c.samples[0].over20Ms, 2);
  assert.equal(c.pending, 0);
});

test('retarget starts from the last displayed graph and settles only the new target', async () => {
  const c = clock(); let shown;
  const first = c.motion.to('graph', { from: { a: 1 }, to: { a: 5 }, update: (value) => { shown = value.a; } });
  c.at(100); const intermediate = shown;
  let settled = false; const ready = c.motion.settled().then(() => { settled = true; });
  const second = c.motion.to('graph', { from: { a: -100 }, to: { a: 2 }, update: (value) => { shown = value.a; } });
  assert.equal(shown, intermediate); assert.equal((await first).status, 'cancelled');
  await Promise.resolve(); assert.equal(settled, false);
  c.at(520); await second; await ready; assert.equal(shown, 2); assert.equal(settled, true);
});

test('a cancelled old RAF cannot update or finish a new animation', async () => {
  const c = clock(); let writes = 0; let value;
  const first = c.motion.to('graph', { from: { a: 1 }, to: { a: 5 }, update: () => { writes++; } });
  const stale = c.callbacks.get(c.lastId);
  c.motion.cancel('graph'); assert.equal((await first).status, 'cancelled');
  const second = c.motion.to('graph', { from: { a: 1 }, to: { a: 3 }, update: (v) => { value = v.a; writes++; } });
  const before = writes; stale(9999); assert.equal(writes, before); assert.equal(value, 1);
  c.at(420); await second; assert.equal(value, 3);
});

test('repeated state with the same target does not restart or extend the animation', async () => {
  const c = clock(); let value;
  const original = c.motion.to('graph', { from: { a: 1 }, to: { a: 2 }, update: (v) => { value = v.a; } });
  c.at(200);
  const again = c.motion.to('graph', { from: { a: 1 }, to: { a: 2 }, update: () => { throw new Error('must not restart'); } });
  assert.equal(again, original);
  c.at(420); await original; assert.equal(value, 2);
});

test('reduced motion paints exact target synchronously without fabricated frame measurements', async () => {
  const c = clock(true); let value;
  const done = c.motion.to('graph', { from: { a: 1 }, to: { a: 5 }, update: (v) => { value = v.a; } });
  assert.equal(value, 5); assert.equal(c.pending, 0); assert.equal((await done).status, 'finished'); assert.equal(c.samples.length, 0);
});

test('switching to reduced motion during a run completes in the next frame', async () => {
  const c = clock(); let value;
  const done = c.motion.to('graph', { from: { a: 1 }, to: { a: 5 }, update: (v) => { value = v.a; } });
  c.at(16); c.setReduced(true); c.at(32); await done; assert.equal(value, 5); assert.equal(c.pending, 0);
});

test('hidden or interrupted view can snap authoritative graph then cancel focus without late writes', async () => {
  const c = clock(); const values = {};
  const graph = c.motion.to('graph', { from: { x: 1 }, to: { x: 5 }, update: (v) => { values.graph = v.x; } });
  const focus = c.motion.to('focus', { from: { x: 10 }, to: { x: 80 }, update: (v) => { values.focus = v.x; } });
  c.at(32); c.motion.cancel('graph', { complete: true }); c.motion.cancel('focus');
  assert.equal((await graph).status, 'finished'); assert.equal((await focus).status, 'cancelled');
  const cancelledValue = values.focus; c.at(999); assert.deepEqual(values, { graph: 5, focus: cancelledValue });
});

test('visible-answer gate can await graph and notes without waiting for unrelated passage movement', async () => {
  const c = clock();
  c.motion.to('graph', { from: { a: 1 }, to: { a: 2 }, duration: 100, update() {} });
  c.motion.to('note:new', { from: { y: 10 }, to: { y: 0 }, duration: 150, update() {} });
  c.motion.to('focus', { from: { y: 10 }, to: { y: 80 }, duration: 400, update() {} });
  let ready = false; const done = c.motion.settled((key) => key !== 'focus').then(() => { ready = true; });
  c.at(100); await Promise.resolve(); assert.equal(ready, false);
  c.at(150); await done; assert.equal(ready, true); assert.equal(c.motion.has('focus'), true);
  c.motion.cancelAll();
});

test('frame statistics retain slow frames, reject invalid intervals, and do not invent samples', () => {
  assert.deepEqual(summarizeFrames([]), { samples: 0, medianMs: null, maxMs: null, over20Ms: 0 });
  assert.deepEqual(summarizeFrames([16, 17, 80, 16, NaN, -1, 0]), { samples: 4, medianMs: 16.5, maxMs: 80, over20Ms: 1 });
});

test('all intermediate numeric coordinates come from one interpolated scalar', () => {
  for (const t of [0, 0.1, 0.5, 0.9, 1]) {
    const { a } = interpolateValues({ a: 0.5 }, { a: 5 }, t);
    const curveAtOne = a; const curveAtTwo = 4 * a; const tangentAtTwo = 3 * a;
    assert.ok(Math.abs(curveAtTwo - tangentAtTwo - curveAtOne) < 1e-12);
    assert.ok(a >= 0.5 && a <= 5);
  }
});

class Node {
  constructor(id) { this.id = id; this.children = []; this.parent = null; this.moves = 0; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  insertBefore(node, cursor) { node.remove(); const i = cursor ? this.children.indexOf(cursor) : this.children.length; assert.ok(i >= 0); this.children.splice(i, 0, node); node.parent = this; this.moves++; }
  replaceChildren() { for (const node of this.children) node.parent = null; this.children = []; }
}
test('keyed updates preserve passage identity, focus object and ordering without redundant moves', () => {
  const host = new Node('host'); const options = { key: (item) => item.id, create: (item) => new Node(item.id), update: (node, item) => { node.text = item.text; } };
  const a = { id: 'a', text: 'first' }; const b = { id: 'b', text: 'second' };
  const first = reconcileChildren(host, [a, b], options); const firstNode = host.children[0]; const moves = host.moves;
  reconcileChildren(host, [{ ...a, text: 'new value' }, b], options);
  assert.equal(host.children[0], firstNode); assert.equal(firstNode.text, 'new value'); assert.equal(host.moves, moves);
  const reordered = reconcileChildren(host, [b, a, { id: 'c' }], options);
  assert.equal(host.children[1], firstNode); assert.deepEqual(host.children.map((n) => n.id), ['b', 'a', 'c']); assert.equal(reordered.added.length, 1); assert.equal(first.added.length, 2);
  reconcileChildren(host, [a], options); assert.deepEqual(host.children, [firstNode]);
});
