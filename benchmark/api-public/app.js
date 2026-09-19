const $ = (id) => document.getElementById(id);
const state = {
  config: null, checker: null, targets: {}, lanes: new Map(), runs: [],
  active: null, batch: null, pairIndex: 0, inspecting: false,
};

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}
function ms(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value) < 1000 ? `${Math.round(Number(value))} ms` : `${(Number(value) / 1000).toFixed(2)} s`;
}
function scalar(value) { return value === null || value === undefined ? 'Not reported' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
function runId(run) { return run.runId || run.id; }
function laneId(run) { return typeof run.lane === 'object' ? run.lane.id : run.lane || run.laneId; }
function task() { return state.config?.tasks.find((item) => item.id === $('task-select').value); }
function taskName(id) { return state.config?.tasks.find((item) => item.id === id)?.title || id; }
function phaseLabel(phase) { return phase === 'measured' ? 'Measured' : 'Rehearsal'; }
function showError(message = '') { $('error-banner').textContent = message; $('error-banner').hidden = !message; }
function setBatchText(text, error = false) { $('batch-status').textContent = text; $('batch-status').dataset.error = String(error); }
function afterPaint() { return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); }

async function post(path, data, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || result.error || `Request failed (${response.status}).`);
  return result;
}

function locked() { return Boolean(state.batch || state.active || state.inspecting); }
function controls() {
  const busy = locked();
  const ready = Boolean(state.config);
  $('task-select').disabled = !ready || busy;
  $('phase-select').disabled = busy;
  $('repeat-select').disabled = busy;
  $('run-both').disabled = !ready || busy;
  $('stop-run').disabled = !state.batch && !state.active;
  $('refresh-results').disabled = busy;
  for (const lane of state.lanes.values()) {
    lane.runButton.disabled = !ready || busy;
    const result = lane.current;
    lane.passButton.disabled = busy || result?.status !== 'rendered' || !result?.runId || !result?.renderedValid || !result?.reportSaved;
    lane.failButton.disabled = busy || result?.status !== 'rendered' || !result?.runId || !result?.html || !result?.reportSaved;
  }
}

