import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spokenText } from '../studio/public/narration.js';

const source = fs.readFileSync(new URL('../studio/public/canvas.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const tick = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const docValue = (revision = 1) => ({ revision, html: `<!doctype html><html><head></head><body><section id="focus">Page ${revision}</section></body></html>`,
  title: `Page ${revision}`, narration: `The visible example has revision ${revision}.`, focusId: 'focus', sourceHash: `hash-${revision}` });

function harness(t, options = {}) {
  const nodes = new Map(), candidates = [], calls = [], reads = [], errors = [], results = [], speech = [], playback = [];
  let anchor = { connectionId: 'reader', revision: 1, viewEpoch: 1, pageId: 'p1', selectedId: 'p1.function' };
  class Element {
    constructor(id = '') { this.id = id; this.hidden = false; this.style = {}; this.dataset = {}; this.listeners = new Map(); this.attributes = []; this.textContent = ''; this.bounds = { left: 0, top: 100, width: 600, height: 500, bottom: 600 }; this.classList = { add() {}, remove() {}, toggle() {} }; }
    addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler); }
    removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
    fire(name, event = {}) { for (const handler of [...(this.listeners.get(name) ?? [])]) handler(event); }
    getBoundingClientRect() { return { ...this.bounds }; }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    scrollIntoView() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { this.removed = true; }
  }
  function frameDocument() {
    const focus = new Element('focus'); focus.dataset.blockId = 'focus'; focus.textContent = 'Visible teaching section';
    focus.bounds = { left: 10, top: 20, width: 400, height: 50, bottom: 70 };
    const body = new Element(); body.textContent = 'Nonempty source'; body.scrollHeight = 600;
    const doc = { focus, body, documentElement: { scrollHeight: 600 }, addEventListener() {}, getElementById: id => id === 'focus' ? focus : null,
      querySelectorAll: selector => selector === '[data-block-id],[id]' ? [focus] : [], };
    return doc;
  }
  class Frame extends Element {
    constructor(id = 'canvas-document') { super(id); this.contentDocument = frameDocument(); }
    cloneNode() { const candidate = new Frame(); candidates.push(candidate); return candidate; }
    after(candidate) { candidate.previous = this; }
    replaceWith(candidate) { this.replacedBy = candidate; nodes.set('canvas-document', candidate); }
    set srcdoc(value) { this.source = value; if (options.autoLoad !== false) queueMicrotask(() => this.fire('load')); }
  }
  nodes.set('canvas-document', new Frame());
  const document = { addEventListener() {}, hidden: false, body: new Element(), getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); },
    querySelectorAll: () => [], querySelector: () => new Element(), createElement: tag => new Element(tag) };
  const context = vm.createContext({ document, spokenText, canvasSeed: () => docValue(0).html, shouldEditCanvas: () => true,
    window: { addEventListener() {}, scrollBy() {}, open() {} }, innerHeight: 1000,
    requestAnimationFrame: callback => queueMicrotask(callback), getComputedStyle: node => ({ visibility: node.visibility ?? 'visible' }),
    ResizeObserver: class { observe() {} disconnect() {} },
    DOMParser: class { parseFromString(html) { return { querySelectorAll: () => [], createElement: () => new Element(), head: { prepend() {} }, documentElement: { outerHTML: html } }; } },
    performance: { now: () => 100 }, AbortController, URL, Blob, setTimeout, clearTimeout, console,
    fetch: options.fetch ?? (async () => { throw Error('Unexpected native speech request'); }),
    Audio: options.Audio ?? class {},
  });
  vm.runInContext(`${source}\nglobalThis.LiveCanvas = LiveCanvas;`, context);
  const settings = { anchor: () => ({ ...anchor }), matches: value => Object.keys(anchor).every(key => value[key] === anchor[key]),
    lessonKey: () => 'lesson:1', title: () => 'Lesson', beforeEdit() {}, onChange() {}, ask() {}, ownsVoice: () => true,
    speechEngine: () => 'browser', playback: value => playback.push(value), speakBrowser: (text, callbacks) => { speech.push({ text, callbacks }); return () => {}; },
    error: value => errors.push(value), onResult: value => results.push(value),
    get: async route => { reads.push(route); return options.get ? options.get(route) : { document: null }; },
    post: async (route, body, signal) => {
      calls.push({ route, body: structuredClone(body), signal });
      if (options.post) return options.post(route, body, signal);
      if (route === '/api/canvas/edit') return { document: docValue(1), metrics: { providerMs: 15 } };
      if (route === '/api/canvas/ack') return { document: docValue(body.canvasRevision), acknowledged: true };
      return { cancelled: true };
    }, ...options.settings };
  const canvas = new context.LiveCanvas(settings); canvas.active = true; canvas.document = docValue(0);
  t.after(() => { canvas.cancel(false); for (const frame of candidates) frame.fire('load'); });
  return { canvas, context, document, nodes, candidates, calls, reads, errors, results, speech, playback,
    changeAnchor: update => { anchor = { ...anchor, ...update }; } };
}

