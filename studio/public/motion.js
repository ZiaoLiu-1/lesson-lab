// Small, dependency-free motion primitives. The clock and frames are injectable for offline tests.
export const easeOutQuart = (t) => 1 - (1 - Math.max(0, Math.min(1, t))) ** 4;
export function interpolateValues(from, to, progress) {
  const result = {};
  for (const key of Object.keys(to)) result[key] = from[key] + (to[key] - from[key]) * progress;
  return result;
}
export function summarizeFrames(deltas) {
  const valid = deltas.filter((value) => Number.isFinite(value) && value > 0);
  if (!valid.length) return { samples: 0, medianMs: null, maxMs: null, over20Ms: 0 };
  const ordered = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return { samples: valid.length, medianMs: ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2, maxMs: ordered.at(-1), over20Ms: valid.filter((value) => value > 20).length };
}
export function createMotion({ requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame, now = () => performance.now(), reduced = () => false, onSample = () => {} } = {}) {
  const active = new Map();
  let frame = null;
  let frameEpoch = 0;
  const queueFrame = () => {
    const epoch = ++frameEpoch;
    frame = requestFrame((time) => { if (epoch === frameEpoch) tick(time); });
  };
  const finish = (entry, status) => {
    if (active.get(entry.key) !== entry) return;
    active.delete(entry.key);
    entry.resolve({ status });
    onSample({ key: entry.key, status, elapsedMs: now() - entry.started, ...summarizeFrames(entry.deltas) });
  };
  const tick = (time) => {
    frame = null;
    for (const entry of [...active.values()]) {
      if (active.get(entry.key) !== entry) continue;
      if (entry.lastFrame !== null && time > entry.lastFrame) entry.deltas.push(time - entry.lastFrame);
      entry.lastFrame = time;
      const progress = reduced() ? 1 : Math.min(1, Math.max(0, (time - entry.started) / entry.duration));
      entry.value = interpolateValues(entry.from, entry.to, easeOutQuart(progress));
      entry.update(entry.value, progress);
      if (progress === 1) finish(entry, 'finished');
    }
    if (active.size && frame === null) queueFrame();
  };
  const cancel = (key, { complete = false } = {}) => {
    const entry = active.get(key);
    if (!entry) return;
    if (complete) entry.update(entry.to, 1);
    finish(entry, complete ? 'finished' : 'cancelled');
    if (!active.size && frame !== null) { cancelFrame(frame); frame = null; frameEpoch += 1; }
  };
  return {
    to(key, { from, to, duration = 420, update }) {
      const previous = active.get(key);
      const origin = previous ? { ...previous.value } : { ...from };
      if (previous && Object.keys(to).every((name) => previous.to[name] === to[name])) return previous.promise;
      cancel(key);
      if (reduced() || duration <= 0 || Object.keys(to).every((name) => origin[name] === to[name])) {
        update({ ...to }, 1);
        return Promise.resolve({ status: 'finished' });
      }
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      active.set(key, { key, from: origin, to: { ...to }, value: origin, duration, update, promise, resolve, started: now(), lastFrame: null, deltas: [] });
      update(origin, 0);
      if (frame === null) queueFrame();
      return promise;
    },
    cancel,
    cancelAll(options) { for (const key of [...active.keys()]) cancel(key, options); },
    async settled(predicate = () => true) {
      // Follow retargets rather than acknowledging a cancelled, earlier animation.
      while (true) {
        const pending = [...active.values()].filter((entry) => predicate(entry.key));
        if (!pending.length) return;
        await Promise.all(pending.map((entry) => entry.promise));
      }
    },
    has(key) { return active.has(key); },
  };
}

const keyedChildren = new WeakMap();
export function reconcileChildren(container, items, { key, create, update, remove = (node) => node.remove() }) {
  let nodes = keyedChildren.get(container);
  if (!nodes) { nodes = new Map(); keyedChildren.set(container, nodes); container.replaceChildren(); }
  const wanted = new Set(items.map(key));
  for (const [id, node] of nodes) if (!wanted.has(id)) { remove(node); nodes.delete(id); }
  let cursor = container.firstChild;
  const added = [];
  for (const item of items) {
    const id = key(item);
    let node = nodes.get(id);
    if (!node) { node = create(item); nodes.set(id, node); added.push(node); }
    update(node, item);
    if (node !== cursor) container.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  return { nodes: [...nodes.values()], added };
}