function frameDocument(html, token) {
  const css = String(state.config.styles || '').replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>${css}</style></head><body data-render-token="${token}">${html}</body></html>`;
}

function initialPreview(lane) {
  lane.frame.srcdoc = frameDocument(state.config.starterHtml, crypto.randomUUID());
  lane.frame.title = `Original lesson — ${lane.config.label}`;
}

function createLane(config, index) {
  const card = node('section', 'lane');
  card.dataset.status = 'idle';
  card.setAttribute('aria-label', `${config.label} lesson preview`);
  const header = node('div', 'lane-header');
  const identity = node('div');
  identity.append(node('p', 'eyebrow lane-tag', `ENGINE ${String(index + 1).padStart(2, '0')}`));
  identity.append(node('h2', 'lane-name', config.label));
  identity.append(node('p', 'lane-route', `${config.model} · ${config.reasoning} reasoning`));
  identity.append(node('p', 'lane-route', config.route));
  const runButton = node('button', 'run-one', 'Run this engine ↗');
  runButton.type = 'button';
  header.append(identity, runButton);
  const statusBar = node('div', 'lane-status-bar');
  const status = node('span', 'lane-status', 'Original lesson');
  status.setAttribute('role', 'status');
  const phase = node('span', 'lane-phase', 'Not run');
  statusBar.append(status, phase);
  const preview = node('div', 'preview-wrap');
  const frame = node('iframe', 'preview-frame');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = `Original lesson — ${config.label}`;
  preview.append(frame, node('span', 'preview-caption', 'HTML + SVG · scripts disabled'));
  const clocks = node('div', 'lane-clocks');
  const codeClock = node('span', 'clock-value', '—');
  const visibleClock = node('span', 'clock-value', '—');
  for (const [label, value] of [['Code returned', codeClock], ['Visible update', visibleClock]]) {
    const clock = node('div', 'clock');
    clock.append(node('span', 'clock-label', label), value);
    clocks.append(clock);
  }
  const review = node('div', 'lane-review');
  const reviewLabel = node('span', 'review-label', 'Visual/content review required');
  const reviewActions = node('div', 'review-actions');
  const passButton = node('button', 'review-button pass', 'Visual pass');
  const failButton = node('button', 'review-button fail', 'Reject');
  passButton.type = failButton.type = 'button';
  passButton.disabled = failButton.disabled = true;
  reviewActions.append(passButton, failButton);
  review.append(reviewLabel, reviewActions);
  const disclosure = node('div', 'lane-details');
  const codeDetails = node('details');
  codeDetails.append(node('summary', '', 'Inspect the actual source'));
  const codeTabs = node('div', 'source-tabs');
  codeTabs.setAttribute('role', 'tablist');
  codeTabs.setAttribute('aria-label', `${config.label} source version`);
  const beforeButton = node('button', '', 'Before');
  const afterButton = node('button', '', 'After');
  for (const button of [beforeButton, afterButton]) { button.type = 'button'; button.setAttribute('role', 'tab'); }
  beforeButton.setAttribute('aria-selected', 'true');
  afterButton.setAttribute('aria-selected', 'false');
  codeTabs.append(beforeButton, afterButton);
  const source = node('pre', 'source-code', state.config.starterHtml);
  source.tabIndex = 0;
  codeDetails.append(codeTabs, source);
  const checkDetails = node('details');
  checkDetails.append(node('summary', '', 'Checks, provenance & timing'));
  const summary = node('p', 'lane-summary', 'No generated result yet.');
  const error = node('p', 'lane-error');
  error.hidden = true;
  const checks = node('ul', 'check-list');
  const metadata = node('dl', 'run-metadata');
  checkDetails.append(summary, error, checks, metadata);
  disclosure.append(codeDetails, checkDetails);
  card.append(header, statusBar, preview, clocks, review, disclosure);
  const lane = { config, card, runButton, frame, status, phase, codeClock, visibleClock, reviewLabel, passButton, failButton, source, summary, error, checks, metadata, beforeButton, afterButton, current: null, sourceMode: 'before' };
  beforeButton.addEventListener('click', () => { lane.sourceMode = 'before'; renderSource(lane); });
  afterButton.addEventListener('click', () => { lane.sourceMode = 'after'; renderSource(lane); });
  runButton.addEventListener('click', () => void singleRun(config.id));
  passButton.addEventListener('click', () => void reviewRun(lane, 'pass'));
  failButton.addEventListener('click', () => void reviewRun(lane, 'fail'));
  initialPreview(lane);
  return lane;
}

function renderSource(lane) {
  lane.beforeButton.setAttribute('aria-selected', String(lane.sourceMode === 'before'));
  lane.afterButton.setAttribute('aria-selected', String(lane.sourceMode === 'after'));
  lane.source.textContent = lane.sourceMode === 'after' ? lane.current?.html || 'No returned source for this run.' : state.config.starterHtml;
}

function checkRows(value) { return Array.isArray(value) ? value : Array.isArray(value?.checks) ? value.checks : []; }
function appendMetadata(dl, name, value) { dl.append(node('dt', '', name), node('dd', '', scalar(value))); }

function renderLane(lane) {
  const run = lane.current;
  if (!run) return;
  lane.card.dataset.status = run.status === 'running' ? 'running' : run.renderError || ['error','failed','render_failed','cancelled'].includes(run.status) ? 'failed' : 'finished';
  lane.phase.textContent = `${phaseLabel(run.phase)} · ${run.taskId}`;
  lane.codeClock.textContent = ms(run.codeReceivedMs);
  lane.visibleClock.textContent = ms(run.renderedMs);
  lane.reviewLabel.textContent = run.review === 'pass' ? 'Visually approved' : run.review === 'fail' ? 'Rejected by reviewer' : 'Pending visual/content review';
  lane.reviewLabel.dataset.verdict = run.review || 'pending';
  lane.summary.textContent = run.summary || 'Waiting for a complete source rewrite.';
  lane.error.textContent = run.renderError || (typeof run.error === 'object' ? `${run.error?.code || 'ERROR'}: ${run.error?.message || 'Run failed.'}` : run.error) || '';
  lane.error.hidden = !lane.error.textContent;
  lane.checks.replaceChildren();
  for (const item of [...checkRows(run.checks), ...checkRows(run.domChecks)]) {
    const row = node('li', '', item.name || item.label || 'Validation check');
    row.dataset.pass = String(item.pass === true);
    lane.checks.append(row);
  }
  lane.metadata.replaceChildren();
  for (const [label, value] of [
    ['Task', taskName(run.taskId)], ['Run ID', run.runId], ['Pair ID', run.pairId],
    ['UI response', ms(run.uiResponseMs)], ['Code returned', ms(run.codeReceivedMs)],
    ['Visible update', ms(run.renderedMs)], ['Server time', ms(run.serverMs)],
    ['Source hash', run.sourceHash], ['Prompt hash', run.promptHash],
  ]) appendMetadata(lane.metadata, label, value);
  if (run.metadata && typeof run.metadata === 'object') {
    for (const [key, value] of Object.entries(run.metadata)) appendMetadata(lane.metadata, key, value);
  }
  renderSource(lane);
  controls();
}

function updateTaskPrompt() {
  const selected = task();
  $('shared-prompt').textContent = selected?.fullPrompt || selected?.prompt || '';
  $('task-short-label').textContent = selected ? `${selected.id} / ${selected.title}` : '';
}

function upsertRun(run) {
  const id = runId(run);
  if (!id) return;
  const index = state.runs.findIndex((item) => runId(item) === id);
  if (index >= 0) state.runs[index] = { ...state.runs[index], ...run };
  else state.runs.push(run);
  renderHistory();
}

function normalizeStored(run) {
  const domChecks = run.domChecks || run.browser?.domChecks;
  const renderedMs = run.renderedMs ?? run.browser?.renderedMs ?? null;
  return {
    ...run, runId: runId(run), lane: laneId(run),
    codeReceivedMs: run.codeReceivedMs ?? run.browser?.codeReceivedMs ?? null,
    uiResponseMs: run.uiResponseMs ?? run.browser?.uiResponseMs ?? null,
    renderedMs, domChecks,
    renderedValid: renderedMs !== null && domChecks?.pass === true,
    reportSaved: Boolean(run.browser || run.status === 'rendered' || run.status === 'completed' || run.status === 'render_failed'),
  };
}

async function refreshResults() {
  const response = await fetch('/api/results', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Could not load saved runs.');
  const local = new Map(state.runs.map((run) => [runId(run), run]));
  state.runs = (data.runs || []).map((run) => ({ ...local.get(runId(run)), ...normalizeStored(run) }));
  const pairIds = new Set(state.runs.map((run) => run.pairId).filter((id) => id && !String(id).startsWith('single-')));
  state.pairIndex = Math.max(state.pairIndex, pairIds.size);
  renderHistory();
}

function renderHistory() {
  const body = $('history-body');
  body.replaceChildren();
  const runs = [...state.runs].reverse();
  const measured = runs.filter((run) => run.phase === 'measured').length;
  $('history-note').textContent = runs.length ? `${runs.length} saved run${runs.length === 1 ? '' : 's'} · ${measured} measured · ${runs.filter((run) => run.review === 'pending' || !run.review).length} awaiting review. Saved runs are never rerun on reload.` : 'No recorded runs yet. Start with a rehearsal; nothing runs automatically.';
  if (!runs.length) {
    const row = node('tr'); const cell = node('td', 'empty-table', 'Your first real request will appear here.'); cell.colSpan = 7; row.append(cell); body.append(row); return;
  }
  for (const raw of runs.slice(0, 80)) {
    const run = normalizeStored(raw);
    const row = node('tr');
    const first = node('td', '', String(run.runId || '').slice(0, 13));
    if (run.createdAt || run.startedAt) first.append(node('small', '', new Date(run.createdAt || run.startedAt).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })));
    const engine = node('td', '', state.lanes.get(run.lane)?.config.label || run.lane || 'Unknown engine');
    engine.append(node('small', '', `${run.taskId} · ${taskName(run.taskId)}`));
    const phase = node('td', 'history-run-type', phaseLabel(run.phase));
    const review = node('td', 'history-review', run.review === 'pass' ? 'Visual pass' : run.review === 'fail' ? 'Rejected' : 'Pending');
    review.dataset.verdict = run.review || 'pending';
    if (run.status === 'error' || run.status === 'failed' || run.status === 'cancelled' || run.renderError) review.append(node('small', '', run.status || 'Render failed'));
    const actions = node('td');
    if (run.html && state.lanes.has(run.lane)) {
      const inspect = node('button', 'text-button', 'Inspect ↗');
      inspect.type = 'button'; inspect.disabled = locked();
      inspect.addEventListener('click', () => void inspectRun(run));
      actions.append(inspect);
    }
    row.append(first, engine, phase, node('td', '', ms(run.codeReceivedMs)), node('td', '', ms(run.renderedMs)), review, actions);
    body.append(row);
  }
}

function visibleRect(rect, win, minimumHeight = 1) {
  return rect.width > 0 && rect.height >= 0 && rect.left >= -1 && rect.right <= win.innerWidth + 1 && rect.top >= -1 && rect.bottom <= win.innerHeight + 1 && Math.max(1, rect.height) >= minimumHeight;
}

async function renderResult(lane, run, measuring) {
  const token = crypto.randomUUID();
  lane.frame.title = `${taskName(run.taskId)} — ${lane.config.label}`;
  lane.frame.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  await new Promise((resolve, reject) => {
    let timer;
    const done = (error) => {
      clearTimeout(timer); lane.frame.removeEventListener('load', loaded);
      error ? reject(error) : resolve();
    };
    const loaded = () => {
      if (lane.frame.contentDocument?.body?.dataset.renderToken !== token) return;
      done();
    };
    lane.frame.addEventListener('load', loaded);
    timer = setTimeout(() => done(new Error('The lesson frame did not finish loading.')), 5000);
    lane.frame.srcdoc = frameDocument(run.html, token);
  });
  const doc = lane.frame.contentDocument;
  if (!doc || !doc.defaultView) throw new Error('The rendered lesson document is unavailable.');
  const targetNodes = (state.targets[run.taskId] || []).map((selector) => doc.querySelector(selector));
  const present = targetNodes.filter(Boolean);
  if (present.length) {
    const boxes = present.map((item) => item.getBoundingClientRect());
    const top = Math.min(...boxes.map((box) => box.top)) + doc.defaultView.scrollY;
    doc.defaultView.scrollTo({ top: Math.max(0, top - 18), behavior: 'instant' });
  }
  await afterPaint();
  const checks = state.checker(doc, run.taskId);
  const hostVisible = !document.hidden && (!measuring || !run.hiddenDuringRun) && visibleRect(lane.frame.getBoundingClientRect(), window);
  const domChecks = {
    pass: false,
    checks: [
      { name: 'Recording tab stayed visible', pass: !document.hidden && (!measuring || !run.hiddenDuringRun) },
      { name: 'Entire lesson frame is in the recording viewport', pass: hostVisible },
      { name: 'Lesson root was rendered', pass: Boolean(doc.querySelector('#lesson-root')) },
      ...checks.checks,
      ...targetNodes.map((target, index) => ({ name: `Changed element is visible: ${(state.targets[run.taskId] || [])[index]}`, pass: Boolean(target && visibleRect(target.getBoundingClientRect(), doc.defaultView)) })),
    ],
  };
  if (measuring && (run.cancelled || state.active !== run)) domChecks.checks.push({ name: 'Run remained active through rendering', pass: false });
  domChecks.pass = domChecks.checks.every((check) => check.pass);
  return domChecks;
}

async function handleResult(lane, run, event) {
  run.codeReceivedMs = performance.now() - run.startedClock;
  Object.assign(run, event, { type: undefined, runId: event.runId || run.runId, review: 'pending' });
  run.status = 'awaiting_render';
  lane.sourceMode = 'after';
  lane.status.textContent = 'Code returned · checking the visible lesson';
  renderLane(lane);
  try {
    run.domChecks = await renderResult(lane, run, true);
    if (!run.domChecks.pass) throw new Error('The returned source did not pass all DOM and viewport checks.');
    if (run.cancelled || state.active !== run) throw new Error('This run was cancelled before render confirmation.');
    run.renderedMs = performance.now() - run.startedClock;
    run.renderedValid = true;
    run.status = 'rendered';
    lane.status.textContent = 'Visible update · awaiting your review';
  } catch (error) {
    run.renderedMs = null;
    run.renderedValid = false;
    run.renderError = error.message;
    run.status = run.cancelled ? 'cancelled' : 'render_failed';
    if (!run.domChecks) run.domChecks = { pass: false, checks: [{ name: error.message, pass: false }] };
    lane.status.textContent = run.cancelled ? 'Cancelled' : 'Render check failed';
  }
  if (!run.cancelled) {
    try {
      await post('/api/result', {
        runId: run.runId, renderedMs: run.renderedMs, uiResponseMs: run.uiResponseMs,
        codeReceivedMs: run.codeReceivedMs, domChecks: run.domChecks,
        review: 'pending', ...(run.renderError ? { renderError: run.renderError } : {}),
      });
      run.reportSaved = true;
    } catch (error) {
      run.reportSaved = false;
      run.error = `Run report was not saved: ${error.message}`;
      lane.status.textContent = 'Report not saved';
    }
  }
  upsertRun(run);
  renderLane(lane);
}

async function readRunStream(response, handleEvent) {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || error.error || `Run request failed (${response.status}).`);
  }
  if (!response.body) throw new Error('This browser did not receive a streaming response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line) await handleEvent(JSON.parse(line));
      }
      if (done) break;
    }
    if (buffer.trim()) await handleEvent(JSON.parse(buffer));
  } finally { reader.releaseLock(); }
}

async function runLane(id, taskId, phase, pairId) {
  const lane = state.lanes.get(id);
  const run = {
    lane: id, taskId, phase, pairId, runId: null, status: 'running', review: 'pending',
    createdAt: new Date().toISOString(), startedClock: performance.now(),
    controller: new AbortController(), cancelled: false, hiddenDuringRun: document.hidden,
    uiResponseMs: null, codeReceivedMs: null, renderedMs: null, renderedValid: false, reportSaved: false,
  };
  state.active = run;
  lane.current = run;
  lane.sourceMode = 'before';
  lane.status.textContent = 'Running the shared request…';
  initialPreview(lane);
  lane.frame.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  renderLane(lane);
  controls();
  requestAnimationFrame(() => { if (run.uiResponseMs === null) run.uiResponseMs = performance.now() - run.startedClock; });
  let receivedResult = false;
  try {
    const response = await fetch('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lane: id, taskId, phase, pairId, request: state.config.tasks.find(t => t.id === taskId).apiRequests[id].body }), signal: run.controller.signal,
    });
    await readRunStream(response, async (event) => {
      if (event.runId) run.runId = event.runId;
      if (run.cancelled) return;
      if (event.type === 'started') {
        lane.status.textContent = 'Request accepted · generating source';
        if (event.metadata) run.metadata = event.metadata;
        upsertRun(run);
      } else if (event.type === 'provider') {
        lane.status.textContent = 'Provider is working · waiting for complete code';
      } else if (event.type === 'result') {
        receivedResult = true;
        await handleResult(lane, run, event);
      } else if (event.type === 'error') {
        throw new Error(event.message || event.error || 'The engine did not return a valid lesson.');
      }
    });
    if (!receivedResult && !run.cancelled) throw new Error('The response ended without a valid result.');
  } catch (error) {
    run.status = run.cancelled || error.name === 'AbortError' ? 'cancelled' : 'error';
    run.error = run.status === 'cancelled' ? 'Stopped by the user. No visible result was counted.' : error.message;
    if (!receivedResult) run.renderedMs = null;
    lane.status.textContent = run.status === 'cancelled' ? 'Cancelled' : 'Run failed';
    upsertRun(run);
    renderLane(lane);
  } finally {
    if (state.active === run) state.active = null;
    controls();
  }
  return run;
}

async function singleRun(id) {
  if (locked() || !task()) return;
  showError();
  state.batch = { stopped: false, single: true };
  controls();
  try {
    const repeats=Number($('repeat-select').value);
    for(let i=0;i<repeats&&!state.batch?.stopped;i++) {
      setBatchText(`Run ${i+1}/${repeats}: ${state.lanes.get(id).config.label}.`);
      await runLane(id, task().id, $('phase-select').value, `single-${crypto.randomUUID()}`);
    }
    setBatchText(state.batch?.stopped ? 'Stopped. Completed records were kept.' : 'Run finished. Review the lesson before accepting it.');
  } catch (error) { showError(error.message); }
  finally { state.batch = null; controls(); await refreshResults().catch((error) => showError(error.message)); }
}

async function runBoth() {
  if (locked() || !task()) return;
  showError();
  const selectedTask = task().id;
  const phase = $('phase-select').value;
  const repeats = Number($('repeat-select').value);
  const batch = { stopped: false };
  state.batch = batch;
  controls();
  try {
    for (let index = 0; index < repeats && !batch.stopped; index += 1) {
      const ids = [...state.lanes.keys()];
      if (state.pairIndex % 2) ids.reverse();
      state.pairIndex += 1;
      const pairId = crypto.randomUUID();
      for (let laneIndex = 0; laneIndex < ids.length && !batch.stopped; laneIndex += 1) {
        setBatchText(`Pair ${index + 1}/${repeats} · ${laneIndex + 1}/${ids.length}: ${state.lanes.get(ids[laneIndex]).config.label}`);
        await runLane(ids[laneIndex], selectedTask, phase, pairId);
      }
    }
    setBatchText(batch.stopped ? 'Stopped. Completed records were kept.' : 'Pair complete. Both lessons still need visual/content review.');
  } catch (error) { showError(error.message); setBatchText('The batch stopped with an error.', true); }
  finally { state.batch = null; controls(); await refreshResults().catch((error) => showError(error.message)); }
}

async function stopRun() {
  if (state.batch) state.batch.stopped = true;
  const run = state.active;
  if (!run) return;
  run.cancelled = true;
  run.controller.abort();
  setBatchText('Stopping the active request…');
  if (run.runId) {
    try { await post('/api/cancel', { runId: run.runId }); }
    catch (error) { showError(`Local waiting stopped; server cancellation was not confirmed: ${error.message}`); }
  }
}

async function reviewRun(lane, verdict) {
  if (locked() || !lane.current?.runId) return;
  const run = lane.current;
  if (verdict === 'pass' && (!run.renderedValid || !run.reportSaved)) return;
  lane.passButton.disabled = lane.failButton.disabled = true;
  try {
    await post('/api/review', { runId: run.runId, verdict });
    run.review = verdict;
    upsertRun(run);
    renderLane(lane);
    await refreshResults();
  } catch (error) { showError(error.message); }
  finally { controls(); }
}

async function inspectRun(run) {
  if (locked()) return;
  const lane = state.lanes.get(run.lane);
  if (!lane || !run.html) return;
  state.inspecting = true;
  controls();
  lane.current = { ...run };
  lane.sourceMode = 'after';
  lane.status.textContent = 'Saved result · no new measurement';
  renderLane(lane);
  try {
    const currentChecks = await renderResult(lane, run, false);
    // Reopening a saved result never rewrites its original timing or validates a failed run.
    if (!currentChecks.pass) {
      lane.current.renderedValid = false;
      lane.current.error = 'This saved result is not fully visible in the current viewport. Its original record was not changed.';
    }
  } catch (error) { lane.current.error = error.message; lane.current.renderedValid = false; }
  finally { state.inspecting = false; renderLane(lane); controls(); }
}

async function init() {
  $('recording-layout').addEventListener('click', () => { if(locked()) return; const on=document.body.classList.toggle('recording'); $('recording-layout').setAttribute('aria-pressed',String(on)); });
  $('run-both').addEventListener('click', () => void runBoth());
  $('stop-run').addEventListener('click', () => void stopRun());
  $('task-select').addEventListener('change', updateTaskPrompt);
  $('refresh-results').addEventListener('click', () => void refreshResults().catch((error) => showError(error.message)));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.active) state.active.hiddenDuringRun = true;
  });
  window.addEventListener('pagehide', () => {
    const run = state.active;
    if (!run) return;
    run.cancelled = true;
    run.controller.abort();
    if (run.runId) void fetch('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: run.runId }), keepalive: true }).catch(() => {});
  });
  try {
    const [response, validator] = await Promise.all([fetch('/api/config'+window.location.search, { cache: 'no-store' }), import('/validator.js')]);
    const config = await response.json();
    if (!response.ok) throw new Error(config.message || 'The runner configuration is unavailable.');
    if (!Array.isArray(config.tasks) || config.lanes?.length !== 2 || typeof config.starterHtml !== 'string') throw new Error('The comparison requires two engine configurations and an original lesson.');
    state.config = config;
    state.checker = validator.checkDocument;
    state.targets = validator.targetSelectors || {};
    const selector = $('task-select');
    selector.replaceChildren();
    for (const item of config.tasks) { const option = node('option', '', `${item.id} — ${item.title}`); option.value = item.id; selector.append(option); }
    for (const [index, configLane] of config.lanes.entries()) {
      const lane = createLane(configLane, index); state.lanes.set(configLane.id, lane); $('comparison').append(lane.card);
    }
    updateTaskPrompt();
    await refreshResults();
    $('connection').dataset.ready = 'true';
    $('connection-text').textContent = 'Local runner connected · no automatic requests';
    controls();
  } catch (error) { showError(error.message); $('connection-text').textContent = 'Runner unavailable · refresh after starting it'; }
}

void init();
