export const FINALE_URL = 'https://www.cerebras.ai/';

export function matchesFinaleCommand(text) {
  return typeof text === 'string'
    && text.toLowerCase().replace(/[\p{P}]/gu, ' ').replace(/\s+/g, ' ').trim() === 'showcase complete';
}

// A temporary presentation layer. It never edits the lesson or saved canvas.
export class ShowcaseFinale {
  constructor({ onStart = () => {}, onCancel = () => {}, navigate = url => globalThis.location.assign(url), durationMs = 6000, fadeMs = 900,
    document: doc = globalThis.document, clock = {} } = {}) {
    if (![durationMs, fadeMs].every(value => Number.isFinite(value) && value >= 0)) throw new RangeError('Finale durations must be finite and nonnegative.');
    this.doc = doc;
    this.onStart = onStart; this.onCancel = onCancel; this.navigate = navigate;
    this.durationMs = durationMs; this.fadeMs = fadeMs;
    this.now = clock.now || (() => performance.now());
    this.requestFrame = clock.requestFrame || (callback => requestAnimationFrame(callback));
    this.cancelFrame = clock.cancelFrame || (id => cancelAnimationFrame(id));
    this.active = false; this.destroyed = false; this.generation = 0; this.frame = null;
    this.onKey = event => {
      if (!this.active) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.cancel('escape'); }
      else if (event.key === 'Tab') { event.preventDefault(); this.button?.focus({ preventScroll: true }); }
    };
    this.onVisibility = () => { if (this.doc.hidden) this.cancel('hidden'); };
  }

  start() {
    if (this.destroyed || this.doc.hidden) return false;
    this.cancel('restarted');
    const serial = ++this.generation;
    this.active = true; this.phase = 'countdown'; this.previousFocus = this.doc.activeElement;
    this.build();
    this.doc.addEventListener('keydown', this.onKey, true);
    this.doc.addEventListener('visibilitychange', this.onVisibility);
    try { this.onStart(); } catch (error) { this.cancel('start-failed'); throw error; }
    if (!this.owns(serial)) return false;
    this.started = this.now(); this.updateProgress(0);
    this.button.focus({ preventScroll: true });
    this.queue(serial);
    return true;
  }

  build() {
    const doc = this.doc;
    const root = doc.createElement('section'); root.id = 'showcase-finale'; root.className = 'showcase-finale';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'showcase-thank-you'); root.setAttribute('aria-describedby', 'showcase-finale-help');
    root.style.setProperty('--finale-fade', `${this.fadeMs}ms`);
    const center = doc.createElement('div'); center.className = 'showcase-finale-center';
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 240 240'); svg.classList.add('showcase-finale-ring');
    svg.setAttribute('role', 'progressbar'); svg.setAttribute('aria-label', 'Countdown to Cerebras');
    svg.setAttribute('aria-valuemin', '0'); svg.setAttribute('aria-valuemax', '100');
    for (const name of ['track', 'progress']) {
      const circle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '120'); circle.setAttribute('cy', '120'); circle.setAttribute('r', '114'); circle.setAttribute('pathLength', '100');
      circle.classList.add(`showcase-finale-${name}`); svg.append(circle);
      if (name === 'progress') this.progress = circle;
    }
    const button = doc.createElement('button'); button.type = 'button'; button.id = 'showcase-thank-you';
    button.className = 'showcase-finale-button'; button.textContent = 'Thank you';
    button.setAttribute('aria-label', 'Thank you. Open Cerebras now.');
    button.addEventListener('click', () => { if (this.active && this.phase === 'countdown') this.beginFade(this.now()); });
    const help = doc.createElement('p'); help.id = 'showcase-finale-help'; help.className = 'showcase-finale-sr';
    help.textContent = `Opening the official Cerebras website after ${this.durationMs / 1000} seconds. Press Escape to return to your lesson.`;
    const shade = doc.createElement('div'); shade.className = 'showcase-finale-shade'; shade.setAttribute('aria-hidden', 'true');
    center.append(svg, button); root.append(center, help, shade);
    this.root = root; this.button = button; this.ring = svg;
    this.hiddenSiblings = [...doc.body.children].map(node => ({ node, inert: node.inert }));
    for (const { node } of this.hiddenSiblings) node.inert = true;
    this.previousOverflow = doc.body.style.overflow; doc.body.style.overflow = 'hidden';
    doc.body.append(root);
  }

  owns(serial) { return this.active && this.generation === serial; }
  queue(serial) { this.frame = this.requestFrame(() => this.tick(serial)); }
  updateProgress(value) {
    this.progress.style.strokeDashoffset = String(100 * (1 - value));
    this.ring.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  }
  beginFade(time) {
    if (!this.active || this.phase !== 'countdown') return;
    this.phase = 'fade'; this.fadeStarted = time; this.updateProgress(1);
    this.root.classList.add('is-leaving'); this.button.setAttribute('aria-disabled', 'true');
  }
  tick(serial) {
    if (!this.owns(serial)) return;
    this.frame = null;
    if (this.doc.hidden || !this.root.isConnected) { this.cancel(this.doc.hidden ? 'hidden' : 'removed'); return; }
    const time = this.now();
    if (this.phase === 'countdown') {
      const progress = this.durationMs === 0 ? 1 : Math.min(1, Math.max(0, (time - this.started) / this.durationMs));
      this.updateProgress(progress);
      if (progress === 1) this.beginFade(time);
    }
    if (this.phase === 'fade' && time - this.fadeStarted >= this.fadeMs) {
      // Mark terminal before navigating: a late frame or double click cannot repeat it.
      this.phase = 'navigated';
      try { this.navigate(FINALE_URL); } catch { this.cancel('navigation-failed'); }
      return;
    }
    if (this.phase !== 'navigated') this.queue(serial);
  }

  cancel(reason = 'cancelled') {
    const wasActive = this.active;
    this.active = false; this.generation += 1;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.doc.removeEventListener('keydown', this.onKey, true);
    this.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.root?.remove(); this.root = null; this.button = null; this.progress = null; this.ring = null;
    if (wasActive) {
      for (const { node, inert } of this.hiddenSiblings || []) node.inert = inert;
      this.doc.body.style.overflow = this.previousOverflow;
      const focus = this.previousFocus;
      if (focus?.isConnected && typeof focus.focus === 'function') focus.focus({ preventScroll: true });
      this.hiddenSiblings = []; this.previousFocus = null;
      this.onCancel(reason);
    }
  }
  destroy() { this.destroyed = true; this.cancel('destroyed'); }
}
