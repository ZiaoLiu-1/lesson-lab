import { spokenText } from './narration.js';
import { resolveTeachingFocus } from './focus.js';
import { createMotion, reconcileChildren } from './motion.js';
import { computeExample, expressionFor, formatFunction, materialFor } from './math.js';
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const ui = {
  lesson: null, state: null, config: null, connectionId: null, events: null,
  connected: false, connecting: false, controlBusy: false, fileBusy: false,
  active: null, committed: null, accepted: null, prepared: null, hasStarted: false,
  voice: null, voiceState: 'idle', capabilities: { recognition: false, synthesis: false, localVoices: [] },
  preferredVoice: '', appliedVoice: '', voiceOptionsKey: null,
  speechEngine: 'browser', preferredSpeechEngine: '', speechOptionsKey: null,
  continuous: null, continuousEnabled: false, continuousState: 'off', continuousEpoch: 0, continuousUtteranceId: null, continuousCapture: null,
  autoTeaching: null, teachingGeneration: 0, guidedAudio: false,
  audio: null, draftAnchor: null, draftStale: false, previewA: null, marker: null,
  lastMetrics: null, lastTimeline: [], quizKey: null, view: 'study', benchmark: null,
};
const kindLabels = { grounded: 'AI · lesson-based', extension: 'AI · added explanation', needs_review: 'AI · needs review' };
const statusLabels = { generating: 'Preparing an explanation', submitted: 'Request received', validating: 'Checking the response', committed: 'Showing the explanation', awaiting_ack: 'Confirming the visible reply', waiting_ack: 'Confirming the visible reply', complete: 'Reply ready', done: 'Reply ready' };
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const motionSamples = [];
const bridgeJobs = new Set();
const motion = createMotion({ reduced: () => motionPreference.matches || document.hidden, onSample(sample) {
  if (sample.samples) { motionSamples.push(sample); if (motionSamples.length > 12) motionSamples.shift(); }
  renderMotionStats();
} });
let graphNodes = null;
let graphValue = null;
let graphPage = null;
let haloTarget = null;
let haloValue = null;
let haloFrame = null;
let haloPaintTarget = null;
let haloDesired = null;
let renderedPage = null;
const entrySeen = new Set();
function setText(node, text) { const value = String(text ?? ''); if (node.textContent !== value) node.textContent = value; }
function renderMotionStats() {
  const host = $('motion-stats');
  if (!host) return;
  const last = [...motionSamples].reverse().find((item) => item.key === 'graph') || motionSamples.at(-1);
  setText(host, motionPreference.matches ? 'Reduced motion is enabled. Updates settle without movement.' : last
    ? `Last ${last.key.startsWith('note:') ? 'note' : last.key} transition: ${last.samples} measured rAF intervals · median ${last.medianMs.toFixed(1)} ms · longest ${last.maxMs.toFixed(1)} ms · ${last.over20Ms} over 20 ms. ${last.status === 'cancelled' ? 'Retargeted or stopped.' : 'Settled.'} These are browser callback intervals, not a measured paint rate.`
    : 'No animated transition measured yet. Change the example to collect actual browser frame intervals. A 60 Hz frame interval is about 16.7 ms; this is a target, not a guarantee.');
}
function finishViewMotion() { motion.cancel('scroll'); motion.cancel('focus'); motion.cancelAll({ complete: true }); }
async function settledView() { await motion.settled((key) => key !== 'focus'); await twoFrames(); }
function showPassageHalo(target, phase) {
  haloTarget = target;
  const overlay = $('passage-halo');
  overlay.dataset.phase = phase || 'paused';
  if (haloFrame !== null) return;
  haloFrame = requestAnimationFrame(() => { haloFrame = null; positionPassageHalo(); });
}
function positionPassageHalo() {
  const overlay = $('passage-halo');
  const target = haloTarget;
  if (!target?.isConnected || ui.view !== 'study' || document.hidden || !visible(target)) {
    motion.cancel('focus'); overlay.style.opacity = '0'; haloValue = null; haloDesired = null; return;
  }
  const rect = target.getBoundingClientRect();
  const to = { x: rect.left - 10, y: rect.top - 2, w: rect.width + 20, h: rect.height + 4, opacity: 1 };
  const changedTarget = haloPaintTarget !== target;
  if (!changedTarget && haloDesired && Object.keys(to).every((key) => to[key] === haloDesired[key])) return;
  haloPaintTarget = target; haloDesired = to;
  const from = haloValue || { ...to, opacity: 0 };
  const paint = (value) => {
    if (haloTarget !== target || !target.isConnected) return;
    haloValue = value;
    overlay.style.transform = `translate3d(${value.x}px, ${value.y}px, 0)`;
    overlay.firstElementChild.setAttribute('transform', `scale(${value.w / 100} ${value.h / 100})`);
    overlay.style.opacity = String(value.opacity);
  };
  // A frame belongs to its passage. Scrolling/resizing moves that frame directly;
  // only choosing a different passage starts a new transition.
  if (!changedTarget) { motion.cancel('focus'); paint(to); return; }
  void motion.to('focus', { from, to, duration: 360, update: paint });
}
function animateNotes(before, added) {
  const addedSet = new Set(added);
  for (const node of $('live-notes').children) {
    const id = node.dataset.passageId;
    const key = `note:${id}`;
    const prior = before.get(id);
    const rect = node.getBoundingClientRect();
    const first = addedSet.has(node) && !entrySeen.has(`${ui.lesson.id}:${ui.lesson.version}:${id}`);
    entrySeen.add(`${ui.lesson.id}:${ui.lesson.version}:${id}`);
    const offset = prior ? prior.top - rect.top : first ? 10 : 0;
    if (!first && Math.abs(offset) < 1) continue;
    void motion.to(key, { from: { y: offset, opacity: first ? 0 : 1 }, to: { y: 0, opacity: 1 }, duration: 300, update(value) {
      if (!node.isConnected) return;
      node.style.transform = `translate3d(0, ${value.y}px, 0)`; node.style.opacity = String(value.opacity);
      if (haloTarget === node) showPassageHalo(node, teachingFocus()?.phase);
    } });
  }
}
let noticeTimer;
let timer;
let speechGeneration = 0;
try { ui.preferredVoice = localStorage.getItem('lesson-lab.local-voice') || ''; } catch { /* Voice preferences are optional. */ }
try { ui.preferredSpeechEngine = localStorage.getItem('lesson-lab.speech-output') || ''; } catch { /* Output selection is optional. */ }

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}
function svg(tag, attributes, text) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes || {})) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = String(text);
  return el;
}
function number(value) { return Number.isFinite(Number(value)) ? String(Number(Number(value).toFixed(3))) : '—'; }
function duration(value) { return Number.isFinite(value) ? (value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`) : 'Not measured'; }
function facts(a, power = pageState()?.power ?? 2) { return computeExample(a, power); }
function preparedPage(id = ui.state?.pageId) {
  const raw = ui.lesson?.pages.find((item) => item.id === id);
  const content = ui.state?.pages?.[id];
  return raw && content ? materialFor(raw, computeExample(content.a, content.power ?? 2)) : raw;
}
function page() { return preparedPage(); }
function pageState() { return ui.state?.pages?.[ui.state.pageId]; }
function interpolate(text, a = pageState()?.a ?? 1, power = pageState()?.power ?? 2) {
  const values = facts(a, power);
  return String(text ?? '').replace(/\{([a-zA-Z]+)\}/g, (match, key) => Object.hasOwn(values, key) ? number(values[key]) : match);
}
function anchor() {
  const s = ui.state;
  return s && { connectionId: ui.connectionId, revision: s.revision, viewEpoch: s.viewEpoch, pageId: s.pageId, selectedId: s.selectedId };
}
function anchorMatches(value) {
  const current = anchor();
  return current && value && ['connectionId', 'revision', 'viewEpoch', 'pageId', 'selectedId'].every((key) => current[key] === value[key]);
}
function currentStep() {
  const cursor = ui.state?.cursor;
  return preparedPage(cursor?.pageId)?.steps?.[cursor.stepIndex] ?? null;
}
function teachingFocus() {
  const focus = resolveTeachingFocus(ui);
  const reply = ui.accepted;
  const host = $('live-answer');
  if (focus && ui.marker?.kind === 'reply' && reply?.turnId === ui.marker.id && host?.dataset.turnId === reply.turnId) {
    return { ...focus, targetId: host.dataset.passageId, title: reply.unit.title || 'Current explanation' };
  }
  return focus;
}
function teachingFollowKey(marker = ui.marker) {
  return marker ? [marker.connectionId, marker.kind, marker.id, marker.revision].join(':') : null;
}
function cancelTeachingFollow() {
  motion.cancel('scroll');
  ui.followSuppressed = teachingFollowKey();
  if (ui.active) ui.active.userScrolled = true;
}
function setTeachingMarker(kind, id, targetId, state = ui.state, phase = 'ready') {
  ui.marker = { kind, id, targetId, pageId: state.pageId, revision: state.revision, viewEpoch: state.viewEpoch, connectionId: ui.connectionId, phase };
}
function renderTeachingFocus() {
  const focus = teachingFocus();
  for (const block of document.querySelectorAll('[data-passage-id]')) {
    const active = block.dataset.passageId === focus?.targetId;
    block.classList.toggle('is-explaining', active);
    if (active) { block.dataset.explanationPhase = focus.phase; block.setAttribute('aria-current', 'step'); }
    else { delete block.dataset.explanationPhase; block.removeAttribute('aria-current'); }
    const label = block.querySelector('.explanation-label');
    if (label) { label.hidden = !active; setText(label, active ? focus.label : ''); }
  }
  $('teaching-location').hidden = !focus;
  setText($('teaching-location-label'), focus ? `${focus.label} · ${focus.title}` : '');
  const target = focus ? [...document.querySelectorAll('[data-passage-id]')].find((node) => node.dataset.passageId === focus.targetId) : null;
  showPassageHalo(target, focus?.phase);
}
function followTeachingFocus(force = false) {
  const focus = teachingFocus();
  if (!focus || ui.view !== 'study' || (!force && !$('follow-teaching').checked)) return;
  const key = teachingFollowKey();
  if (!force && (ui.followSuppressed === key || ui.followAttemptKey === key)) return;
  if (force) ui.followSuppressed = null;
  ui.followAttemptKey = key;
  focusTarget(focus.targetId);
}
function setError(message = '') { $('global-error').textContent = message; $('global-error').hidden = !message; }
function notice(message) {
  clearTimeout(noticeTimer); $('global-notice').textContent = message; $('global-notice').hidden = !message;
  if (message) noticeTimer = setTimeout(() => { $('global-notice').hidden = true; }, 6500);
}
function announce(message) { $('announcer').textContent = message; }
async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  let body;
  try { body = await response.json(); } catch { throw new Error('The local server returned an unreadable response. Reconnect and try again.'); }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || 'The request could not be completed.');
    error.code = body?.error?.code || body?.error || String(response.status);
    throw error;
  }
  return body;
}
function post(path, body, signal) { return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) }); }
function twoFrames() { return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); }
function visible(el) {
  if (!el || document.hidden) return false;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < unobscuredBottom() && rect.right > 0 && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
}
function unobscuredBottom() {
  const dock = $('continuous-voice');
  if (!dock || getComputedStyle(dock).position !== 'fixed') return innerHeight;
  const rect = dock.getBoundingClientRect();
  return rect.height > 0 ? Math.min(innerHeight, rect.top - 12) : innerHeight;
}
function markDraftStale() {
  if (ui.draftAnchor && $('question').value.trim()) ui.draftStale = true;
  ui.draftAnchor = null;
  $('draft-warning').hidden = !ui.draftStale;
}
function stopAudio() {
  // Cancel reads that are still waiting for motion, before an audio object exists.
  speechGeneration += 1;
  ui.canvas?.stopSpeech();
  ui.continuous?.setPlayback(false);
  const audio = ui.audio;
  if (!audio) return;
  ui.audio = null;
  if (ui.marker) ui.marker.phase = 'paused';
  audio.cancelled = true;
  audio.cancel?.();
  if (audio.identity.turnId && ui.accepted?.turnId === audio.identity.turnId) {
    ui.accepted.speechUnavailable = true;
    renderConversation();
  }
  if (ui.connectionId === audio.connectionId) {
    // Ready-but-not-started audio also needs to be invalidated on the server.
    const afterStart = audio.startRequest ? audio.startRequest.catch(() => {}) : Promise.resolve();
    void afterStart.then(() => post('/api/audio', { connectionId: audio.connectionId, phase: 'cancel', ...audio.identity })).catch(() => {});
  }
  $('voice-status').textContent = 'Local reading stopped. No step was marked complete.';
  $('stop-audio').hidden = true;
  renderTeachingFocus();
}
function invalidateLocal(reason = 'Stopped', { preserveDraft = false, preserveCapture = false, teachingOwner = null } = {}) {
  ui.canvas?.cancel();
  if (!teachingOwner || !ownsAutomaticTeaching(teachingOwner)) stopAutomaticTeaching();
  if (!preserveCapture) { ui.continuous?.invalidate(); ui.continuousCapture = null; }
  if (ui.marker) ui.marker.phase = 'paused';
  finishViewMotion();
  if (ui.active) {
    const old = ui.active;
    if (old.bridgeId) void reportBridge(old.bridgeId, 'failed');
    old.controller.abort(); old.cancelled = true;
    ui.lastTimeline = [...old.timeline, { status: reason, elapsedMs: performance.now() - old.started }];
    ui.lastMetrics = { uiResponseMs: old.uiResponseMs, renderedMs: old.renderedMs ?? null, cancelled: true };
  }
  ui.active = null;
  clearInterval(timer);
  stopAudio();
  ui.voice?.cancel();
  if (!preserveDraft) markDraftStale();
  renderStatus(); renderMetrics(); renderTeachingFocus();
}
function setConnected(value, text) {
  ui.connected = value;
  if (!value && ui.continuousEnabled) endContinuousConversation('Conversation ended because the connection changed.', { cancelTurn: false });
  $('connection-status').dataset.connected = String(value);
  $('connection-status').textContent = text || (value ? 'Local session' : 'Disconnected');
  $('reconnect').hidden = value || ui.connecting;
  renderControls(); renderTeachingFocus();
}
function applyState(state) {
  if (!state || typeof state !== 'object') return;
  if (ui.state && state.lessonId === ui.state.lessonId && state.revision < ui.state.revision) return;
  ui.state = state;
  renderState();
  ui.canvas?.sync();
}
async function adoptSession(data) {
  endContinuousConversation('Conversation is off after opening a session.', { cancelTurn: false });
  ui.events?.close();
  invalidateLocal('Session changed');
  ui.connectionId = data.connectionId;
  ui.connected = false;
  setError();
  ui.lesson = data.lesson;
  ui.state = data.state;
  ui.config = data.config || ui.config || { keyConfigured: false };
  ui.speechEngine = ui.config.nativeSpeech === true && ui.preferredSpeechEngine !== 'browser' ? 'native' : 'browser';
  ui.accepted = null; ui.committed = null; ui.prepared = null; ui.previewA = null; ui.quizKey = null;
  ui.hasStarted = Boolean(data.state?.cursor?.delivered || data.state?.cursor?.stepIndex > 0 || data.state?.resumePoint || (data.state?.delivery && data.state.delivery !== 'idle'));
  ui.marker = null; graphPage = null; renderedPage = null; haloTarget = null; haloValue = null; haloPaintTarget = null; haloDesired = null; ui.followAttemptKey = null; ui.followSuppressed = null; entrySeen.clear();
  if (ui.hasStarted && currentStep() && ui.state.cursor.pageId === ui.state.pageId) {
    setTeachingMarker('lesson', currentStep().id, currentStep().targetId, ui.state, ui.state.cursor.delivered ? 'done' : 'paused');
  }
  ui.lastMetrics = null; ui.lastTimeline = [];
  if (!ui.connectionId || !ui.lesson?.pages?.length || !ui.state) throw new Error('The local session is incomplete. Check the server and reconnect.');
  const models = data.config?.models || [{ id: 'qwen', label: 'Qwen · Cerebras' }, { id: 'gptoss', label: 'GPT-OSS · Cerebras' }];
  $('model-select').replaceChildren(...models.map((model) => { const option = element('option', '', model.label); option.value = model.id; return option; }));
  $('setup-banner').hidden = ui.config.keyConfigured === true;
  renderState(); renderMetrics();
  ui.canvas?.sync();
  const events = new EventSource(`/api/events?connectionId=${encodeURIComponent(ui.connectionId)}`);
  ui.events = events;
  const connectionId = ui.connectionId;
  events.onopen = () => { if (ui.events === events) setConnected(true); };
  events.onerror = () => {
    if (ui.events !== events) return;
    events.close(); ui.events = null; invalidateLocal('Connection interrupted');
    setConnected(false, 'Connection interrupted');
    setError('The live connection was interrupted. Reconnect to restore a fresh session; unfinished audio will not replay.');
  };
  events.addEventListener('replaced', () => {
    if (ui.events !== events) return;
    events.close();
    ui.events = null;
    invalidateLocal('Another session became active');
    setConnected(false, 'Open in another tab');
    setError('Another tab or session now controls this lesson. Reconnect here when you want to continue in this tab.');
  });
  for (const name of ['state', 'status', 'commit', 'failure', 'bridge_command']) {
    events.addEventListener(name, (event) => {
      if (ui.connectionId !== connectionId || ui.events !== events) return;
      try {
        const data = JSON.parse(event.data);
        if (name === 'state') applyState(data.state);
        if (name === 'status') onStatus(data);
        if (name === 'commit') void onCommit(data);
        if (name === 'failure') onFailure(data);
        if (name === 'bridge_command') void onBridgeCommand(data);
      } catch { setError('A live update could not be read. Reconnect before continuing.'); }
    });
  }
}
async function connect() {
  if (ui.connecting) return;
  ui.connecting = true;
  ui.events?.close(); invalidateLocal('Reconnecting');
  setConnected(false, 'Connecting…'); setError();
  try { await adoptSession(await request('/api/session')); }
  catch (error) { setError(error.message); setConnected(false); }
  finally { ui.connecting = false; $('reconnect').hidden = ui.connected; renderControls(); }
}
async function control(action, payload = {}, { quiet = false, bridgeId = null, preserveCapture = false, autoRead = true, teachingOwner = null } = {}) {
  if (!ui.connectionId || !ui.connected || ui.controlBusy || ui.fileBusy) return null;
  if (!bridgeId && !teachingOwner && (ui.continuousEnabled || ui.guidedAudio) && ['page', 'start', 'continue', 'next'].includes(action)) {
    return beginAutomaticLesson({ action: action === 'page' ? 'start' : action, pageId: action === 'page' ? payload.pageId : null });
  }
  ui.controlBusy = true;
  invalidateLocal(action === 'cancel' ? 'Stopped' : 'View changed', { preserveCapture, teachingOwner });
  setError(); renderControls();
  const connectionId = ui.connectionId;
  try {
    const data = await post('/api/control', { connectionId, action, ...payload, ...(bridgeId ? { bridgeId } : {}) });
    if (connectionId !== ui.connectionId) return null;
    ui.previewA = null;
    ui.accepted = null;
    ui.committed = null;
    if (action === 'page') { ui.hasStarted = false; ui.marker = null; }
    else if (ui.marker?.kind === 'reply' && action !== 'cancel') ui.marker = null;
    if (!['start', 'continue', 'next', 'complete_step'].includes(action)) ui.prepared = null;
    if (data.step) { ui.prepared = data.step; ui.hasStarted = true; }
    if (data.step) setTeachingMarker('lesson', data.step.id, data.step.targetId, data.state);
    else if (action === 'complete_step' && currentStep()) setTeachingMarker('lesson', currentStep().id, currentStep().targetId, data.state, 'done');
    applyState(data.state);
    if (data.step) {
      followTeachingFocus(Boolean(bridgeId));
      if (autoRead && !teachingOwner && !bridgeId && $('read-replies').checked && canSpeak()) void speakPrepared(data.step);
    }
    if (action === 'undo' && !quiet) notice('The previous page content was restored. Your discussion stays in the session.');
    if (action === 'page') $('lesson-heading').focus({ preventScroll: true });
    return data;
  } catch (error) { ui.previewA = null; renderGraph(); if (!quiet) setError(error.message); return null; }
  finally { ui.controlBusy = false; renderControls(); }
}
async function reportBridge(id, status, captured = anchor()) {
  if (!bridgeJobs.has(id)) return;
  bridgeJobs.delete(id);
  try {
    await post('/api/bridge/result', { id, connectionId: captured.connectionId, status,
      revision: captured.revision, viewEpoch: captured.viewEpoch, visible: status === 'completed' });
  } catch (error) { if (status === 'completed') setError(`Codex could not confirm the displayed result: ${error.message}`); }
}
async function onBridgeCommand({ id }) {
  if (typeof id !== 'string' || bridgeJobs.has(id)) return;
  bridgeJobs.add(id);
  try {
    const claim = await post('/api/bridge/claim', { id, connectionId: ui.connectionId });
    if (ui.continuousEnabled) throw new Error('End the direct conversation before using Codex controls.');
    if (document.hidden || ui.view !== 'study' || ui.controlBusy || ui.fileBusy || ui.previewA !== null) throw new Error('Keep the study page visible and finish the current page change before using Codex.');
    if (!anchorMatches(claim.anchor)) throw new Error('The study page changed before this Codex command arrived.');
    // Native Voice owns the audio for remote commands. Never start a second voice.
    $('read-replies').checked = false;
    $('voice-status').textContent = 'Controlled from Codex. Native Voice handles narration; browser auto-reading is off.';
    if (claim.command.kind === 'ask') {
      const turn = await ask(null, claim);
      if (!turn) throw new Error('The study page could not start this question.');
      return; // The actual visible-reply ACK completes this job in onCommit.
    }
    const data = await control(claim.command.action, claim.command.payload, { bridgeId: id });
    if (!data) throw new Error('The study page could not apply this control.');
    const captured = anchor();
    const target = data.step ? [...document.querySelectorAll('[data-passage-id]')].find(item => item.dataset.passageId === data.step.targetId)
      : claim.command.action === 'parameter' ? $('lesson-graph')
      : claim.command.action === 'select' ? [...document.querySelectorAll('[data-passage-id]')].find(item => item.dataset.passageId === claim.command.payload.selectedId)
      : claim.command.action === 'page' ? $('lesson-heading') : $('study-view');
    if (target && !visible(target)) {
      const rect = target.getBoundingClientRect();
      const top = Math.max(0, scrollY + rect.top - Math.max(40, (innerHeight - rect.height) / 2));
      void motion.to('scroll', { from: { y: scrollY }, to: { y: top }, duration: 360,
        update(value) { if (anchorMatches(captured)) window.scrollTo({ top: value.y, behavior: 'instant' }); } });
    }
    await twoFrames(); await motion.settled(); await twoFrames();
    if (!anchorMatches(captured) || !visible(target) || ui.view !== 'study') throw new Error('The page changed before the Codex action was confirmed.');
    await reportBridge(id, 'completed', captured);
  } catch (error) { await reportBridge(id, 'failed'); setError(error.message || 'The Codex command could not finish.'); }
}
function focusTarget(id, scroll = true) {
  const target = typeof id === 'string' ? [...document.querySelectorAll('[data-passage-id]')].find((item) => item.dataset.passageId === id) : id;
  if (!target || !scroll) return;
  if (visible(target)) return;
  const rect = target.getBoundingClientRect();
  const bottom = unobscuredBottom();
  if (rect.top >= 40 && rect.bottom <= bottom - 20) return;
  const offset = rect.height > bottom - 80 ? 40 : (bottom - rect.height) / 2;
  const top = Math.min(Math.max(0, document.documentElement.scrollHeight - innerHeight), Math.max(0, scrollY + rect.top - offset));
  void motion.to('scroll', { from: { y: scrollY }, to: { y: top }, duration: 360, update(value) {
    if (target.isConnected && ui.view === 'study') window.scrollTo({ top: value.y, behavior: 'instant' });
  } });
}

function renderContents() {
  $('course-title').textContent = ui.lesson.title;
  $('course-subtitle').textContent = ui.lesson.subtitle || '';
  const index = ui.lesson.pages.findIndex((item) => item.id === ui.state.pageId);
  reconcileChildren($('contents'), ui.lesson.pages, { key: (item) => item.id, create(item) {
    const button = element('button'); button.type = 'button'; button.dataset.pageId = item.id;
    button.append(element('span'), element('span'));
    button.addEventListener('click', () => { if (ui.continuousEnabled || item.id !== ui.state.pageId) void control('page', { pageId: item.id }); });
    return button;
  }, update(button, item) {
    setText(button.children[0], String(ui.lesson.pages.indexOf(item) + 1).padStart(2, '0')); setText(button.children[1], item.title);
    if (item.id === ui.state.pageId) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  } });
  $('page-count').textContent = `${index + 1} / ${ui.lesson.pages.length}`;
  $('course-progress').textContent = `Page ${index + 1} of ${ui.lesson.pages.length}. Your place and notes are kept in this local session.`;
}
function renderTeaching() {
  const step = currentStep();
  const questionPaused = ui.state.mode === 'question' || Boolean(ui.state.resumePoint);
  const interrupted = questionPaused || ui.state.delivery === 'interrupted';
  const cursorPage = ui.lesson.pages.find((item) => item.id === ui.state.cursor?.pageId);
  $('teaching-mode').textContent = questionPaused ? 'A question paused your lesson' : interrupted ? 'Prepared lesson paused' : ui.state.cursor?.delivered ? 'Step complete' : 'Prepared lesson';
  $('step-count').textContent = step ? `${ui.state.cursor.stepIndex + 1} / ${cursorPage.steps.length}` : '';
  setText($('step-text'), ui.hasStarted && step ? interpolate(step.text, ui.state.pages[cursorPage.id]?.a ?? 1, ui.state.pages[cursorPage.id]?.power ?? 2) : 'Start learning for a guided explanation, or select a passage and ask your own question.');
  $('start-lesson').hidden = ui.hasStarted || interrupted || !step;
  $('continue-lesson').hidden = !interrupted;
  $('mark-step').hidden = !ui.hasStarted || interrupted || !step || ui.state.cursor.delivered;
  $('next-step').hidden = !ui.hasStarted || interrupted || !step || !ui.state.cursor.delivered;
  if (step && ui.state.cursor.stepIndex + 1 >= cursorPage.steps.length) $('next-step').hidden = true;
  $('read-step').hidden = !ui.hasStarted || interrupted || !step;
}
const graphX = (x) => 53 + (x + 1.1) / 3.3 * 548;
function graphY(y, value = graphValue) { return 290 - (y - (value?.yMin ?? -40)) / ((value?.yMax ?? 60) - (value?.yMin ?? -40)) * 266; }
function graphCoefficients(a, power) { return Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`c${i + 1}`, power === i + 1 ? a : 0])); }
function graphFunction(value, x) { return Array.from({ length: 5 }, (_, i) => (value[`c${i + 1}`] || 0) * x ** (i + 1)).reduce((sum, term) => sum + term, 0); }
function graphFacts(value) {
  const y = graphFunction(value, 1), endY = graphFunction(value, 2);
  const slope = Array.from({ length: 5 }, (_, i) => (i + 1) * (value[`c${i + 1}`] || 0)).reduce((sum, term) => sum + term, 0);
  return { y, endY, slope, tangentEndY: y + slope, tangentChange: slope, curveChange: endY - y, secantSlope: endY - y };
}
function graphExtent(power, maxA = 10) {
  const f = computeExample(maxA, power);
  const low = Math.min(0, maxA * (-1.05) ** power, f.y + f.slope * (-2.05));
  const high = Math.max(maxA * 2.12 ** power, f.y + f.slope * 1.12);
  const rawStep = (high - low) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((n) => n * magnitude).find((n) => n >= rawStep);
  const yMin = Math.floor(low / step) * step;
  return { yMin, yMax: yMin + Math.ceil((high - yMin) / step) * step };
}
function initializeGraph() {
  if (graphNodes) return;
  const plot = $('lesson-graph');
  const nodes = [svg('title', { id: 'graph-title' }), svg('desc', { id: 'graph-description' })];
  const grid = Array.from({ length: 6 }, () => ({ line: svg('line', { stroke: '#e2e7dc', 'stroke-width': 1 }), text: svg('text', { 'text-anchor': 'end' }) }));
  for (const row of grid) nodes.push(row.line, row.text);
  const xAxis = svg('line', { stroke: '#a8b5a5', 'stroke-width': 1.2 });
  const yAxis = svg('line', { stroke: '#a8b5a5', 'stroke-width': 1.2 });
  nodes.push(xAxis, yAxis);
  const ticks = [-1, 0, 1, 2].map((x) => ({ x, line: svg('line', { stroke: '#a8b5a5' }), text: svg('text', { 'text-anchor': 'middle' }, number(x)) }));
  for (const tick of ticks) nodes.push(tick.line, tick.text);
  const xLabel = svg('text', {}, 'x'); nodes.push(xLabel, svg('text', { x: graphX(0) - 18, y: 15 }, 'y'));
  const series = {
    secant: svg('line', { stroke: '#a86f2c', 'stroke-width': 2.7, 'data-graph-key': 'secant' }),
    tangent: svg('line', { stroke: '#4b70a6', 'stroke-width': 2.5, 'stroke-dasharray': '7 4', 'data-graph-key': 'tangent' }),
    curve: svg('path', { fill: 'none', stroke: '#285c45', 'stroke-width': 3.4, 'data-graph-key': 'curve' }),
    point: svg('circle', { r: 5.5, fill: '#285c45', stroke: '#fcfaf4', 'stroke-width': 2, 'data-graph-key': 'point' }),
    pointLabel: svg('text', { class: 'graph-emphasis' }),
    endpoint: svg('circle', { r: 4.5, fill: '#285c45', 'data-graph-key': 'endpoint' }),
    endpointLabel: svg('text', { 'text-anchor': 'end', class: 'graph-emphasis' }),
  };
  graphNodes = { ...series, grid, ticks, xAxis, yAxis, xLabel };
  plot.replaceChildren(...nodes, ...Object.values(series));
  $('graph-legend').replaceChildren(element('span'), element('span', 'legend-tangent'), element('span', 'legend-secant'));
  const tangent = element('dl'); tangent.append(element('dt', '', 'Tangent change'), element('dd'));
  const curve = element('dl'); curve.append(element('dt', '', 'Curve change'), element('dd'));
  $('computed-comparison').replaceChildren(tangent, curve, element('p'));
}
function graphAttributes(node, attributes) { for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); }
function drawGraph(value, target, progress) {
  graphValue = value;
  const f = graphFacts(value), moving = progress < 1;
  const targetPower = [1, 2, 3, 4, 5].find((p) => target[`c${p}`] !== 0);
  const targetA = target[`c${targetPower}`];
  const activePowers = [1, 2, 3, 4, 5].filter((p) => Math.abs(value[`c${p}`]) > 1e-9);
  const mixed = activePowers.length > 1;
  const shownPower = activePowers[0] || targetPower;
  const shownA = value[`c${shownPower}`];
  const functionLabel = mixed ? `Transition to ${formatFunction(targetA, targetPower)}` : formatFunction(Number(number(shownA)), shownPower);
  $('lesson-graph').dataset.motion = moving ? 'transitioning' : 'settled';
  $('lesson-graph').dataset.displayedA = mixed ? '' : String(shownA);
  $('lesson-graph').dataset.targetA = String(targetA);
  $('lesson-graph').dataset.power = String(targetPower);
  setText($('graph-heading'), functionLabel);
  setText($('graph-title'), mixed ? 'Intermediate function shape during a code update' : functionLabel);
  setText($('graph-description'), `At x=1 the displayed curve has y=${number(f.y)} and slope=${number(f.slope)}; at x=2, y=${number(f.endY)}.${moving ? ' Curve and axes are transitioning; lesson text and code use the confirmed target function.' : ''}`);
  setText($('parameter-status'), moving ? 'Function transition · the graph is interpolating to the confirmed code. Lesson text uses the target function.' : ui.previewA !== null ? 'Preview · release to apply this value before asking.' : `At x = 1: y = ${number(f.y)}, local slope = ${number(f.slope)}.`);
  const n = graphNodes;
  for (const [index, row] of n.grid.entries()) {
    const y = value.yMin + (value.yMax - value.yMin) * index / 5;
    graphAttributes(row.line, { x1: graphX(-1.05), y1: graphY(y, value), x2: graphX(2.12), y2: graphY(y, value) });
    graphAttributes(row.text, { x: 42, y: graphY(y, value) + 4 }); setText(row.text, number(y));
  }
  graphAttributes(n.xAxis, { x1: graphX(-1.05), y1: graphY(0, value), x2: graphX(2.16), y2: graphY(0, value) });
  graphAttributes(n.yAxis, { x1: graphX(0), y1: graphY(value.yMin, value), x2: graphX(0), y2: graphY(value.yMax, value) });
  graphAttributes(n.xLabel, { x: graphX(2.16), y: graphY(0, value) + 19 });
  for (const tick of n.ticks) {
    graphAttributes(tick.line, { x1: graphX(tick.x), y1: graphY(0, value) - 3, x2: graphX(tick.x), y2: graphY(0, value) + 4 });
    graphAttributes(tick.text, { x: graphX(tick.x), y: graphY(0, value) + 20 });
  }
  const tangentStart = -1.05, tangentEnd = tangentStart + 3.17 * value.tangent;
  graphAttributes(n.tangent, { x1: graphX(tangentStart), y1: graphY(f.y + f.slope * (tangentStart - 1), value), x2: graphX(tangentEnd), y2: graphY(f.y + f.slope * (tangentEnd - 1), value), opacity: value.tangent });
  const secantX = 1 + value.secant;
  graphAttributes(n.secant, { x1: graphX(1), y1: graphY(f.y, value), x2: graphX(secantX), y2: graphY(f.y + f.secantSlope * value.secant, value), opacity: value.secant });
  n.curve.setAttribute('d', Array.from({ length: 97 }, (_, i) => { const x = -1.05 + i / 96 * 3.17; return `${i ? 'L' : 'M'}${graphX(x).toFixed(2)},${graphY(graphFunction(value, x), value).toFixed(2)}`; }).join(' '));
  graphAttributes(n.point, { cx: graphX(1), cy: graphY(f.y, value) });
  graphAttributes(n.pointLabel, { x: graphX(1) + 13, y: graphY(f.y, value) + 22 }); setText(n.pointLabel, `(1, ${number(f.y)})`);
  graphAttributes(n.endpoint, { cx: graphX(2), cy: graphY(f.endY, value), opacity: value.endpoint });
  graphAttributes(n.endpointLabel, { x: graphX(2) - 10, y: graphY(f.endY, value) - 13, opacity: value.endpoint }); setText(n.endpointLabel, `(2, ${number(f.endY)})`);
  const legend = $('graph-legend').children;
  setText(legend[0], mixed ? 'Curve · intermediate shape' : `Curve · ${formatFunction(Number(number(shownA)), shownPower)}`);
  setText(legend[1], `Tangent · slope ${number(f.slope)}`); legend[1].hidden = !target.tangent;
  setText(legend[2], `Secant · slope ${number(f.secantSlope)}`); legend[2].hidden = !target.secant;
  const comparison = $('computed-comparison'); comparison.hidden = !target.comparison;
  if (target.comparison) {
    setText(comparison.children[0].lastChild, number(f.tangentChange)); setText(comparison.children[1].lastChild, number(f.curveChange));
    setText(comparison.lastChild, `From x = 1 to x = 2: the tangent goes from ${number(f.y)} to ${number(f.tangentEndY)}; the curve goes from ${number(f.y)} to ${number(f.endY)}.${moving ? ' Values follow the moving graph.' : ''}`);
  }
}
function renderGraph() {
  if (!ui.state || !pageState()) return;
  initializeGraph();
  const content = pageState(), a = ui.previewA ?? content.a, power = content.power ?? 2;
  const scene = content.scene || {};
  const target = { ...graphCoefficients(a, power), ...graphExtent(power, ui.lesson.example?.maxA ?? 10), tangent: Number(Boolean(scene.tangent)), secant: Number(Boolean(scene.secant)), endpoint: Number(Boolean(scene.secant || scene.comparison)), comparison: Number(Boolean(scene.comparison)) };
  $('parameter').min = ui.lesson.example?.minA ?? 0.5; $('parameter').max = ui.lesson.example?.maxA ?? 10;
  if (document.activeElement !== $('parameter') || ui.previewA === null) $('parameter').value = a;
  setText($('parameter-value'), number(a));
  setText($('live-function-code'), `function f(x) { return ${content.functionCode || expressionFor(content.a, power)}; }`);
  setText($('graph-footnote'), `At x = 1 · compare with x = 2 · y-axis: ${number(target.yMin)} to ${number(target.yMax)}. The scale stays fixed while changing this coefficient.${ui.previewA !== null ? ' Slider preview has not changed the saved code yet.' : ''}`);
  const key = `${ui.lesson.id}:${ui.lesson.version}:${ui.state.pageId}`;
  const changedPage = graphPage !== key;
  if (changedPage) { motion.cancel('graph'); graphPage = key; graphValue = target; }
  void motion.to('graph', { from: graphValue || target, to: target, duration: changedPage ? 0 : 420, update: (value, progress) => drawGraph(value, target, progress) });
}

function selectTarget(id) { if (window.getSelection()?.toString()) return; void control('select', { selectedId: id }); }
function selectable(el, id) {
  el.dataset.targetId = id; el.tabIndex = 0; el.setAttribute('role', 'button');
  el.setAttribute('aria-pressed', String(ui.state.selectedId === id));
  el.addEventListener('click', () => selectTarget(id));
  el.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void control('select', { selectedId: id }); } });
}
function renderBlocks(layoutBefore = null) {
  reconcileChildren($('lesson-blocks'), page().blocks || [], { key: (block) => block.id, create(block) {
    const article = element('section', 'lesson-block'); selectable(article, block.id); article.dataset.passageId = block.id;
    const label = element('span', 'explanation-label'); label.hidden = true;
    article.append(label, element('span', 'block-focus'), element('h3'), element('p'), element('p', 'formula'), element('span', 'source-tag', 'Prepared material'));
    return article;
  }, update(article, block) {
    article.setAttribute('aria-pressed', String(ui.state.selectedId === block.id));
    setText(article.querySelector('.block-focus'), ui.state.selectedId === block.id ? 'In focus' : 'Focus ↗');
    setText(article.querySelector('h3'), block.title); setText(article.children[3], interpolate(block.text));
    setText(article.children[4], interpolate(block.formula)); article.children[4].hidden = !block.formula;
    setText(article.children[5], block.materialKind === 'program-derived' ? 'Program-derived material' : 'Prepared material');
  } });
  const notes = pageState().notes || [];
  const samePage = renderedPage === `${ui.lesson.id}:${ui.lesson.version}:${ui.state.pageId}`;
  const before = layoutBefore || new Map(samePage ? [...$('live-notes').children].map((node) => [node.dataset.passageId, node.getBoundingClientRect()]) : []);
  $('live-notes-section').hidden = !notes.length;
  setText($('note-count'), `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`);
  const result = reconcileChildren($('live-notes'), notes, { key: (note) => note.id, create(note) {
    const article = element('article', 'live-note'); article.dataset.passageId = note.id;
    const label = element('span', 'explanation-label'); label.hidden = true;
    article.append(label, element('span', 'source-tag'), element('h4'), element('p'), element('div', 'note-source', 'Saved explanation · the current graph may use a different function or coefficient.'), element('div', 'note-source'));
    const actions = element('div', 'note-actions');
    const focus = element('button', 'text-button'); focus.type = 'button'; focus.dataset.targetId = note.id;
    focus.addEventListener('click', () => void control('select', { selectedId: note.id }));
    const flag = element('button', 'text-button'); flag.type = 'button';
    flag.addEventListener('click', () => void control('review_note', { noteId: note.id }));
    actions.append(focus, flag); article.append(actions); return article;
  }, update(article, note) {
    const focused = ui.state.selectedId === note.id;
    article.classList.toggle('is-focused', focused);
    article.children[1].className = `source-tag ${note.kind === 'needs_review' ? 'review' : 'ai'}`;
    setText(article.children[1], kindLabels[note.kind] || 'AI-generated'); setText(article.children[2], note.title || 'A closer look'); setText(article.children[3], note.text);
    setText(article.children[5], sourceNames(note.sourceIds)); article.children[5].hidden = !note.sourceIds?.length;
    const [focus, flag] = article.lastChild.children;
    setText(focus, focused ? 'Note in focus' : 'Focus this note ↗'); focus.setAttribute('aria-pressed', String(focused));
    setText(flag, note.kind === 'needs_review' ? 'Flagged for review' : 'Flag for review'); flag.dataset.flagged = String(note.kind === 'needs_review'); flag.disabled = note.kind === 'needs_review';
  }, remove(node) { motion.cancel(`note:${node.dataset.passageId}`); node.remove(); } });
  if (samePage) animateNotes(before, result.added);
  else for (const note of notes) entrySeen.add(`${ui.lesson.id}:${ui.lesson.version}:${note.id}`);
  renderedPage = `${ui.lesson.id}:${ui.lesson.version}:${ui.state.pageId}`;
  renderTeachingFocus();
}

function sourceNames(ids) { return (ids || []).map((id) => ui.lesson.sources.find((source) => source.id === id)?.title || id).join(' · '); }
function renderQuiz() {
  const quiz = page()?.quiz;
  $('quiz-section').hidden = !quiz;
  const key = `${ui.lesson.version}:${ui.state.pageId}:${pageState().a}:${pageState().power ?? 2}:${quiz?.id}`;
  if (ui.quizKey === key) return;
  ui.quizKey = key;
  $('quiz-feedback').textContent = ''; delete $('quiz-feedback').dataset.correct;
  if (!quiz) return;
  $('quiz-heading').textContent = interpolate(quiz.question);
  const legend = element('legend', 'sr-only', 'Choose an answer');
  $('quiz-options').replaceChildren(legend, ...quiz.options.map((option) => {
    const label = element('label', 'quiz-option'); const input = document.createElement('input'); input.type = 'radio'; input.name = 'quiz-answer'; input.value = option.id;
    label.append(input, element('span', '', interpolate(option.text))); return label;
  }));
}
function renderSources() {
  const signature = JSON.stringify(ui.lesson.sources || []);
  if ($('lesson-sources').dataset.signature === signature) return;
  $('lesson-sources').dataset.signature = signature;
  $('lesson-sources').replaceChildren(...(ui.lesson.sources || []).map((source) => {
    const li = element('li');
    let safe = false; try { safe = ['https:', 'http:'].includes(new URL(source.url).protocol); } catch {}
    if (safe) { const link = element('a', '', source.title); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; li.append(link); }
    else li.textContent = source.title;
    return li;
  }));
}
function messageNode(item) {
  const article = element('article', 'message');
  const header = element('div', 'message-header'); header.append(element('span', 'message-role'), element('span', 'source-tag'));
  const read = element('button', 'text-button', 'Read aloud'); read.type = 'button';
  read.addEventListener('click', () => { if (ui.accepted?.turnId === article.dataset.turnId) void speakReply(ui.accepted); });
  article.append(header, element('h3'), element('p'), element('span', 'message-context'), element('div', 'note-source'), element('p', 'message-review'), element('div', 'message-context'), read);
  updateMessage(article, item); return article;
}
function updateMessage(article, item) {
  const current = item.role === 'assistant' && item.turnId === (ui.committed?.turnId || ui.accepted?.turnId);
  article.classList.toggle('message-current', current);
  article.dataset.role = item.role; article.dataset.turnId = item.turnId || ''; article.dataset.messageId = item.id || '';
  const [header, title, text, context, sources, review, unavailable, read] = article.children;
  setText(header.children[0], item.role === 'user' ? 'YOU' : 'TUTOR');
  const tag = header.children[1]; tag.hidden = item.role !== 'assistant'; tag.className = `source-tag ${item.kind === 'needs_review' ? 'review' : 'ai'}`;
  setText(tag, kindLabels[item.kind] || 'AI-generated');
  setText(title, item.title); title.hidden = !item.title;
  text.className = item.role === 'assistant' ? 'answer-text' : ''; setText(text, item.text);
  const contextPage = ui.lesson.pages.find((p) => p.id === item.pageId);
  context.hidden = item.pageId === ui.state.pageId || !contextPage; setText(context, contextPage ? `On ${contextPage.title}` : '');
  setText(sources, sourceNames(item.sourceIds)); sources.hidden = !item.sourceIds?.length;
  setText(review, item.reviewReason); review.hidden = !item.reviewReason;
  const accepted = item.role === 'assistant' && ui.accepted?.turnId === item.turnId ? ui.accepted : null;
  unavailable.hidden = !accepted?.speechUnavailable;
  setText(unavailable, accepted?.speechUnavailable ? 'Audio was cancelled or unavailable. Ask again to prepare a fresh reply for reading.' : '');
  read.hidden = !accepted || accepted.speechUnavailable || accepted.speechStarted;
  read.disabled = !canSpeak() || !ui.connected;
}
function renderConversation() {
  const feed = $('conversation');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const oldScroll = feed.scrollTop;
  const conversation = ui.state?.conversation || [];
  const items = conversation.map((item) => {
    const unit = item.role === 'assistant' && item.turnId === ui.committed?.turnId ? ui.committed.unit : null;
    return unit ? { ...item, ...unit } : item;
  });
  if (ui.active && !conversation.some((item) => item.role === 'user' && item.turnId === ui.active.turnId)) items.push({ role: 'user', text: ui.active.question, pageId: ui.active.anchor.pageId, turnId: ui.active.turnId, id: `pending:${ui.active.clientTurnId}` });
  if (ui.committed && !conversation.some((item) => item.role === 'assistant' && item.turnId === ui.committed.turnId)) items.push({ role: 'assistant', ...ui.committed.unit, pageId: ui.committed.pageId, turnId: ui.committed.turnId });
  if (!items.length) items.push({ role: 'empty', id: 'empty' });
  reconcileChildren(feed, items, { key: (item) => item.turnId ? `${item.turnId}:${item.role}` : item.id, create(item) {
    if (item.role !== 'empty') return messageNode(item);
    const empty = element('div', 'discussion-empty'); empty.append(element('span', '', '“'), element('p', '', 'A question is a good place to start.'), element('small', '', 'Ask for a different explanation, change the example, or test an idea.')); return empty;
  }, update(node, item) { if (item.role !== 'empty') updateMessage(node, item); } });
  feed.scrollTop = nearBottom ? feed.scrollHeight : oldScroll;
  renderLiveAnswer();
}
function renderLiveAnswer() {
  const reply = ui.committed || ui.accepted;
  const host = $('live-answer');
  const shown = Boolean(reply && reply.pageId === ui.state?.pageId);
  host.hidden = !shown;
  host.dataset.turnId = shown ? reply.turnId : '';
  host.dataset.passageId = shown ? `reply-${reply.turnId}` : '';
  if (!shown) return;
  if (!host.querySelector('.explanation-label')) { const label = element('span', 'explanation-label'); label.hidden = true; host.prepend(label); }
  setText($('live-answer-title'), reply.unit.title || 'A closer look');
  setText($('live-answer-text'), reply.unit.text);
  setText($('live-answer-kind'), kindLabels[reply.unit.kind] || 'AI-generated');
  $('live-answer-kind').className = `source-tag ${reply.unit.kind === 'needs_review' ? 'review' : 'ai'}`;
}

function renderState() {
  if (!ui.state || !page()) return;
  const before = new Map([...$('live-notes').children].map((node) => [node.dataset.passageId, node.getBoundingClientRect()]));
  renderContents();
  setText($('page-eyebrow'), page().eyebrow || 'THE LESSON');
  setText($('lesson-heading'), page().title);
  setText($('page-summary'), interpolate(page().summary || ''));
  $('model-select').value = ui.state.model;
  const selected = [...(page().blocks || []), ...(pageState().notes || [])].find((item) => item.id === ui.state.selectedId);
  $('focus-label').textContent = `${selected ? selected.title || 'Selected note' : page().title} · a = ${number(pageState().a)}`;
  renderTeaching(); renderGraph(); renderBlocks(before); renderQuiz(); renderSources(); renderConversation();
  reconcileChildren($('quick-questions'), page().quickQuestions || [], { key: (question) => question, create(question) {
    const button = element('button'); button.type = 'button';
    button.addEventListener('click', () => { ui.draftAnchor = null; ui.draftStale = false; $('draft-warning').hidden = true; $('question').value = interpolate(question); $('question').focus(); renderControls(); });
    return button;
  }, update(button, question) { setText(button, interpolate(question)); } });
  renderControls();
}
function canSpeak() {
  if (ui.speechEngine === 'native') return ui.config?.nativeSpeech === true;
  const voices = ui.capabilities.localVoices || [];
  return Boolean(ui.capabilities.synthesis && voices.some((voice) => /^en(?:[-_]|$)/i.test(voice.lang))
    && (!ui.preferredVoice || voices.some((voice) => voice.voiceURI === ui.preferredVoice)));
}
function renderVoicePicker() {
  const nativeAvailable = ui.config?.nativeSpeech === true;
  const output = $('speech-output');
  if (ui.speechOptionsKey !== nativeAvailable) {
    ui.speechOptionsKey = nativeAvailable;
    const browser = element('option', '', 'Browser local voice'); browser.value = 'browser';
    output.replaceChildren(browser);
    if (nativeAvailable) { const native = element('option', '', 'macOS local voice'); native.value = 'native'; output.append(native); }
  }
  output.value = ui.speechEngine;
  output.disabled = !ui.config;
  const select = $('local-voice');
  const voices = [...(ui.capabilities.localVoices || [])].sort((a, b) => a.name.localeCompare(b.name));
  const available = voices.some((voice) => voice.voiceURI === ui.preferredVoice);
  const unavailable = Boolean(ui.preferredVoice && !available);
  const signature = JSON.stringify({ voices, missingPreference: unavailable ? ui.preferredVoice : null });
  if (signature !== ui.voiceOptionsKey) {
    ui.voiceOptionsKey = signature;
    const automatic = element('option', '', 'Automatic local voice'); automatic.value = '';
    select.replaceChildren(automatic, ...voices.map((voice) => {
      const option = element('option', '', `${voice.name} · ${voice.lang}`); option.value = voice.voiceURI; return option;
    }));
    if (unavailable) { const missing = element('option', '', 'Saved voice unavailable'); missing.value = ui.preferredVoice; missing.disabled = true; select.append(missing); }
  }
  const selected = ui.preferredVoice;
  select.value = selected;
  select.disabled = ui.speechEngine === 'native' || !ui.voice || !voices.length || typeof ui.voice.setVoice !== 'function';
  if (!unavailable && ui.voice && typeof ui.voice.setVoice === 'function' && selected !== ui.appliedVoice) {
    ui.appliedVoice = selected; // Set before callbacks to avoid re-entering a failed selection.
    if (!ui.voice.setVoice(selected)) ui.appliedVoice = '';
  }
  $('voice-picker-status').textContent = ui.speechEngine === 'native'
    ? 'macOS output uses the local Samantha voice. The server reads only the current prepared step or an acknowledged reply; no paid speech API is used.'
    : !voices.length
    ? 'No local English voice is available yet. Enable an English system voice; typing still works.'
    : ui.preferredVoice && !available
      ? 'Your saved voice is unavailable on this device. Choose Automatic or another local voice before reading.'
      : 'Only voices reported as local and English are listed; playback availability can vary. Your choice is remembered in this browser; reading stays off until you enable it.';
}
function renderControls() {
  if ($('canvas-discussion')) $('canvas-discussion').hidden=!ui.canvas?.active;
  const ready = Boolean(ui.state && ui.connected && !ui.controlBusy && !ui.fileBusy && !ui.showcaseEnding);
  const index = ui.lesson?.pages.findIndex((item) => item.id === ui.state?.pageId) ?? -1;
  for (const id of ['start-lesson', 'continue-lesson', 'mark-step', 'next-step', 'undo', 'model-select', 'parameter', 'export-session', 'import-session', 'export-lesson', 'import-lesson']) $(id).disabled = !ready;
  $('previous-page').disabled = !ready || index <= 0;
  $('next-page').disabled = !ready || index >= (ui.lesson?.pages.length ?? 0) - 1;
  for (const button of $('contents').querySelectorAll('button')) button.disabled = !ready;
  for (const button of $('live-notes').querySelectorAll('.note-actions button')) button.disabled = !ready || button.dataset.flagged === 'true';
  const typedCommand = continuousSpokenCommand($('question').value.trim());
  const localNavigation = typedCommand === 'restart' || typedCommand?.action === 'page';
  $('send').disabled = !ready || (!localNavigation && ui.config?.keyConfigured !== true) || !($('question').value.trim()) || ui.draftStale || ui.previewA !== null;
  $('question').disabled = !ui.lesson || ui.fileBusy;
  $('read-step').disabled = !ready || !canSpeak();
  $('start-guided-audio').disabled = !ready || !canSpeak() || ui.continuousEnabled;
  $('read-replies').disabled = !canSpeak();
  if (!canSpeak()) $('read-replies').checked = false;
  renderVoicePicker();
  renderContinuousControls();
  const listening = ['starting', 'listening', 'stopping'].includes(ui.voiceState);
  $('microphone').disabled = ui.continuousEnabled || !ready || !ui.capabilities.recognition || ui.previewA !== null || ui.voiceState === 'stopping';
  $('microphone').textContent = listening ? 'Finish' : 'Mic';
  $('microphone').setAttribute('aria-label', listening ? 'Finish voice input and review the transcript' : 'Start voice input');
  $('microphone').setAttribute('aria-pressed', String(listening));
  $('draft-warning').hidden = !ui.draftStale;
  $('stop-audio').hidden = !ui.audio && !ui.canvas?.player && !ui.canvas?.browserCancel;
  if (ui.active) $('send').textContent = 'Ask again ↗'; else $('send').textContent = 'Ask ↗';
  renderStatus();
}
function renderStatus() {
  const listening = ['starting', 'listening', 'stopping'].includes(ui.voiceState);
  const active = ui.active;
  $('turn-status').hidden = !active && !listening && !ui.audio;
  if (active) $('turn-status-label').textContent = `${statusLabels[active.status] || 'Working on your question'} · ${duration(performance.now() - active.started)}`;
  else if (listening) $('turn-status-label').textContent = ui.voiceState === 'stopping' ? 'Preparing your transcript' : 'Listening to your question';
  else if (ui.audio) $('turn-status-label').textContent = ui.audio.ended ? 'Reading complete' : ui.audio.started ? 'Reading with a local voice' : 'Preparing local reading';
  $('stop').disabled = !ui.connected || ui.controlBusy;
}
function renderMetrics() {
  const metrics = ui.lastMetrics;
  $('timing-details').hidden = !metrics && !ui.active;
  const values = metrics || ui.active || {};
  const pairs = [['Initial UI response', values.uiResponseMs], ['Reply visible', values.renderedMs], ['Server work elapsed', values.elapsedMs], ['Request → speech start¹', values.audioStartMs]];
  if (values.voice) pairs.push(['Local transcription', values.voice.transcriptionMs], ['VAD end → transcript²', values.voice.endToTranscriptMs], ['VAD end → visible²', values.voice.endToVisibleMs], ['VAD end → playback²', values.voice.endToPlaybackMs], ['Transcript → visible', values.voice.transcriptToVisibleMs], ['Transcript → playback', values.voice.transcriptToPlaybackMs]);
  $('timing-values').replaceChildren(...pairs.flatMap(([label, value]) => [element('dt', '', label), element('dd', '', duration(value))]));
  const timeline = ui.active?.timeline || ui.lastTimeline;
  $('turn-timeline').replaceChildren(...timeline.map((event) => element('li', '', `${event.scope ? `${event.scope} · ` : ''}${event.status || event.event || event.name || 'Update'}${Number.isFinite(event.elapsedMs) ? ` · ${duration(event.elapsedMs)}` : ''}`)), element('li', '', 'Server and browser events use their own start clocks. ¹Manual reading includes your wait before pressing Read aloud. ²VAD estimates when speech ended; playback timing uses the actual playing event.'));
}
function matchesTurn(data) { return ui.active && !ui.active.cancelled && data.clientTurnId === ui.active.clientTurnId && (!ui.active.turnId || data.turnId === ui.active.turnId); }
function onStatus(data) {
  if (!matchesTurn(data)) return;
  const turn = ui.active;
  turn.turnId ||= data.turnId;
  if (data.status === 'generating' && ui.state?.pageId === turn.anchor.pageId) turn.viewEpoch = ui.state.viewEpoch;
  turn.status = data.status;
  turn.timeline.push({ status: data.status, elapsedMs: data.elapsedMs, scope: 'Server' });
  renderStatus(); renderMetrics();
}
async function onCommit(data) {
  if (!matchesTurn(data) || ui.view !== 'study') return;
  const turn = ui.active;
  turn.turnId ||= data.turnId;
  if (data.state?.pageId !== turn.anchor.pageId || data.state?.viewEpoch !== turn.viewEpoch) return;
  turn.status = 'committed';
  ui.committed = { turnId: data.turnId, unit: data.unit, pageId: data.state.pageId };
  applyState(data.state);
  const answer = [...$('conversation').querySelectorAll('.message[data-role="assistant"]')].find((item) => item.dataset.turnId === data.turnId);
  const text = $('live-answer')?.dataset?.turnId === data.turnId ? $('live-answer-text') : answer?.querySelector('.answer-text');
  if (!text || document.hidden) { await failVisibleTurn(turn, 'The reply was not in a visible document.'); return; }
  $('conversation').scrollTop = $('conversation').scrollHeight;
  ui.followAttemptKey = teachingFollowKey({ connectionId: turn.anchor.connectionId, kind: 'reply', id: data.turnId, revision: data.revision });
  if (!visible(text) && !turn.userScrolled && $('follow-teaching').checked) focusTarget(text);
  await settledView();
  if (ui.active !== turn || turn.cancelled || ui.connectionId !== turn.anchor.connectionId) return;
  if (!visible(text) || ui.state.revision !== data.revision || ui.state.viewEpoch !== turn.viewEpoch) {
    await failVisibleTurn(turn, 'The page changed before the reply could be confirmed visible.'); return;
  }
  turn.renderedMs = performance.now() - turn.started;
  turn.timeline.push({ status: 'Graph settled; reply visible', elapsedMs: turn.renderedMs, scope: 'Browser' });
  renderMetrics();
  try {
    const result = await post('/api/ack', { connectionId: ui.connectionId, turnId: data.turnId, revision: data.revision, clientTurnId: turn.clientTurnId, renderedMs: turn.renderedMs });
    if (ui.active !== turn || turn.cancelled || ui.connectionId !== turn.anchor.connectionId) return;
    ui.lastMetrics = { ...(result.metrics || {}), uiResponseMs: turn.uiResponseMs, renderedMs: turn.renderedMs, audioStartMs: null, voice: directVoiceMetrics(turn.directVoice, turn.started + turn.renderedMs) };
    ui.lastTimeline = [
      ...(result.metrics?.timeline || turn.timeline.filter((entry) => entry.scope === 'Server')).map((entry) => ({ ...entry, scope: 'Server' })),
      ...turn.timeline.filter((entry) => entry.scope === 'Browser'),
      { status: 'Delivery acknowledged', elapsedMs: performance.now() - turn.started, scope: 'Browser' },
    ];
    ui.accepted = { turnId: result.turnId || data.turnId, unit: result.unit || data.unit, started: turn.started, connectionId: ui.connectionId, pageId: ui.state.pageId, directVoice: turn.directVoice };
    setTeachingMarker('reply', ui.accepted.turnId, ui.accepted.unit.focusId, result.state);
    ui.active = null; clearInterval(timer);
    applyState(result.state);
    renderConversation(); renderControls(); renderMetrics();
    announce('Your explanation is ready.');
    // Keep the acknowledged reply as this turn's single visual destination.
    followTeachingFocus();
    if (turn.bridgeId) {
      const reply = ui.accepted, captured = anchor();
      await twoFrames(); await motion.settled(); await twoFrames();
      const target = $('live-answer')?.dataset?.turnId === reply.turnId ? $('live-answer') : [...document.querySelectorAll('[data-passage-id]')].find(item => item.dataset.passageId === reply.unit.focusId);
      await reportBridge(turn.bridgeId, reply === ui.accepted && anchorMatches(captured) && visible(target) && ui.view === 'study' ? 'completed' : 'failed', captured);
    } else if (turn.directVoice ? ownsContinuousTurn(turn.directVoice) : $('read-replies').checked) speakReply(ui.accepted);
  } catch (error) {
    if (ui.active !== turn) return;
    ui.active = null; clearInterval(timer);
    ui.lastMetrics = { uiResponseMs: turn.uiResponseMs, renderedMs: turn.renderedMs, audioStartMs: null };
    ui.lastTimeline = [...turn.timeline, { status: 'Delivery was not acknowledged', elapsedMs: performance.now() - turn.started }];
    setError(`${error.message} The reply will not be read aloud.`);
    if (turn.bridgeId) void reportBridge(turn.bridgeId, 'failed');
    renderControls(); renderMetrics();
  }
}
async function failVisibleTurn(turn, message) {
  if (ui.active !== turn) return;
  await control('cancel', {}, { quiet: true });
  setError(`${message} Please ask again when the study page is visible.`);
}
function onFailure(data) {
  if (!matchesTurn(data)) return;
  const turn = ui.active;
  if (turn.bridgeId) void reportBridge(turn.bridgeId, 'failed');
  turn.controller.abort();
  ui.lastMetrics = { ...(data.metrics || {}), uiResponseMs: turn.uiResponseMs, renderedMs: turn.renderedMs ?? null, audioStartMs: null };
  ui.lastTimeline = [...turn.timeline, { status: data.code || 'Request failed', elapsedMs: performance.now() - turn.started }];
  ui.active = null; clearInterval(timer);
  setError(data.message || 'The tutor could not complete this response. Your prepared lesson is still available.');
  renderControls(); renderMetrics(); renderConversation();
}
async function ask(event, remote = null, directVoice = null) {
  event?.preventDefault();
  if (!ui.state || !ui.connected || ui.controlBusy || ui.fileBusy || ui.previewA !== null) return;
  if (ui.showcaseEnding) return;
  const question = remote ? remote.command.question : directVoice ? directVoice.text : $('question').value.trim();
  if (!question) return;
  if (!remote && !directVoice && (ui.draftStale || (ui.draftAnchor && !anchorMatches(ui.draftAnchor)))) {
    ui.draftStale = true; $('draft-warning').hidden = false; renderControls(); return;
  }
  if (!remote && !directVoice) {
    const command = continuousSpokenCommand(question);
    if (command === 'restart' || command?.action === 'page') {
      const pageId = command === 'restart' ? ui.lesson.pages[0].id : command.pageId;
      if (!pageId) { setError('That chapter was not found. Use its page number or exact title.'); return; }
      if (!canSpeak()) { setError('Choose an available local speech output in Help before starting guided teaching.'); return; }
      const result = await beginAutomaticLesson({ pageId, action: 'start', guided: !ui.continuousEnabled });
      if (result && $('question').value.trim() === question) { $('question').value = ''; ui.draftAnchor = null; ui.draftStale = false; $('draft-warning').hidden = true; renderControls(); }
      return;
    }
  }
  if (!remote && ui.finale?.matches(question)) {
    if (directVoice && (!ownsContinuousTurn(directVoice) || !anchorMatches(directVoice.anchor))) return;
    if (!directVoice) { $('question').value=''; ui.draftAnchor=null; ui.draftStale=false; }
    ui.finale.start(); return;
  }
  if (!ui.config?.keyConfigured) { showHelp(true); setError('Add a Cerebras API key to the local server, then reconnect.'); return; }
  const bound = remote?.anchor || directVoice?.anchor || ui.draftAnchor || anchor();
  if (directVoice && (!ownsContinuousTurn(directVoice) || !anchorMatches(bound))) return;
  if (!remote && ui.canvas?.handles(question)) {
    invalidateLocal('Replaced by a canvas question', { preserveDraft: true });
    setError();
    if (!directVoice) { $('question').value = ''; ui.draftAnchor = null; ui.draftStale = false; }
    return ui.canvas.edit(question, { read: Boolean(directVoice || $('read-replies').checked), voiceOwner: directVoice });
  }
  // ask() invalidates the prior core turn; keep this exact voice-start anchor.
  invalidateLocal('Replaced by a new question', { preserveDraft: true });
  setError();
  const turn = { clientTurnId: remote?.clientTurnId || crypto.randomUUID(), bridgeId: remote?.id || null, directVoice, turnId: null, question, anchor: { ...bound }, viewEpoch: null, started: performance.now(), uiResponseMs: null, renderedMs: null, controller: new AbortController(), status: 'submitted', timeline: [], cancelled: false };
  ui.active = turn; ui.accepted = null; ui.committed = null; ui.lastMetrics = null; ui.lastTimeline = [];
  if (!remote && !directVoice) { ui.draftAnchor = null; ui.draftStale = false; $('question').value = ''; $('draft-warning').hidden = true; }
  renderConversation(); renderControls(); renderMetrics();
  requestAnimationFrame(() => { if (ui.active === turn) { turn.uiResponseMs = performance.now() - turn.started; renderMetrics(); } });
  timer = setInterval(renderStatus, 100);
  try {
    const result = await post('/api/ask', { ...bound, question, clientTurnId: turn.clientTurnId, ...(turn.bridgeId ? { bridgeId: turn.bridgeId } : {}) }, turn.controller.signal);
    // SSE can finish delivery before the HTTP 202 body arrives. This handle still
    // proves submission; onCommit/onFailure owns its eventual bridge result.
    if (ui.active !== turn) return turn;
    turn.turnId ||= result.turnId;
    renderConversation();
    return turn;
  } catch (error) {
    if (ui.active !== turn || error.name === 'AbortError') return;
    ui.active = null; clearInterval(timer);
    ui.lastMetrics = { uiResponseMs: turn.uiResponseMs, renderedMs: null };
    ui.lastTimeline = [{ status: error.code || 'Request rejected', elapsedMs: performance.now() - turn.started }];
    if (turn.bridgeId) void reportBridge(turn.bridgeId, 'failed');
    if (!remote && !directVoice && !$('question').value) $('question').value = question;
    if (bound !== null && ['STALE_QUESTION', 'STALE_ANCHOR', 'STALE_REVISION', 'STALE_VIEW', 'STALE_SELECTION'].includes(error.code)) ui.draftStale = true;
    setError(error.message); renderControls(); renderMetrics(); renderConversation();
  }
}
function audioIsCurrent(audio) {
  return ui.audio === audio && !audio.cancelled && audio.connectionId === ui.connectionId
    && audio.revision === ui.state?.revision && audio.viewEpoch === ui.state?.viewEpoch;
}
function localMicrophoneStatus() {
  if (!ui.continuousEnabled) return 'Microphone off.';
  return ui.continuous?.listening ? 'Still listening for your next question.' : 'Continuous microphone is starting.';
}
function browserVoiceStatus(state, message) {
  if (!ui.continuousEnabled) return message;
  // The browser voice controller owns only the manual mic, not continuous capture.
  if (state === 'idle') return `Local reading is idle. ${localMicrophoneStatus()}`;
  if (state === 'transcribed') return `Browser transcript ready. ${localMicrophoneStatus()}`;
  return message;
}
function playNativeSpeech(audio, callbacks) {
  const controller = new AbortController();
  let player = null; let objectUrl = null; let settled = false; let startTimer;
  const cleanup = () => {
    clearTimeout(startTimer);
    controller.abort();
    if (player) {
      player.removeEventListener('playing', playing);
      player.removeEventListener('ended', ended);
      player.removeEventListener('error', failed);
      player.pause(); player.removeAttribute('src'); player.load();
    }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  };
  const fail = (error) => {
    if (settled) return;
    settled = true; cleanup();
    if (ui.audio === audio && !audio.cancelled) callbacks.onError(error);
  };
  const playing = () => {
    if (!audioIsCurrent(audio)) { fail(new Error('The lesson changed before playback started. Request reading again in the current view.')); return; }
    if (audio.started) return;
    clearTimeout(startTimer);
    $('voice-status').textContent = 'Reading with Samantha, a local macOS voice.';
    callbacks.onStart();
  };
  const ended = () => {
    if (settled) return;
    if (!audio.started) { fail(new Error('Audio ended without a playback-start event. The step was not marked read.')); return; }
    settled = true; cleanup();
    if (audioIsCurrent(audio)) { $('voice-status').textContent = `Finished local reading. ${localMicrophoneStatus()}`; void callbacks.onEnd(); }
  };
  const failed = () => fail(new Error('The browser could not play the local audio. You can change Speech output in Help.'));
  $('voice-status').textContent = 'Preparing local macOS speech. Playback has not started.';
  startTimer = setTimeout(() => fail(new Error('Local playback did not begin within 30 seconds. No reading completion was recorded.')), 30000);
  void (async () => {
    try {
      const response = await fetch('/api/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: audio.connectionId, ...audio.identity }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let message = 'Local speech could not be prepared.';
        try { const body = await response.json(); message = body?.error?.message || message; } catch {}
        throw new Error(message);
      }
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('audio/')) throw new Error('The speech service returned an unexpected response.');
      const blob = await response.blob();
      if (settled || audio.cancelled) return;
      if (!audioIsCurrent(audio)) { fail(new Error('This audio belongs to an earlier lesson view. Request reading again.')); return; }
      if (!blob.size) throw new Error('Local speech returned an empty audio file.');
      objectUrl = URL.createObjectURL(blob);
      player = new Audio(objectUrl); player.preload = 'auto';
      player.addEventListener('playing', playing);
      player.addEventListener('ended', ended);
      player.addEventListener('error', failed);
      try { await player.play(); }
      catch (error) {
        if (error.name === 'NotAllowedError') throw new Error('The browser blocked playback. You can choose another Speech output in Help.');
        throw new Error('Local audio did not start. The text remains available.');
      }
    } catch (error) { if (!settled && !audio.cancelled && error.name !== 'AbortError') fail(error); }
  })();
  return () => { if (settled) return; settled = true; cleanup(); };
}
function readText(text, identity, originClock = null, teachingOwner = null) {
  if (!ui.connected || !canSpeak() || (ui.speechEngine === 'browser' && !ui.voice)) { notice('The selected local speech output is unavailable. Choose an output in Help, or keep reading the text.'); return; }
  stopAudio(); ui.voice?.cancel();
  const audio = { identity, teachingOwner, engine: ui.speechEngine, connectionId: ui.connectionId, revision: ui.state.revision, viewEpoch: ui.state.viewEpoch, cancelled: false, started: false, cancel: null, startRequest: null };
  ui.audio = audio;
  const callbacks = {
    onStart: () => {
      if (!audioIsCurrent(audio)) { audio.cancel?.(); return; }
      if (audio.started) return;
      audio.started = true;
      ui.continuous?.setPlayback(true);
      renderTeachingFocus(); followTeachingFocus();
      if (identity.turnId && ui.accepted?.turnId === identity.turnId) { ui.accepted.speechStarted = true; renderConversation(); }
      if (Number.isFinite(originClock) && ui.lastMetrics) {
        const playedAt = performance.now();
        ui.lastMetrics.audioStartMs = playedAt - originClock;
        if (identity.turnId === ui.accepted?.turnId && ui.accepted.directVoice) {
          ui.lastMetrics.voice = { ...ui.lastMetrics.voice, ...directPlaybackMetrics(ui.accepted.directVoice, playedAt) };
        }
        renderMetrics();
      }
      audio.startRequest = post('/api/audio', { connectionId: audio.connectionId, phase: 'start', ...identity });
      void audio.startRequest.then((data) => { if (ui.audio === audio && !audio.cancelled) applyState(data.state); }).catch((error) => { if (ui.audio === audio) { stopAudio(); setError(error.message); } });
      renderControls();
    },
    onEnd: async () => {
      if (ui.audio !== audio || audio.cancelled || !audio.started || audio.ended) return;
      audio.ended = true;
      ui.continuous?.setPlayback(false);
      renderTeachingFocus(); renderStatus();
      try {
        await audio.startRequest;
        if (ui.audio !== audio || audio.cancelled) return;
        const data = await post('/api/audio', { connectionId: audio.connectionId, phase: 'end', ...identity });
        if (ui.audio !== audio || audio.cancelled) return;
        ui.audio = null; if (ui.marker) ui.marker.phase = 'done'; applyState(data.state); renderControls();
        if (audio.identity.stepId) void advanceAutomaticLesson(audio.teachingOwner, audio.identity.stepId, { connectionId: audio.connectionId, revision: audio.revision, viewEpoch: audio.viewEpoch, pageId: data.state.pageId, selectedId: data.state.selectedId });
      } catch (error) { if (ui.audio === audio) { ui.audio = null; if (ui.marker) ui.marker.phase = 'paused'; renderTeachingFocus(); setError(error.message); renderControls(); } }
    },
    onError: (error) => {
      if (ui.audio !== audio) return;
      stopAutomaticTeaching();
      stopAudio();
      const recovery = identity.turnId ? 'Ask again to prepare a fresh reply for reading.' : 'Use Continue lesson, then Read aloud to try this step again.';
      const message = `${error?.message || 'Local reading stopped before completion.'} ${recovery}`;
      $('voice-status').textContent = message; notice(message); renderControls();
    },
  };
  audio.cancel = audio.engine === 'native' ? playNativeSpeech(audio, callbacks) : ui.voice.speak(text, callbacks);
  renderControls(); renderTeachingFocus();
}
async function speakReply(reply) {
  if (!reply || reply !== ui.accepted || reply.connectionId !== ui.connectionId) return;
  const generation = ++speechGeneration;
  const captured = anchor();
  await twoFrames(); await motion.settled(); await twoFrames();
  if (generation !== speechGeneration || (reply.directVoice && !ownsContinuousTurn(reply.directVoice)) || reply !== ui.accepted || !anchorMatches(captured) || document.hidden || ui.view !== 'study' || reply.speechUnavailable || reply.speechStarted) return;
  const narration = spokenText(reply.unit);
  if (!narration) { setError('A final narration is unavailable. This draft will not be read aloud.'); return; }
  readText(narration, { turnId: reply.turnId }, reply.started);
}
async function speakPrepared(step = ui.prepared || currentStep(), directOwner = null) {
  const generation = ++speechGeneration;
  const captured = anchor();
  await twoFrames(); await motion.settled(); await twoFrames();
  const canonical = currentStep();
  if (generation !== speechGeneration || (directOwner && !(directOwner.teaching ? ownsAutomaticTeaching(directOwner) : ownsContinuousTurn(directOwner))) || !step || !anchorMatches(captured) || document.hidden || ui.view !== 'study' || ui.state?.mode !== 'lesson' || canonical?.id !== step.id) return;
  readText(interpolate(canonical.text), { stepId: step.id }, null, directOwner?.teaching ? directOwner : null);
}

function stopAutomaticTeaching() {
  ui.teachingGeneration = (ui.teachingGeneration || 0) + 1;
  ui.autoTeaching = null; ui.guidedAudio = false;
}
function ownsAutomaticTeaching(owner) {
  return Boolean(owner && owner === ui.autoTeaching && owner.serial === ui.teachingGeneration
    && owner.connectionId === ui.connectionId && ui.connected && ui.view === 'study' && !document.hidden
    && (owner.continuous ? ownsContinuousTurn(owner) : ui.guidedAudio && !ui.continuousEnabled));
}
async function beginAutomaticLesson({ action = 'start', pageId = null, owner = null, guided = false } = {}) {
  if (!ui.connected || ui.controlBusy || ui.fileBusy || !canSpeak() || document.hidden || ui.view !== 'study') return null;
  if (guided && ui.continuousEnabled) return null;
  if (owner && !ownsContinuousTurn(owner)) return null;
  if (!ui.continuousEnabled && !guided && !ui.guidedAudio) return null;
  stopAutomaticTeaching();
  ui.guidedAudio = !ui.continuousEnabled;
  const run = { teaching: true, continuous: ui.continuousEnabled, epoch: ui.continuousEpoch, utteranceId: ui.continuousUtteranceId, serial: ui.teachingGeneration, connectionId: ui.connectionId };
  ui.autoTeaching = run;
  return teachPreparedStep(run, action, pageId);
}
async function teachPreparedStep(owner, action, pageId = null) {
  if (!ownsAutomaticTeaching(owner)) return null;
  if (pageId) {
    const changed = await control('page', { pageId }, { quiet: true, autoRead: false, teachingOwner: owner });
    if (!changed || !ownsAutomaticTeaching(owner) || !stateMatchesAnchor(changed.state)) return null;
  }
  const result = await control(action, {}, { quiet: true, autoRead: false, teachingOwner: owner });
  if (!result?.step || !ownsAutomaticTeaching(owner) || !stateMatchesAnchor(result.state)) return null;
  $('continuous-status').textContent = owner.continuous ? 'Teaching the lesson. Speak any time to interrupt.' : 'Teaching without microphone. Use Stop to pause.';
  await speakPrepared(result.step, owner);
  return result;
}
function stateMatchesAnchor(state) {
  return state && anchorMatches({ connectionId: ui.connectionId, revision: state.revision, viewEpoch: state.viewEpoch, pageId: state.pageId, selectedId: state.selectedId });
}
async function advanceAutomaticLesson(owner, stepId, completedAnchor) {
  if (!ownsAutomaticTeaching(owner) || !anchorMatches(completedAnchor) || ui.state.mode !== 'lesson'
      || !ui.state.cursor?.delivered || currentStep()?.id !== stepId) return;
  const current = preparedPage(ui.state.cursor.pageId);
  if (ui.state.cursor.stepIndex + 1 < current.steps.length) { await teachPreparedStep(owner, 'next'); return; }
  const index = ui.lesson.pages.findIndex((item) => item.id === current.id);
  const next = ui.lesson.pages[index + 1];
  if (next) { await teachPreparedStep(owner, 'start', next.id); return; }
  stopAutomaticTeaching();
  $('continuous-status').textContent = ui.continuousEnabled ? 'Lesson complete. Still listening for your questions; say “start from beginning” to revisit it.' : 'Lesson complete. The microphone stayed off.';
  announce('You reached the end of the prepared lesson.'); renderControls();
}

function continuousAvailable() {
  return Boolean(ui.continuous && ui.config?.localTranscription && ui.config?.keyConfigured && ui.connected && canSpeak() && ui.view === 'study');
}
function ownsContinuousTurn(value) {
  return Boolean(value && ui.continuousEnabled && value.epoch === ui.continuousEpoch && value.utteranceId === ui.continuousUtteranceId && ui.connected && ui.view === 'study' && !document.hidden);
}
function renderContinuousControls() {
  const button = $('conversation-toggle');
  button.textContent = ui.continuousEnabled ? 'End learning' : ui.guidedAudio ? 'Stop reading' : 'Start learning';
  button.setAttribute('aria-pressed', String(ui.continuousEnabled || ui.guidedAudio));
  button.disabled = !ui.continuousEnabled && !ui.guidedAudio && (!continuousAvailable() || ui.controlBusy || ui.fileBusy);
  $('continuous-state').textContent = ui.continuousEnabled ? ({ starting: 'Starting microphone', listening: 'Listening', capturing: 'Listening to you', transcribing: 'Transcribing locally' }[ui.continuousState] || 'Listening') : 'Microphone off';
  $('continuous-voice').classList.toggle('is-active', ui.continuousEnabled);
  $('continuous-unavailable').hidden = ui.continuousEnabled || continuousAvailable();
  $('continuous-unavailable').textContent = !ui.config?.localTranscription ? 'Local speech recognition is not ready. See Help; typing and transcript review remain available.' : !ui.config?.keyConfigured ? 'Add a Cerebras key in Help to enable conversation.' : !canSpeak() ? 'Choose an available local speech output in Help.' : !ui.connected ? 'Reconnect before starting a conversation.' : 'Conversation needs microphone support in this browser.';
}
function endContinuousConversation(message = 'Conversation ended. Microphone off.', { cancelTurn = true } = {}) {
  const wasEnabled = ui.continuousEnabled;
  stopAutomaticTeaching();
  ui.continuousEnabled = false; ui.continuousEpoch += 1; ui.continuousCapture = null; ui.continuousUtteranceId = null;
  ui.continuous?.stop();
  if (wasEnabled) {
    stopAudio();
    if (cancelTurn && ui.connected) void control('cancel', {}, { quiet: true });
  }
  $('continuous-status').textContent = message;
  renderControls();
}
async function toggleContinuousConversation() {
  if (ui.continuousEnabled) { endContinuousConversation(); return; }
  if (ui.guidedAudio) {
    stopAutomaticTeaching(); stopAudio(); ui.voice?.cancel();
    await control('cancel', {}, { quiet: true });
    $('continuous-status').textContent = 'Reading paused. The microphone stayed off.'; renderControls(); return;
  }
  if (!continuousAvailable() || ui.controlBusy || ui.fileBusy) return;
  const epoch = ++ui.continuousEpoch;
  ui.continuousEnabled = true; ui.continuousCapture = null; ui.continuousUtteranceId = null;
  stopAutomaticTeaching();
  stopAudio(); ui.voice?.cancel();
  renderControls();
  try {
    const started = await ui.continuous.start();
    if (!ui.continuousEnabled || epoch !== ui.continuousEpoch) return;
    if (started === false) { endContinuousConversation('The microphone did not start. Check permission or use typing.'); return; }
    renderControls();
    if (ui.canvas?.active) { await ui.canvas.edit('Begin teaching this page from the beginning. Explain the first important concept and highlight its section.', { read: true }); return; }
    if (ui.lesson?.pages?.length) await beginAutomaticLesson({ pageId: ui.lesson.pages[0].id, action: 'start' });
  } catch (error) {
    if (epoch !== ui.continuousEpoch) return;
    endContinuousConversation(error.message || 'The microphone could not start. Use typing or transcript review.');
  }
}
function voiceViewSignature(state) {
  return JSON.stringify({ lessonId: state.lessonId, lessonVersion: state.lessonVersion, pageId: state.pageId, selectedId: state.selectedId, model: state.model, page: state.pages?.[state.pageId], cursor: state.cursor, resumePoint: state.resumePoint, mode: state.mode });
}
function beginContinuousUtterance({ utteranceId, speechStartMs }) {
  if (ui.continuousEnabled && ui.continuousCapture?.utteranceId === utteranceId) return ui.continuousCapture.promise;
  if (!ui.continuousEnabled || !continuousAvailable() || ui.controlBusy || ui.fileBusy || ui.previewA !== null || document.hidden || !((typeof utteranceId === 'string' && utteranceId.length > 0) || (Number.isSafeInteger(utteranceId) && utteranceId > 0))) return Promise.resolve(null);
  const onset = Object.freeze({ ...anchor() });
  const signature = voiceViewSignature(ui.state);
  const capture = { utteranceId, epoch: ui.continuousEpoch, onset, anchor: null, speechStartMs, submitted: false, promise: null };
  ui.continuousCapture = capture; ui.continuousUtteranceId = utteranceId;
  // control() interrupts local playback synchronously, then cancels the server turn.
  capture.promise = (async () => {
    const data = await control('cancel', {}, { quiet: true, preserveCapture: true });
    if (!data || ui.continuousCapture !== capture || !ownsContinuousTurn(capture)) return null;
    const state = data.state;
    const bound = Object.freeze({ connectionId: onset.connectionId, revision: state.revision, viewEpoch: state.viewEpoch, pageId: state.pageId, selectedId: state.selectedId });
    if (state.revision !== onset.revision + 1 || state.viewEpoch !== onset.viewEpoch + 1 || voiceViewSignature(state) !== signature || !anchorMatches(bound)) {
      ui.continuousCapture = null;
      $('continuous-status').textContent = 'The page changed as you began speaking. Please repeat the question in the current view.';
      return null;
    }
    capture.anchor = bound;
    return bound;
  })();
  return capture.promise;
}
function receiveContinuousTranscript({ text, anchor: captured, utteranceId, metrics = {} }) {
  const capture = ui.continuousCapture;
  if (!capture || capture.utteranceId !== utteranceId || capture.submitted || !capture.anchor || !ownsContinuousTurn(capture) || !anchorMatches(captured) || ['connectionId', 'revision', 'viewEpoch', 'pageId', 'selectedId'].some((key) => capture.anchor[key] !== captured?.[key])) return;
  capture.submitted = true; // Mark consumed before ask() or any callback can run again.
  const question = typeof text === 'string' ? text.trim() : '';
  if (!question) return;
  if (question.length > 2000) { if (!$('question').value.trim()) $('question').value = question; $('continuous-status').textContent = 'That transcript is too long to send. Shorten it in the question box.'; return; }
  const command = continuousSpokenCommand(question);
  if (command) { void runContinuousSpokenCommand(command, { epoch: capture.epoch, utteranceId }); return; }
  const directVoice = { text: question, anchor: captured, utteranceId, epoch: capture.epoch, metrics: { ...metrics, speechStartMs: metrics.speechStartMs ?? capture.speechStartMs } };
  $('continuous-status').textContent = 'Question sent to Cerebras. You can interrupt by speaking.';
  void ask(null, null, directVoice);
}
function continuousSpokenCommand(text) {
  const phrase = text.trim().toLowerCase().replace(/[.!?]+$/, '').trim();
  if (['continue', 'continue the lesson', 'continue where we left off'].includes(phrase)) return 'continue';
  if (phrase === 'start the lesson') return 'start';
  if (['stop', 'stop speaking'].includes(phrase)) return 'stop';
  if (['stop listening', 'end conversation'].includes(phrase)) return 'end';
  if (['start from beginning', 'start from the beginning', 'restart the lesson'].includes(phrase)) return 'restart';
  const navigation = /^(?:(?:go to|open|start at)\s+)?(?:chapter|page|section)\s+(.+)$/.exec(phrase)
    || /^(?:go to|open)\s+(.+)$/.exec(phrase);
  if (navigation) {
    const target = navigation[1].trim();
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const ordinal = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
    const index = /^\d+$/.test(target) ? Number(target) - 1 : Math.max(words.indexOf(target), ordinal.indexOf(target));
    const pages = ui.lesson?.pages || [];
    const chosen = index >= 0 ? pages[index] : pages.find((item) => [item.id, item.title].some((value) => value.toLowerCase() === target));
    return { action: 'page', pageId: chosen?.id ?? null };
  }
  return null;
}
async function runContinuousSpokenCommand(command, owner) {
  if (!ownsContinuousTurn(owner)) return;
  if (command === 'end') { endContinuousConversation(); return; }
  if (command === 'stop') { $('continuous-status').textContent = 'Speaking stopped. Still listening; say “continue” when ready.'; return; }
  if (ui.canvas?.active && ['continue', 'start'].includes(command)) {
    await ui.canvas.edit(command === 'continue' ? 'Continue teaching the current page from the concept we were discussing.' : 'Begin teaching the current page from the beginning.', { read: true, voiceOwner: owner }); return;
  }
  if (command?.action === 'page' && !command.pageId) { $('continuous-status').textContent = 'That chapter was not found. Say its page number or exact title.'; return; }
  const pageId = command === 'restart' ? ui.lesson.pages[0].id : command?.action === 'page' ? command.pageId : null;
  await beginAutomaticLesson({ action: pageId ? 'start' : command, pageId, owner });
}
function voiceDelta(end, start) { return Number.isFinite(end) && Number.isFinite(start) && end >= start ? end - start : null; }
function directVoiceMetrics(direct, visibleAt) {
  if (!direct) return null;
  const m = direct.metrics || {};
  return { transcriptionMs: Number.isFinite(m.transcriptionMs) ? m.transcriptionMs : null, endToTranscriptMs: voiceDelta(m.transcriptReadyMs, m.speechEndMs), endToVisibleMs: voiceDelta(visibleAt, m.speechEndMs), transcriptToVisibleMs: voiceDelta(visibleAt, m.transcriptReadyMs), endToPlaybackMs: null, transcriptToPlaybackMs: null };
}
function directPlaybackMetrics(direct, playedAt) {
  const m = direct?.metrics || {};
  return { endToPlaybackMs: voiceDelta(playedAt, m.speechEndMs), transcriptToPlaybackMs: voiceDelta(playedAt, m.transcriptReadyMs) };
}
async function transcribeContinuous({ wav, anchor: captured, signal }) {
  const bytes = new Uint8Array(wav); let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return post('/api/transcribe', { anchor: captured, audioBase64: btoa(binary) }, signal);
}
async function setupContinuousVoice() {
  try {
    const { ContinuousVoiceController } = await import('/continuous-voice.js');
    ui.continuous = new ContinuousVoiceController({ onSpeechStart: beginContinuousUtterance, onTranscript: receiveContinuousTranscript, transcribe: transcribeContinuous,
      onState: ({ state, message }) => {
        ui.continuousState = state;
        if (state === 'off' && ui.continuousEnabled) { endContinuousConversation(message || 'Conversation ended.'); return; }
        if (message) $('continuous-status').textContent = message;
        renderControls();
      },
      onError: ({ message }) => { $('continuous-status').textContent = message || 'Local speech recognition failed. You can try speaking again or type a question.'; renderControls(); },
    });
    renderControls();
  } catch { $('continuous-status').textContent = 'Continuous microphone capture is unavailable. Typing and transcript review still work.'; renderControls(); }
}

async function setupVoice() {
  try {
    const { VoiceController } = await import('/voice.js');
    ui.voice = new VoiceController({
      onTranscript: ({ text, anchor: captured }) => {
        if (!anchorMatches(captured)) { $('voice-status').textContent = 'The page changed while you were speaking. Start voice input again in the current view.'; return; }
        const prior = $('question').value.trim();
        $('question').value = (prior ? `${prior} ${text}` : text).slice(0, 2000);
        ui.draftAnchor = captured; ui.draftStale = false;
        $('voice-status').textContent = 'Transcript ready. Review the wording, then press Ask.';
        $('question').focus(); renderControls();
      },
      onState: ({ state, message, capabilities }) => {
        ui.voiceState = state;
        if (capabilities) ui.capabilities = capabilities;
        if (message && ui.audio?.engine !== 'native') $('voice-status').textContent = browserVoiceStatus(state, message);
        renderControls();
      },
      onError: ({ message }) => { $('voice-status').textContent = message || 'Voice is unavailable. Type your question or use operating-system dictation.'; renderControls(); },
      onInterrupt: () => { stopAudio(); },
    });
    ui.capabilities = ui.voice.capabilities();
    if (!ui.capabilities.recognition) $('voice-status').textContent = 'Browser voice input is unavailable. Type your question or use operating-system dictation.';
    renderControls();
  } catch { $('voice-status').textContent = 'Browser voice controls are unavailable. Typing and the lesson still work.'; renderControls(); }
}
async function microphone() {
  if (!ui.voice || !ui.connected || ui.continuousEnabled) return;
  if (['starting', 'listening'].includes(ui.voiceState)) { ui.voice.stop(); return; }
  // The server invalidates any earlier turn before the utterance anchor is captured.
  const result = await control('cancel', {}, { quiet: true });
  if (!result || !ui.connected || ui.previewA !== null) return;
  ui.voice.start(anchor());
}
function download(data, name) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportSession() {
  try { const data = await request(`/api/export?connectionId=${encodeURIComponent(ui.connectionId)}`); download(data, `lesson-lab-session-${new Date().toISOString().slice(0, 10)}.json`); }
  catch (error) { setError(error.message); }
}
async function importFile(file, type) {
  if (!file || ui.fileBusy) return;
  const uploadLimit = type === 'lesson' ? 256000 : 3000000;
  if (file.size > uploadLimit) { setError(type === 'lesson' ? 'Choose a lesson JSON upload below 256 KB; the lesson content itself must fit within 200 KB.' : 'Choose a session JSON upload below 3 MB; the saved state itself must fit within 2 MB.'); return; }
  let payload;
  try { payload = JSON.parse(await file.text()); } catch { setError('This file is not valid JSON. Your current session was not changed.'); return; }
  const body = type === 'lesson' ? { connectionId: ui.connectionId, lesson: payload?.lesson || payload } : { connectionId: ui.connectionId, payload };
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes(body) > uploadLimit || (type === 'lesson' && bytes(body.lesson) > 200000) || (type === 'session' && payload?.state && bytes(payload.state) > 2000000)) {
    setError(type === 'lesson' ? 'The lesson content must fit within 200 KB. Your current lesson was not changed.' : 'The session state must fit within 2 MB and its upload within 3 MB. Your current session was not changed.'); return;
  }
  ui.fileBusy = true; endContinuousConversation('Conversation ended for file import.', { cancelTurn: false }); stopAudio(); ui.voice?.cancel(); setError(); renderControls();
  try {
    const data = await post(type === 'lesson' ? '/api/lesson' : '/api/import', body);
    await adoptSession(data);
    notice(type === 'lesson' ? 'The lesson pack is open. The previous session was archived on the local server.' : 'Your session was restored. Audio will not replay automatically.');
    showHelp(false);
  } catch (error) { setError(`${error.message} The import was not applied.`); }
  finally { ui.fileBusy = false; renderControls(); }
}
function showHelp(open) { $('help-panel').hidden = !open; $('help-toggle').setAttribute('aria-expanded', String(open)); if (open) $('help-heading').scrollIntoView({ block: 'start', behavior: 'instant' }); }
async function switchView(view) {
  if (view === ui.view) return;
  if (view !== 'study') endContinuousConversation('Conversation ended when leaving Study.', { cancelTurn: false });
  if (ui.canvas?.busy || ui.canvas?.player || ui.active || ui.audio || ['starting', 'listening', 'stopping'].includes(ui.voiceState)) await control('cancel', {}, { quiet: true });
  else { stopAudio(); ui.voice?.cancel(); markDraftStale(); }
  ui.view = view;
  $('study-view').hidden = view !== 'study'; $('benchmark-view').hidden = view !== 'benchmark';
  $('study-tab').toggleAttribute('aria-current', view === 'study'); $('benchmark-tab').toggleAttribute('aria-current', view === 'benchmark');
  if (view === 'study') { $('study-tab').setAttribute('aria-current', 'page'); $('benchmark-tab').removeAttribute('aria-current'); }
  else { $('benchmark-tab').setAttribute('aria-current', 'page'); $('study-tab').removeAttribute('aria-current'); await loadBenchmark(); }
  renderControls();
}
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; }
async function loadBenchmark() {
  const container = $('benchmark-content');
  if (!ui.benchmark) {
    container.replaceChildren(element('p', '', 'Loading the frozen evidence…'));
    try { ui.benchmark = await request('/api/benchmark'); }
    catch (error) { container.replaceChildren(element('p', 'benchmark-limit', error.message)); return; }
  }
  const data = ui.benchmark;
  const runs = Array.isArray(data.runs) ? data.runs : data.runs?.runs || [];
  const measured = runs.filter((run) => run.phase === 'measured');
  const rehearsal = runs.filter((run) => run.phase !== 'measured');
  const reviewed = measured.filter((run) => run.review === 'pass').length;
  const summary = element('p', 'benchmark-summary', `${measured.length} measured attempts · ${rehearsal.length} excluded rehearsals / warmups · ${reviewed} recorded review passes. Each timing starts at its own request dispatch. Review was performed by AI, not independent human validation.`);
  const table = element('table', 'benchmark-table');
  const head = element('thead'); const headRow = element('tr');
  for (const label of ['Task', 'Model / route', 'Attempts', 'Visible median', 'Observed range']) headRow.append(element('th', '', label));
  head.append(headRow); const body = element('tbody');
  const labels = { cerebras: 'GPT-OSS · Cerebras API', astra: 'Astra · Codex workflow', 'cerebras-qwen': 'Qwen · Cerebras (supplement)' };
  const groups = new Map();
  for (const run of measured) { const key = `${run.taskId}:${run.lane}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(run); }
  for (const [key, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [taskId, lane] = key.split(':'); const times = rows.map((row) => row.browser?.renderedMs).filter(Number.isFinite);
    const row = element('tr');
    for (const text of [taskId, labels[lane] || lane, `${rows.length}${times.length !== rows.length ? ` (${times.length} visible)` : ''}`, times.length ? `${(median(times) / 1000).toFixed(3)} s` : 'Not measured', times.length ? `${(Math.min(...times) / 1000).toFixed(3)}–${(Math.max(...times) / 1000).toFixed(3)} s` : 'Not measured']) row.append(element('td', '', text));
    body.append(row);
  }
  table.append(head, body); const scroll = element('div', 'benchmark-table-scroll'); scroll.append(table);
  const limits = element('p', 'benchmark-limit', 'The main comparison used different models and provider wrappers. Codex startup and browser rendering are included. Qwen ran afterward as a separate supplement. Facts and exact SVG geometry were supplied in the prompts. Five samples per cell do not support a tail-latency or hardware-speedup claim.');
  const content = element('p', 'benchmark-limit', 'The GPT-OSS finite-step explanation was numerically correct but less complete than the Astra and Qwen explanations. All automatic page checks are distinct from content review. These code-edit results do not establish unrestricted tutoring accuracy or voice-conversation performance.');
  container.replaceChildren(summary, scroll, limits, content);
  $('download-benchmark').disabled = false;
}
async function setupFinale() {
  try {
    const { ShowcaseFinale, matchesFinaleCommand } = await import('/finale.js');
    ui.finale = new ShowcaseFinale({
      onStart: () => { ui.showcaseEnding=true; endContinuousConversation('Showcase complete.', {cancelTurn:false}); invalidateLocal('Showcase complete'); void control('cancel',{}, {quiet:true}); renderControls(); },
      onCancel: () => { ui.showcaseEnding=false; renderControls(); },
    });
    ui.finale.matches=matchesFinaleCommand;
    for (const button of document.querySelectorAll('.showcase-complete')) button.addEventListener('click',()=>ui.finale.start());
  } catch (error) { setError(`The closing screen could not start: ${error.message}`); }
}
async function setupCanvas() {
  try {
    const { LiveCanvas } = await import('/canvas.js');
    ui.canvas = new LiveCanvas({
      anchor, matches: anchorMatches, lessonKey: () => `${ui.lesson?.id}:${ui.lesson?.version}`,
      title: () => page()?.title || 'Lesson Lab', get: request, post,
      beforeEdit: () => invalidateLocal('Canvas selected'), onChange: renderControls, error: setError,
      ask: question => { $('question').value = question; ui.draftAnchor = anchor(); ui.draftStale = false; void ask(); },
      ownsVoice: ownsContinuousTurn, speechEngine: () => ui.speechEngine,
      speakBrowser: (text, callbacks) => ui.voice?.speak(text, callbacks),
      playback: playing => { ui.continuous?.setPlayback(playing); $('stop-audio').hidden = !playing && !ui.audio; },
      onResult: ({ question, document: result, metrics }) => { $('canvas-discussion').replaceChildren(element('small','','You · '+question),element('p','',spokenText(result))); ui.lastMetrics = { renderedMs: metrics.visibleMs, elapsedMs: metrics.totalMs }; renderMetrics(); announce(result.title || 'Page updated'); },
    });
    if (ui.state) ui.canvas.sync();
  } catch (error) { setError(`The HTML canvas could not start: ${error.message}`); }
}
function previousNext(delta) {
  if (!ui.lesson || !ui.state) return;
  const index = ui.lesson.pages.findIndex((item) => item.id === ui.state.pageId);
  const target = ui.lesson.pages[index + delta];
  if (target) void control('page', { pageId: target.id });
}
function installHandlers() {
  $('discussion-toggle').addEventListener('click', () => {
    const focused = document.body.classList.toggle('focus-study');
    $('discussion-toggle').setAttribute('aria-expanded', String(!focused));
    $('discussion-toggle').textContent = focused ? 'Text & tools' : 'Focus on lesson';
    renderTeachingFocus();
  });
  $('start-guided-audio').addEventListener('click', () => { if (ui.lesson?.pages?.length) void beginAutomaticLesson({ pageId: ui.lesson.pages[0].id, action: 'start', guided: true }); });
  $('show-teaching').addEventListener('click', () => followTeachingFocus(true));
  $('follow-teaching').addEventListener('change', () => { if ($('follow-teaching').checked) followTeachingFocus(true); else cancelTeachingFollow(); });
  $('reconnect').addEventListener('click', () => void connect());
  $('question-form').addEventListener('submit', ask);
  $('question').addEventListener('input', () => { if (!$('question').value.trim()) { ui.draftAnchor = null; ui.draftStale = false; } renderControls(); });
  $('stop').addEventListener('click', () => void control('cancel'));
  $('stop-audio').addEventListener('click', () => void control('cancel'));
  $('start-lesson').addEventListener('click', () => void control('start'));
  $('continue-lesson').addEventListener('click', () => void control('continue'));
  $('mark-step').addEventListener('click', () => { const step = currentStep(); if (step) void control('complete_step', { stepId: step.id }); });
  $('next-step').addEventListener('click', () => void control('next'));
  $('read-step').addEventListener('click', async () => {
    const result = await control('continue');
    if (result?.step && !ui.autoTeaching && !$('read-replies').checked) speakPrepared(result.step);
  });
  $('previous-page').addEventListener('click', () => previousNext(-1));
  $('next-page').addEventListener('click', () => previousNext(1));
  $('undo').addEventListener('click', () => void control('undo'));
  $('model-select').addEventListener('change', (event) => void control('model', { model: event.target.value }));
  $('parameter').addEventListener('input', (event) => {
    if (ui.previewA === null) invalidateLocal('Parameter changed');
    ui.previewA = Number(event.target.value); renderGraph(); renderControls();
  });
  $('parameter').addEventListener('change', (event) => void control('parameter', { a: Number(event.target.value) }));
  $('microphone').addEventListener('click', () => void microphone());
  $('conversation-toggle').addEventListener('click', () => void toggleContinuousConversation());
  $('read-replies').addEventListener('change', (event) => { if (!event.target.checked) stopAudio(); else notice('Future acknowledged replies will be read with a local system voice.'); renderControls(); });
  $('speech-output').addEventListener('change', (event) => {
    const selected = event.target.value;
    if (!['browser', 'native'].includes(selected) || (selected === 'native' && ui.config?.nativeSpeech !== true)) return;
    stopAudio();
    ui.speechEngine = selected; ui.preferredSpeechEngine = selected;
    try { localStorage.setItem('lesson-lab.speech-output', selected); } catch { /* An output choice need not be persisted. */ }
    renderControls();
    notice('Speech output selected. No reading starts automatically.');
  });
  $('local-voice').addEventListener('change', (event) => {
    const selected = event.target.value;
    stopAudio();
    if (!ui.voice?.setVoice(selected)) { renderVoicePicker(); return; }
    ui.preferredVoice = selected; ui.appliedVoice = selected;
    try {
      if (selected) localStorage.setItem('lesson-lab.local-voice', selected);
      else localStorage.removeItem('lesson-lab.local-voice');
    } catch { /* Playback still works when browser storage is unavailable. */ }
    renderVoicePicker(); renderControls();
    notice('Voice selected. Start Read aloud when you are ready; no speech starts automatically.');
  });
  $('reanchor-draft').addEventListener('click', () => { ui.draftAnchor = anchor(); ui.draftStale = false; $('draft-warning').hidden = true; renderControls(); $('question').focus(); });
  $('quiz-form').addEventListener('submit', (event) => {
    event.preventDefault(); const quiz = page()?.quiz; const checked = $('quiz-options').querySelector('input:checked');
    if (!quiz) return;
    if (!checked) { $('quiz-feedback').textContent = 'Choose an answer first. You can take your time.'; return; }
    const correct = checked.value === quiz.answerId;
    $('quiz-feedback').dataset.correct = String(correct);
    $('quiz-feedback').textContent = `${correct ? 'That is right.' : 'Not quite. Try tracing both endpoint values.'} ${interpolate(quiz.explanation)}`;
  });
  $('help-toggle').addEventListener('click', () => showHelp($('help-panel').hidden));
  $('help-close').addEventListener('click', () => { showHelp(false); $('help-toggle').focus(); });
  $('setup-help').addEventListener('click', () => showHelp(true));
  $('export-session').addEventListener('click', () => void exportSession());
  $('export-lesson').addEventListener('click', () => { if (ui.lesson) download(ui.lesson, `${ui.lesson.id || 'lesson'}-v${ui.lesson.version}.json`); });
  $('import-session').addEventListener('click', () => $('session-file').click());
  $('import-lesson').addEventListener('click', () => $('lesson-file').click());
  for (const [id, type] of [['session-file', 'session'], ['lesson-file', 'lesson']]) $(id).addEventListener('change', (event) => { void importFile(event.target.files[0], type); event.target.value = ''; });
  $('study-tab').addEventListener('click', () => void switchView('study'));
  $('benchmark-tab').addEventListener('click', () => void switchView('benchmark'));
  $('download-benchmark').addEventListener('click', () => { if (ui.benchmark) download(ui.benchmark, 'lesson-lab-frozen-benchmark.json'); });
  document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const typing = event.target.closest('input,textarea,select,[contenteditable="true"]');
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && event.target === $('question')) { event.preventDefault(); void ask(); return; }
    if (event.key === 'Escape') {
      const activity = ui.canvas?.busy || ui.canvas?.player || ui.active || ui.audio || ['starting', 'listening', 'stopping'].includes(ui.voiceState);
      stopAudio();
      if (activity) { event.preventDefault(); void control('cancel'); }
      else if (!$('help-panel').hidden) showHelp(false);
      return;
    }
    if (!typing && event.altKey && ui.view === 'study' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); previousNext(event.key === 'ArrowLeft' ? -1 : 1); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    const activity = ui.canvas?.busy || ui.canvas?.player || ui.active || ui.audio || ui.continuousEnabled || ['starting', 'listening', 'stopping'].includes(ui.voiceState);
    endContinuousConversation('Conversation ended while this tab was hidden.', { cancelTurn: false });
    stopAudio();
    if (activity) void control('cancel', {}, { quiet: true });
  });
  window.addEventListener('pagehide', () => { endContinuousConversation('Conversation ended.', { cancelTurn: false }); invalidateLocal('Page closed'); ui.events?.close(); });
}
function installMotion() {
  const schedule = () => showPassageHalo(haloTarget, teachingFocus()?.phase);
  window.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('scroll', schedule, { passive: true, capture: true });
  for (const event of ['wheel', 'touchstart']) document.addEventListener(event, cancelTeachingFollow, { passive: true, capture: true });
  document.addEventListener('keydown', (event) => {
    if (!event.isComposing && !event.target.closest('input,textarea,select,[contenteditable="true"]') && ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) cancelTeachingFollow();
  });
  const observer = new ResizeObserver(schedule);
  observer.observe($('lesson-blocks')); observer.observe($('live-notes')); observer.observe($('study-view'));
  motionPreference.addEventListener('change', () => { if (motionPreference.matches) finishViewMotion(); renderMotionStats(); schedule(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) finishViewMotion(); schedule(); });
  renderMotionStats();
}
installHandlers();
installMotion();
renderControls();
void setupVoice();
void setupContinuousVoice();
void setupCanvas();
void setupFinale();
void connect();