test('canvas browser speech waits for candidate load, atomic visible replacement and matching ACK', async t => {
  const ack = deferred();
  const h = harness(t, { autoLoad: false, post: async (route, body) => route === '/api/canvas/edit' ? { document: docValue(1), metrics: { providerMs: 1 } }
    : route === '/api/canvas/ack' ? ack.promise : { cancelled: true } });
  const previousFrame = h.canvas.frame, edit = h.canvas.edit('Change the page.', { read: true }); await tick();
  assert.equal(h.candidates.length, 1); assert.equal(h.canvas.frame, previousFrame); assert.equal(h.canvas.document.revision, 0);
  assert.equal(h.calls.some(call => call.route === '/api/canvas/ack'), false); assert.equal(h.speech.length, 0);
  h.candidates[0].fire('load'); await tick();
  assert.equal(h.canvas.frame, h.candidates[0]); assert.equal(h.canvas.document.revision, 1);
  assert.equal(h.calls.filter(call => call.route === '/api/canvas/ack').length, 1); assert.equal(h.speech.length, 0);
  ack.resolve({ acknowledged: true, document: docValue(1) }); await edit;
  assert.equal(h.speech.length, 1); assert.equal(h.speech[0].text, docValue(1).narration); assert.equal(h.results.length, 1);
});

test('cancelled generation and cancelled iframe load never replace the prior document or speak', async t => {
  for (const stage of ['generation', 'load']) {
    const pending = deferred();
    const h = harness(t, { autoLoad: false, post: async route => route === '/api/canvas/edit' ? pending.promise : { cancelled: true } });
    const original = h.canvas.frame, edit = h.canvas.edit('Change the page.', { read: true }); await tick();
    if (stage === 'load') { pending.resolve({ document: docValue(1) }); await tick(); }
    h.canvas.cancel(false);
    if (stage === 'generation') pending.resolve({ document: docValue(1) }); else h.candidates[0].fire('load');
    await edit;
    assert.equal(h.canvas.frame, original); assert.equal(h.canvas.document.revision, 0);
    assert.equal(h.speech.length, 0); assert.equal(h.calls.some(call => call.route === '/api/canvas/ack'), false);
    if (stage === 'load') assert.equal(h.candidates[0].removed, true);
  }
});

test('late old render cannot overwrite a newer edit or send an ACK for the wrong document', async t => {
  let number = 0;
  const h = harness(t, { autoLoad: false, post: async (route, body) => route === '/api/canvas/edit' ? { document: docValue(++number) }
    : { acknowledged: true, document: docValue(body.canvasRevision) } });
  const first = h.canvas.edit('First change.', { read: true }); await tick();
  const second = h.canvas.edit('Second change.', { read: true }); await tick();
  h.candidates[1].fire('load'); await second;
  h.candidates[0].fire('load'); await first;
  assert.equal(h.canvas.document.revision, 2); assert.equal(h.canvas.frame, h.candidates[1]);
  assert.deepEqual(h.calls.filter(call => call.route === '/api/canvas/ack').map(call => call.body.canvasRevision), [2]);
  assert.equal(h.speech.length, 1); assert.equal(h.speech[0].text, docValue(2).narration);
});

test('stale core anchor or hidden target stops ACK and speech after a candidate renders', async t => {
  for (const failure of ['anchor', 'hidden-target']) {
    const h = harness(t, { autoLoad: false });
    const edit = h.canvas.edit('Change this.', { read: true }); await tick();
    if (failure === 'anchor') h.changeAnchor({ viewEpoch: 2 });
    else h.candidates[0].contentDocument.focus.bounds.height = 0;
    h.candidates[0].fire('load'); await edit;
    assert.equal(h.calls.some(call => call.route === '/api/canvas/ack'), false); assert.equal(h.speech.length, 0);
  }
});

test('cancellation while ACK is pending suppresses playback and accepted-result callbacks', async t => {
  const pending = deferred();
  const h = harness(t, { post: async route => route === '/api/canvas/edit' ? { document: docValue(1) } : pending.promise });
  const edit = h.canvas.edit('Change this.', { read: true }); await tick();
  assert(h.calls.some(call => call.route === '/api/canvas/ack'));
  h.canvas.cancel(false); pending.resolve({ acknowledged: true, document: docValue(1) }); await edit;
  assert.equal(h.speech.length, 0); assert.equal(h.results.length, 0);
});

test('new edit waits for the previous remote cancel to finish before dispatch', async t => {
  const cancelled = deferred();
  const h = harness(t, { post: async (route, body) => route === '/api/canvas/cancel' ? cancelled.promise
    : route === '/api/canvas/edit' ? { document: docValue(1) } : { acknowledged: true, document: docValue(body.canvasRevision) } });
  h.canvas.cancel(); const edit = h.canvas.edit('Now change this.'); await tick();
  assert.equal(h.calls.filter(call => call.route === '/api/canvas/edit').length, 0);
  cancelled.resolve({ cancelled: true }); await edit;
  assert.equal(h.calls.filter(call => call.route === '/api/canvas/edit').length, 1);
});

test('a mismatched or negative ACK cannot authorize browser speech', async t => {
  for (const acknowledgment of [{ acknowledged: false, document: docValue(1) }, { acknowledged: true, document: docValue(2) },
    { acknowledged: true, document: { ...docValue(1), sourceHash: 'wrong-source' } }]) {
    const h = harness(t, { post: async route => route === '/api/canvas/edit' ? { document: docValue(1) } : acknowledgment });
    await h.canvas.edit('Change this.', { read: true });
    assert.equal(h.speech.length, 0, 'Only the exact visible revision and source may authorize speech.');
    assert.equal(h.results.length, 0);
  }
});

test('a late restore response cannot resurrect a canvas after the user closes it', async t => {
  const restored = deferred(); const h = harness(t, { get: () => restored.promise });
  h.canvas.sync(); h.canvas.close(); restored.resolve({ document: docValue(9) }); await tick();
  assert.equal(h.canvas.active, false); assert.equal(h.canvas.document, null); assert.equal(h.candidates.length, 0);
});
