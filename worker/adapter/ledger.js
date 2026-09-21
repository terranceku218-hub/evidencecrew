'use strict';
/**
 * ledger.js - Worker conversation ledger and rotation policy.
 *
 * A "Worker" is one ChatGPT conversation dedicated to this project. The ledger is
 * RUNNING STATE, not project knowledge: it records which conversation to keep using, how
 * many rounds it has served, and whether it has been retired. Project knowledge stays in
 * PROJECT_STATE.md / TASKS.md / DECISIONS.md.
 *
 * SOURCE OF TRUTH
 *   state/workers.json        machine-readable, authoritative.
 *   state/CHATGPT_WORKERS.md  regenerated from the JSON on every change.
 * The Markdown is a VIEW, never hand-edited - that guarantees the two can never
 * disagree, which is the usual failure mode of a hand-maintained ledger table.
 *
 * ATOMICITY
 *   Writes go to a temp file and are renamed over the target, so an interrupted rotation
 *   can never leave a half-written ledger that the next session misreads.
 *
 * ASCII-ONLY: see the encoding note in lib.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG } = require('./lib.js');

const STATE_FILE = path.join(CONFIG.paths.stateDir, 'workers.json');
const LEDGER_FILE = CONFIG.paths.workerLedger;

const STATUS = { ACTIVE: 'ACTIVE', ARCHIVED: 'ARCHIVED' };

function ensureDirs() {
  fs.mkdirSync(CONFIG.paths.stateDir, { recursive: true });
  fs.mkdirSync(CONFIG.paths.logsDir, { recursive: true });
}

function load() {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    return { version: 1, seq: 0, activeWorkerId: null, workers: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!Array.isArray(data.workers)) throw new Error('workers is not an array');
    return data;
  } catch (e) {
    // A corrupt ledger must surface, not be silently replaced - starting fresh would
    // orphan a live conversation the supervisor believes it owns.
    throw new Error(`ledger is unreadable (${STATE_FILE}): ${e.message}. ` +
                    `Repair or move the file aside deliberately; refusing to overwrite it.`);
  }
}

function save(data) {
  ensureDirs();
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STATE_FILE);
  fs.writeFileSync(LEDGER_FILE, renderMarkdown(data), 'utf8');
  return data;
}

function renderMarkdown(data) {
  const lines = [];
  lines.push('# ChatGPT Workers');
  lines.push('');
  lines.push('> RUNNING STATE - not project knowledge. Regenerated from `workers.json`;');
  lines.push('> do not hand-edit this table, edits will be overwritten.');
  lines.push('');
  lines.push(`- Active worker: \`${data.activeWorkerId ?? '(none)'}\``);
  lines.push(`- Rotation threshold: \`MAX_WORKER_ROUNDS = ${CONFIG.limits.maxWorkerRounds}\``);
  lines.push(`- Updated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('| Worker ID | Status | Turns | Task | Last success | Archived | URL |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const w of data.workers) {
    const url = w.url ? `[link](${w.url})` : '(unassigned)';
    lines.push(`| ${w.id} | ${w.status} | ${w.turns} | ${escapeCell(w.task)} | ` +
               `${w.lastSuccessAt ?? '-'} | ${w.archivedAt ?? '-'} | ${url} |`);
  }
  if (!data.workers.length) lines.push('| _(none yet)_ | | | | | | |');
  lines.push('');
  lines.push('## Full records');
  lines.push('');
  for (const w of data.workers) {
    lines.push(`### ${w.id}`);
    lines.push('');
    lines.push(`- status: ${w.status}`);
    lines.push(`- url: ${w.url ?? '(unassigned - assigned on first assistant turn)'}`);
    lines.push(`- created: ${w.createdAt}`);
    lines.push(`- task: ${w.task || '(none)'}`);
    lines.push(`- turns: ${w.turns}`);
    lines.push(`- lastSuccessAt: ${w.lastSuccessAt ?? '-'}`);
    lines.push(`- archivedAt: ${w.archivedAt ?? '-'}`);
    if (w.rotationReason) lines.push(`- rotationReason: ${w.rotationReason}`);
    if (w.handoffFrom) lines.push(`- handoffFrom: ${w.handoffFrom}`);
    lines.push('');
    if (Array.isArray(w.history) && w.history.length) {
      lines.push('| # | at | event | detail |');
      lines.push('| --- | --- | --- | --- |');
      for (const h of w.history) {
        lines.push(`| ${h.n} | ${h.at} | ${h.event} | ${escapeCell(h.detail)} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function escapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
}

function record(data, worker, event, detail) {
  worker.history = worker.history ?? [];
  worker.history.push({
    n: worker.history.length + 1,
    at: new Date().toISOString(),
    event,
    detail: String(detail ?? ''),
  });
  return worker;
}

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

function createWorker(task) {
  const data = load();
  data.seq = (data.seq ?? 0) + 1;
  const id = `GPT-WORKER-${String(data.seq).padStart(3, '0')}`;
  const worker = {
    id, status: STATUS.ACTIVE, url: null,
    createdAt: new Date().toISOString(), task: task ?? '',
    turns: 0, lastSuccessAt: null, archivedAt: null, history: [],
  };
  record(data, worker, 'created', task ?? '');
  data.workers.push(worker);
  data.activeWorkerId = id;
  save(data);
  return { ok: true, worker };
}

function attachUrl(id, url) {
  const data = load();
  const w = find(data, id);
  if (!w) return { ok: false, error: `no such worker: ${id}` };
  if (w.url && w.url !== url) record(data, w, 'url.replaced', `${w.url} -> ${url}`);
  w.url = url;
  save(data);
  return { ok: true, worker: w };
}

/** Count one completed round against the worker. */
function bumpRound(id, opts = {}) {
  const data = load();
  const w = find(data, id);
  if (!w) return { ok: false, error: `no such worker: ${id}` };
  w.turns += 1;
  if (opts.url) w.url = opts.url;
  if (opts.task) w.task = opts.task;
  record(data, w, 'round', `turn ${w.turns}${opts.detail ? ` - ${opts.detail}` : ''}`);
  save(data);
  return { ok: true, worker: w, rotation: rotationCheck(w) };
}

