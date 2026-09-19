import test from 'node:test';
import assert from 'node:assert/strict';
import { ShowcaseFinale, FINALE_URL, matchesFinaleCommand } from '../studio/public/finale.js';

class Element extends EventTarget {
  constructor(tag, doc) {
    super(); this.tagName = tag; this.ownerDocument = doc; this.children = []; this.parent = null;
    this.attributes = new Map(); this.inert = false;
    this.style = { overflow: '', setProperty(key, value) { this[key] = value; } };
    const classes = new Set(); this.classList = { add: value => classes.add(value), contains: value => classes.has(value) };
  }
  append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parent = this; } }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parent?.isConnected); }
  focus() { this.ownerDocument.activeElement = this; }
}
class Document extends EventTarget {
  constructor() { super(); this.hidden = false; this.body = new Element('body', this); this.activeElement = this.body; }
  createElement(tag) { return new Element(tag, this); }
  createElementNS(ns, tag) { return new Element(tag, this); }
}
function fixture(options = {}) {
  let time = 0; let serial = 0;
  const jobs = new Map(); const callbacks = new Map(); const navigation = []; const starts = []; const cancellations = [];
  const doc = new Document(); const original = doc.createElement('button'); const inactive = doc.createElement('aside');
  inactive.inert = true; doc.body.style.overflow = 'auto'; doc.body.append(original, inactive); original.focus();
  const finale = new ShowcaseFinale({ document: doc, onStart: () => starts.push(time), onCancel: reason => cancellations.push(reason), navigate: url => navigation.push(url),
    clock: { now: () => time, requestFrame(callback) { const id = ++serial; jobs.set(id, callback); callbacks.set(id, callback); return id; }, cancelFrame(id) { jobs.delete(id); } }, ...options });
  return { finale, doc, original, inactive, navigation, starts, cancellations,
    at(value) { time = value; const pending = [...jobs.values()]; jobs.clear(); for (const callback of pending) callback(); },
    get pending() { return jobs.size; }, get latestCallback() { return callbacks.get(serial); },
  };
}
function key(doc, value) { const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value }); doc.dispatchEvent(event); return event; }

test('only the complete English finale command matches, with case and punctuation normalized', () => {
  for (const text of ['Showcase complete', ' SHOWCASE COMPLETE! ', '“Showcase complete.”', 'Showcase, complete', 'Showcase\ncomplete']) assert.equal(matchesFinaleCommand(text), true, text);
  for (const text of ['', null, 'showcase', 'complete', 'Please showcase complete', 'Is the showcase complete?', 'Do not say showcase complete', 'Showcase complete and restart', '展示完成']) assert.equal(matchesFinaleCommand(text), false, String(text));
});

test('a complete countdown precedes the full fade and one official-site navigation', () => {
  const f = fixture(); assert.equal(f.finale.start(), true);
  assert.equal(f.starts.length, 1); assert.equal(f.original.inert, true); assert.equal(f.doc.body.style.overflow, 'hidden');
  assert.equal(f.finale.button.textContent, 'Thank you'); assert.equal(f.doc.activeElement, f.finale.button);
  f.at(3000); assert.equal(f.finale.ring.getAttribute('aria-valuenow'), '50'); assert.equal(f.finale.progress.style.strokeDashoffset, '50');
  f.at(5999); assert.equal(f.finale.phase, 'countdown'); assert.deepEqual(f.navigation, []);
  f.at(6000); assert.equal(f.finale.phase, 'fade'); assert.equal(f.finale.root.classList.contains('is-leaving'), true);
  f.at(6899); assert.deepEqual(f.navigation, []);
  const late = f.latestCallback; f.at(6900); assert.deepEqual(f.navigation, [FINALE_URL]); assert.equal(f.pending, 0);
  late(); f.at(10000); assert.deepEqual(f.navigation, ['https://www.cerebras.ai/']);
});

test('Escape during the fade cancels late navigation and restores the original reader', () => {
  const f = fixture(); f.finale.start(); f.at(6000); const late = f.latestCallback;
  const event = key(f.doc, 'Escape'); assert.equal(event.defaultPrevented, true);
  assert.equal(f.finale.active, false); assert.equal(f.doc.body.children.length, 2);
  assert.equal(f.original.inert, false); assert.equal(f.inactive.inert, true); assert.equal(f.doc.body.style.overflow, 'auto');
  assert.equal(f.doc.activeElement, f.original); assert.deepEqual(f.cancellations, ['escape']);
  late(); f.at(20000); assert.deepEqual(f.navigation, []); assert.equal(f.pending, 0);
});

test('hiding the tab cancels instead of leaving a background redirect armed', () => {
  const f = fixture(); f.finale.start(); const late = f.latestCallback;
  f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.finale.active, false); assert.deepEqual(f.cancellations, ['hidden']);
  f.doc.hidden = false; late(); f.at(20000); assert.deepEqual(f.navigation, []);
  assert.equal(f.starts.length, 1, 'returning never restarts the finale');
});

test('a replacement start gets a fresh countdown and old frames cannot change its ring or navigate', () => {
  const f = fixture(); f.finale.start(); f.at(5000); const oldFrame = f.latestCallback;
  f.finale.start(); assert.deepEqual(f.cancellations, ['restarted']); assert.equal(f.starts.length, 2);
  oldFrame(); assert.equal(f.finale.ring.getAttribute('aria-valuenow'), '0');
  f.at(6900); assert.deepEqual(f.navigation, []);
  f.at(11000); assert.equal(f.finale.phase, 'fade'); f.at(11900); assert.deepEqual(f.navigation, [FINALE_URL]);
});

test('Thank you skips only the countdown; repeated clicks cannot bypass the fade', () => {
  const f = fixture(); f.finale.start(); f.at(1000);
  f.finale.button.dispatchEvent(new Event('click')); f.finale.button.dispatchEvent(new Event('click'));
  assert.equal(f.finale.phase, 'fade'); f.at(1899); assert.deepEqual(f.navigation, []);
  f.at(1900); assert.deepEqual(f.navigation, [FINALE_URL]);
});

test('destroy removes all presentation state and makes pending callbacks and future starts inert', () => {
  const f = fixture(); f.finale.start(); const late = f.latestCallback;
  f.finale.destroy(); late(); f.at(20000);
  assert.equal(f.finale.start(), false); assert.equal(f.doc.body.children.length, 2); assert.equal(f.doc.activeElement, f.original);
  assert.equal(f.original.inert, false); assert.deepEqual(f.navigation, []); assert.deepEqual(f.cancellations, ['destroyed']);
});

test('a hidden initial page never starts, and a removed overlay cannot redirect', () => {
  const f = fixture(); f.doc.hidden = true; assert.equal(f.finale.start(), false); assert.equal(f.starts.length, 0);
  f.doc.hidden = false; f.finale.start(); f.finale.root.remove(); f.at(20000);
  assert.deepEqual(f.navigation, []); assert.deepEqual(f.cancellations, ['removed']); assert.equal(f.original.inert, false);
});

test('focus remains in the finale and a failed navigation restores the lesson', () => {
  const f = fixture({ durationMs: 0, fadeMs: 0, navigate() { throw Error('Navigation blocked'); } });
  f.finale.start(); f.original.focus(); assert.equal(key(f.doc, 'Tab').defaultPrevented, true); assert.equal(f.doc.activeElement, f.finale.button);
  f.at(0); assert.equal(f.finale.active, false); assert.deepEqual(f.cancellations, ['navigation-failed']); assert.equal(f.doc.activeElement, f.original);
});
