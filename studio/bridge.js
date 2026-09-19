import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { computeFacts } from './core.js';

export const BRIDGE_VERSION = '1';
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ANCHOR_KEYS = ['connectionId', 'lessonId', 'lessonVersion', 'pageId', 'revision', 'viewEpoch', 'selectedId'];
const PAYLOAD_KEYS = { start: [], continue: [], next: [], complete_step: ['stepId'], page: ['pageId'],
  select: ['selectedId'], parameter: ['a'], cancel: [], undo: [] };
const terminal = job => ['completed', 'failed'].includes(job.status);

export class BridgeError extends Error {
  constructor(code, message, status = 409) { super(message); this.name = 'BridgeError'; this.code = code; this.status = status; }
}
function check(condition, code, message, status) {
  if (!condition) throw new BridgeError(code, message, status);
}
export function bridgeAnchor(core) {
  return Object.fromEntries(ANCHOR_KEYS.map(key => [key, key === 'connectionId' ? core.connectionId : core.state[key]]));
}

// The native tool reads this file locally. It is never returned to the browser,
// included in exports, or sent through an SSE event.
export function createBridgeAuthorization(dataDir) {
  const file = path.join(dataDir, 'bridge.token');
  try { fs.writeFileSync(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  check(fs.lstatSync(file).isFile(), 'BRIDGE_TOKEN_FILE', 'The local bridge token must be a regular file.', 500);
  fs.chmodSync(file, 0o600);
  const token = fs.readFileSync(file, 'utf8').trim();
  check(/^[a-f0-9]{64}$/.test(token), 'BRIDGE_TOKEN_FILE', 'The local bridge token is invalid.', 500);
  const expected = Buffer.from(`Bearer ${token}`);
  return headers => {
    const provided = Buffer.from(typeof headers.authorization === 'string' ? headers.authorization : '');
    check(provided.length === expected.length && timingSafeEqual(provided, expected),
      'BRIDGE_AUTH_REQUIRED', 'A local bridge authorization token is required.', 401);
  };
}

export class StudioBridge {
  constructor({ getCore, hasPeer, sendCommand, timeoutMs = 35000, maxJobs = 32 }) {
    check(Number.isFinite(timeoutMs) && timeoutMs > 0 && Number.isInteger(maxJobs) && maxJobs >= 1,
      'BRIDGE_CONFIGURATION', 'Bridge limits must be positive.', 500);
    this.getCore = getCore; this.hasPeer = hasPeer; this.sendCommand = sendCommand;
    this.timeoutMs = timeoutMs; this.maxJobs = maxJobs; this.jobs = new Map();
  }
  context() {
    const core = this.getCore();
    return { bridgeVersion: BRIDGE_VERSION, connected: this.hasPeer(core, core.connectionId),
      anchor: bridgeAnchor(core), lesson: { ...copy(core.lesson), sources: core.sourcesFor() }, page: copy(core.material()), state: core.snapshot(),
      selectedBlock: copy(core.block()), facts: computeFacts(core.state.pages[core.state.pageId].a, core.state.pages[core.state.pageId].power),
      preparedStep: core.state.mode === 'lesson' ? core.preparedStep() : null };
  }
  find(id) {
    check(typeof id === 'string' && this.jobs.has(id), 'BRIDGE_UNKNOWN_JOB', 'This bridge command is unavailable.', 404);
    return this.jobs.get(id);
  }
  fail(job, code, message, cancelExecution = false) {
    if (job.status === 'failed') return;
    clearTimeout(job.timer); job.status = 'failed'; job.error = { code, message }; delete job.result;
    // A cancelled native request must never cancel a newer local question.
    const core = this.getCore();
    if (cancelExecution && core === job.owner && core.active?.id === job.execution?.turnId
      && core.active?.clientTurnId === job.clientTurnId) {
      // Invalidation aborts first. A subsequent disk-write failure must not
      // turn a deadline or socket-close callback into an uncaught exception.
      try { core.control({ connectionId: core.connectionId, action: 'cancel' }); } catch {}
    }
  }
  refresh(job) {
    if (job.status === 'failed') return;
    if (!terminal(job) && Date.now() >= job.deadlineMs) {
      this.fail(job, 'BRIDGE_TIMEOUT', 'The study page did not finish this command before its deadline.', true); return;
    }
    const core = this.getCore();
    if (core !== job.owner || core.connectionId !== job.anchor.connectionId || !this.hasPeer(core, core.connectionId)) {
      this.fail(job, 'BRIDGE_DISCONNECTED', 'The study page disconnected or was replaced.', true); return;
    }
    const current = bridgeAnchor(core);
    if (job.status === 'completed') {
      if (!isDeepStrictEqual(current, job.result.anchor)) this.fail(job, 'BRIDGE_STALE_RESULT', 'The study page changed after this command completed.');
    } else if (['queued', 'claimed'].includes(job.status)) {
      if (!isDeepStrictEqual(current, job.anchor)) this.fail(job, 'BRIDGE_STALE_VIEW', 'The page changed before this command could execute.');
    } else if (job.command.kind === 'control') {
      if (!isDeepStrictEqual(current, job.execution?.anchor)) this.fail(job, 'BRIDGE_STALE_VIEW', 'The page changed before its visible result was confirmed.');
    } else {
      const turn = core.active?.id === job.execution?.turnId ? core.active : core.latestCompleted?.id === job.execution?.turnId ? core.latestCompleted : null;
      if (!turn || turn.clientTurnId !== job.clientTurnId || turn.connectionId !== core.connectionId
        || turn.pageId !== current.pageId || turn.viewEpoch !== current.viewEpoch
        || ![turn.baseRevision, turn.committedRevision].includes(current.revision)) {
        const failed = core.records.find(record => record.turnId === job.execution?.turnId && record.status !== 'completed');
        this.fail(job, failed ? 'BRIDGE_EXECUTION_FAILED' : 'BRIDGE_STALE_VIEW', failed
          ? 'The teaching request was cancelled or did not produce an accepted visible answer.'
          : 'The page changed before this answer was confirmed.', true);
      }
    }
  }
  publicJob(job) {
    this.refresh(job);
    return { id: job.id, kind: job.command.kind, status: job.status, anchor: copy(job.anchor),
      createdAt: job.createdAt, deadlineAt: job.deadlineAt,
      ...(job.result ? { result: copy(job.result) } : {}), ...(job.error ? { error: copy(job.error) } : {}) };
  }
  command(input) {
    check(object(input) && ['ask', 'control'].includes(input.kind), 'BRIDGE_INVALID_COMMAND', 'Choose an ask or control command.', 400);
    const core = this.getCore(), observed = bridgeAnchor(core);
    check(this.hasPeer(core, core.connectionId), 'BRIDGE_NO_READER', 'Open the Study page in a browser before using the bridge.');
    // Validate the complete new instruction before refreshing or preempting
    // work. In particular, an old or malformed Stop must not cancel a new turn.
    if (input.expected !== undefined) {
      check(object(input.expected) && Object.keys(input.expected).every(key => ANCHOR_KEYS.includes(key)),
        'BRIDGE_INVALID_EXPECTATION', 'Expected state must contain only bridge anchor fields.', 400);
      check(Object.entries(input.expected).every(([key, value]) => value === observed[key]),
        'BRIDGE_STALE_VIEW', 'The expected page state is no longer current.');
    }
    let command;
    if (input.kind === 'ask') {
      check(typeof input.question === 'string' && input.question.trim() && input.question.length <= 2000,
        'BRIDGE_INVALID_QUESTION', 'Enter a question of up to 2000 characters.', 400);
      command = { kind: 'ask', question: input.question.trim() };
    } else {
      check(Object.hasOwn(PAYLOAD_KEYS, input.action), 'BRIDGE_INVALID_CONTROL', 'This control is not available to native tools.', 400);
      const payload = input.payload ?? {}, keys = PAYLOAD_KEYS[input.action];
      check(object(payload) && Object.keys(payload).length === keys.length && keys.every(key => Object.hasOwn(payload, key)),
        'BRIDGE_INVALID_PAYLOAD', 'This control has an invalid payload.', 400);
      if (input.action === 'parameter') computeFacts(payload.a);
      if (input.action === 'page') check(core.page(payload.pageId), 'BRIDGE_INVALID_PAYLOAD', 'The requested page does not exist.', 400);
      if (input.action === 'select') check(core.block(payload.selectedId), 'BRIDGE_INVALID_PAYLOAD', 'The requested passage does not exist on this page.', 400);
      if (input.action === 'complete_step') check(core.state.mode === 'lesson' && payload.stepId === core.preparedStep().id,
        'BRIDGE_INVALID_PAYLOAD', 'This completion belongs to another prepared step.', 400);
      command = { kind: 'control', action: input.action, payload: copy(payload) };
    }
    for (const job of this.jobs.values()) this.refresh(job);
    const pending = [...this.jobs.values()].filter(job => !terminal(job));
    const stop = command.kind === 'control' && command.action === 'cancel';
    check(stop || pending.length === 0, 'BRIDGE_BUSY', 'Another remote command is still in progress.');
    check(!core.active || stop, 'BRIDGE_BUSY', 'A teaching request is already in progress.');
    if (stop) for (const job of pending) {
      this.fail(job, 'BRIDGE_CANCELLED', 'The native Stop command cancelled this command.', true);
    }
    // Cancelling the bridge-owned turn increments the core revision and view
    // epoch. Bind the queued browser Stop to that resulting view, not the old one.
    const anchor = bridgeAnchor(core);
    while (this.jobs.size >= this.maxJobs) {
      const oldest = [...this.jobs.values()].find(terminal); if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
    const id = randomUUID(), now = Date.now();
    const job = { id, clientTurnId: `bridge-${id}`, command, anchor, owner: core, status: 'queued',
      createdAt: new Date(now).toISOString(), deadlineMs: now + this.timeoutMs, deadlineAt: new Date(now + this.timeoutMs).toISOString() };
    this.jobs.set(id, job);
    job.timer = setTimeout(() => this.fail(job, 'BRIDGE_TIMEOUT', 'The study page did not finish this command before its deadline.', true), this.timeoutMs);
    job.timer.unref?.();
    try { this.sendCommand(core, anchor.connectionId, { id }); }
    catch { this.fail(job, 'BRIDGE_DISCONNECTED', 'The study page disconnected before the command was sent.'); }
    return this.publicJob(job);
  }
  claim(input) {
    const core = this.getCore(); core.authorize(input?.connectionId);
    const job = this.find(input.id); this.refresh(job);
    check(job.status === 'queued', 'BRIDGE_NOT_CLAIMABLE', 'This bridge command has expired or was already claimed.');
    job.status = 'claimed';
    return { id: job.id, command: copy(job.command), anchor: copy(job.anchor), clientTurnId: job.clientTurnId };
  }
  // Called by the ordinary browser endpoints. Correlation proves that the
  // authorized action actually ran; a browser cannot manufacture a receipt.
  execute(kind, input, invoke) {
    if (!input?.bridgeId) {
      const result = invoke();
      for (const job of this.jobs.values()) this.refresh(job);
      return result;
    }
    const core = this.getCore(); core.authorize(input.connectionId);
    const job = this.find(input.bridgeId); this.refresh(job);
    check(job.status === 'claimed' && job.command.kind === kind,
      'BRIDGE_EXECUTION_MISMATCH', 'This command is not authorized to execute.');
    const valid = kind === 'ask'
      ? input.clientTurnId === job.clientTurnId && input.question?.trim() === job.command.question
      : input.action === job.command.action && PAYLOAD_KEYS[job.command.action].every(key => isDeepStrictEqual(input[key], job.command.payload[key]));
    check(valid, 'BRIDGE_EXECUTION_MISMATCH', 'The browser action does not match the authorized command.');
    try {
      const result = invoke();
      job.status = 'running';
      job.execution = kind === 'ask' ? { turnId: result.turnId } : { anchor: bridgeAnchor(core), step: copy(result.step ?? null) };
      return result;
    } catch (error) {
      this.fail(job, 'BRIDGE_EXECUTION_FAILED', 'The study page could not apply this command.', true); throw error;
    }
  }
  result(input) {
    const core = this.getCore(); core.authorize(input?.connectionId);
    const job = this.find(input.id); this.refresh(job);
    check(!terminal(job), 'BRIDGE_RESULT_EXPIRED', 'This bridge command no longer accepts a result.');
    check(['completed', 'failed'].includes(input.status), 'BRIDGE_INVALID_RESULT', 'The command result status is invalid.', 400);
    if (input.status === 'failed') {
      // Browser error text is untrusted. Do not reflect it into native speech.
      this.fail(job, 'BRIDGE_BROWSER_FAILED', 'The browser could not finish or confirm this command.', true);
      return this.publicJob(job);
    }
    check(job.status === 'running' && input.visible === true && input.revision === core.state.revision
      && input.viewEpoch === core.state.viewEpoch,
    'BRIDGE_UNCONFIRMED_VIEW', 'The final visible page has not been confirmed.');
    let result;
    if (job.command.kind === 'ask') {
      const turn = core.latestCompleted;
      const record = core.records.find(item => item.turnId === job.execution.turnId && item.clientTurnId === job.clientTurnId && item.status === 'completed');
      check(turn?.id === job.execution.turnId && turn.clientTurnId === job.clientTurnId
        && turn.committedRevision === core.state.revision && turn.viewEpoch === core.state.viewEpoch
        && record?.metrics.timeline.some(event => event.event === 'display_ack'),
      'BRIDGE_ACK_REQUIRED', 'The core has not acknowledged this displayed answer.');
      result = { kind: 'ask', anchor: bridgeAnchor(core), turnId: turn.id,
        unit: copy(turn.unit), metrics: copy(record.metrics), focusIds: [turn.unit.focusId] };
    } else {
      check(isDeepStrictEqual(bridgeAnchor(core), job.execution.anchor), 'BRIDGE_STALE_VIEW', 'The control result is no longer current.');
      const step = job.execution.step;
      if (step) check(core.audioAnchor?.type === 'step' && core.audioAnchor.id === step.id
        && core.audioAnchor.phase === 'ready' && core.preparedStep().id === step.id,
      'BRIDGE_STEP_NOT_READY', 'The prepared explanation is no longer ready.');
      result = { kind: 'control', action: job.command.action, anchor: bridgeAnchor(core),
        ...(step ? { step: copy(step) } : {}), focusIds: [step?.targetId ?? core.state.selectedId] };
    }
    clearTimeout(job.timer); job.result = result; job.status = 'completed';
    return this.publicJob(job);
  }
  poll(id) { return this.publicJob(this.find(id)); }
  cancel(id) {
    const job = this.find(id); this.refresh(job);
    if (job.status !== 'failed') this.fail(job, 'BRIDGE_CANCELLED', 'The native tool cancelled this command.', true);
    return this.publicJob(job);
  }
  disconnected() { for (const job of this.jobs.values()) this.refresh(job); }
  close() { for (const job of this.jobs.values()) if (!terminal(job)) this.fail(job, 'BRIDGE_CLOSED', 'The study server is closing.', true); }
}