function markSuccess(id) {
  const data = load();
  const w = find(data, id);
  if (!w) return { ok: false, error: `no such worker: ${id}` };
  w.lastSuccessAt = new Date().toISOString();
  record(data, w, 'success', 'review PASS');
  save(data);
  return { ok: true, worker: w };
}

/**
 * Reconcile the recorded turn count against what the conversation actually contains.
 *
 * WHY: `turns` is the counter the rotation policy reads, but it only advances when THIS
 * adapter sends. Anything typed by hand, or any round that happened before a browser
 * restart, is invisible to it - so the ledger can under-report and delay rotation past
 * the context growth the threshold exists to bound. This lets the supervisor correct the
 * count from observed reality.
 *
 * The correction is recorded as its own event so the audit trail shows that the number
 * came from observation rather than from a send.
 */
function setTurns(id, observed, note) {
  const data = load();
  const w = find(data, id);
  if (!w) return { ok: false, error: `no such worker: ${id}` };
  const n = Number(observed);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: `observed turn count must be >= 0, got ${observed}` };
  const previous = w.turns;
  w.turns = Math.floor(n);
  record(data, w, 'turns.reconciled', `recorded ${previous} -> observed ${w.turns}${note ? ` (${note})` : ''}`);
  save(data);
  return { ok: true, worker: w, previous, rotation: rotationCheck(w) };
}

function archiveWorker(id, reason) {
  const data = load();
  const w = find(data, id);
  if (!w) return { ok: false, error: `no such worker: ${id}` };
  w.status = STATUS.ARCHIVED;
  w.archivedAt = new Date().toISOString();
  w.rotationReason = reason ?? 'manual';
  record(data, w, 'archived', w.rotationReason);
  if (data.activeWorkerId === id) data.activeWorkerId = null;
  save(data);
  return { ok: true, worker: w };
}

/**
 * Rotation policy. Reaching the threshold is a SIGNAL, not an order: the caller decides.
 * Slow/truncated responses and context warnings are equally valid triggers.
 *
 * @returns {{shouldRotate:boolean, reasons:string[], turns:number, threshold:number}}
 */
function rotationCheck(worker) {
  const reasons = [];
  const threshold = CONFIG.limits.maxWorkerRounds;
  if (worker.turns >= threshold) {
    reasons.push(`turns ${worker.turns} >= MAX_WORKER_ROUNDS ${threshold}`);
  }
  return { shouldRotate: reasons.length > 0, reasons, turns: worker.turns, threshold };
}

/**
 * Rotate: archive the old worker and open a new one that starts from a handoff packet.
 * The handoff is built by the supervisor from the project state files - never by
 * replaying the old transcript, which would reproduce the very context growth rotation
 * exists to avoid.
 */
function rotate(oldId, task, reason) {
  const old = archiveWorker(oldId, reason ?? 'rotation');
  if (!old.ok) return old;
  const fresh = createWorker(task);
  const data = load();
  const w = find(data, fresh.worker.id);
  w.handoffFrom = oldId;
  record(data, w, 'handoff', `from ${oldId}`);
  save(data);
  return { ok: true, archived: old.worker, created: w };
}

function activeWorker() {
  const data = load();
  if (!data.activeWorkerId) return { ok: true, worker: null };
  return { ok: true, worker: find(data, data.activeWorkerId) ?? null };
}

function listWorkers() {
  const data = load();
  return { ok: true, activeWorkerId: data.activeWorkerId, count: data.workers.length, workers: data.workers };
}

function find(data, id) { return data.workers.find((w) => w.id === id); }

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

function dispatch(sub, args) {
  switch (sub) {
    case 'list': return listWorkers();
    case 'active': return activeWorker();
    case 'new': return createWorker(args.join(' '));
    case 'url': return attachUrl(args[0], args[1]);
    case 'round': return bumpRound(args[0], { url: args[1], detail: args.slice(2).join(' ') });
    case 'success': return markSuccess(args[0]);
    case 'turns': return setTurns(args[0], args[1], args.slice(2).join(' '));
    case 'archive': return archiveWorker(args[0], args.slice(1).join(' ') || 'manual');
    case 'rotate': return rotate(args[0], args.slice(1).join(' '), 'rotation');
    case 'check': {
      const a = activeWorker();
      if (!a.ok || !a.worker) return { ok: false, error: 'no active worker' };
      return { ok: true, workerId: a.worker.id, rotation: rotationCheck(a.worker) };
    }
    default:
      return {
        ok: false,
        error: `unknown ledger subcommand: ${sub ?? '(none)'}; ` +
               `try list | active | new | url | round | success | archive | rotate | check`,
      };
  }
}

module.exports = {
  STATUS, load, save, renderMarkdown,
  createWorker, attachUrl, bumpRound, markSuccess, setTurns, archiveWorker,
  rotationCheck, rotate, activeWorker, listWorkers, dispatch,
  STATE_FILE, LEDGER_FILE,
};
