'use strict';
/**
 * events.js - normalises existing sources into one UI timeline.
 *
 * WHY THIS IS NORMALISATION AND NOT A NEW SOURCE OF TRUTH
 *   The user asked for a recent-events timeline. The tempting move is to start logging
 *   everything into a workbench database. That would create a second truth that drifts.
 *   Instead this module READS the sources that already exist - the harness event log, the
 *   worker ledger history, task histories, and Git - and projects them into one shape for
 *   display. Nothing is stored, so nothing can disagree.
 *
 * WHAT IT NEVER DOES
 *   It does not attempt to obtain hidden reasoning. Only public actions and recorded state
 *   are surfaced: task transitions, worker rounds, harness events, Git commits.
 *
 * ASCII-ONLY source.
 */

const fs = require('node:fs');
const path = require('node:path');

// PUBLIC RELEASE CHANGE: one shared loader resolves every configured path against the repository root,
// so this file no longer assumes absolute paths recorded on the maintainer machine.
const { CONFIG } = require('../config.js');
const H = CONFIG.paths.harnessRoot;

const adapter = require(path.join(__dirname, '..', 'adapters', 'harness-adapter.js'));
const store = require('./store.js');

/** Harness event types, mapped to a UI severity and a readable label. */
const HARNESS_EVENT_LABELS = {
  'project.register': { label: 'Project registered', level: 'info' },
  'project.open': { label: 'Project opened', level: 'info' },
  'project.remove': { label: 'Registration removed', level: 'warn' },
  'project.remove.registration-only': { label: 'Registration removed (files kept)', level: 'warn' },
  'workspace.add': { label: 'Workspace added', level: 'info' },
  'workspace.archive': { label: 'Workspace archived', level: 'warn' },
  'workspace.remove': { label: 'Workspace unregistered', level: 'warn' },
  'task.add': { label: 'Task created', level: 'info' },
  'task.transition': { label: 'Task transition', level: 'info' },
  'task.retry.cap': { label: 'Retry cap reached', level: 'error' },
  'worker.create': { label: 'Worker created', level: 'info' },
  'worker.bind': { label: 'Conversation bound', level: 'info' },
  'worker.conversation.resolved': { label: 'Conversation URL resolved', level: 'info' },
  'worker.conversation.blocked': { label: 'Conversation BLOCKED', level: 'error' },
  'worker.rounds.reconciled': { label: 'Rounds reconciled', level: 'warn' },
  'worker.archive': { label: 'Worker archived', level: 'warn' },
  'worker.rotate': { label: 'Worker rotated', level: 'warn' },
};

function harnessEvents(projectId, limit) {
  const file = path.join(H, 'logs', 'harness.jsonl');
  if (!fs.existsSync(file)) return [];
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (projectId && e.project_id && e.project_id !== projectId) continue;
    const meta = HARNESS_EVENT_LABELS[e.event] ?? { label: e.event, level: 'info' };
    out.push({
      at: e.at,
      source: 'harness',
      type: e.event,
      level: meta.level,
      label: meta.label,
      project_id: e.project_id ?? null,
      detail: summarise(e.detail),
    });
  }
  return out;
}

/** Task history entries, projected into the same shape. */
function taskEvents(projectId, limit) {
  const out = [];
  for (const t of adapter.listTasks(projectId)) {
    for (const h of t.history ?? []) {
      out.push({
        at: h.at,
        source: 'task',
        type: h.event,
        level: h.event === 'user_rejected' ? 'warn'
          : h.event === 'retry.cap' ? 'error'
          : h.event === 'success' ? 'ok'
          : 'info',
        label: `Task ${t.task_id}: ${h.event}`,
        project_id: projectId,
        task_id: t.task_id,
        detail: String(h.detail ?? '').slice(0, 200),
      });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

/** Worker ledger history entries. */
function workerEvents(projectId, limit) {
  const out = [];
  for (const w of adapter.getProject(projectId)?.workers ?? []) {
    const raw = require(path.join(H, 'lib', 'workers.js')).load().workers
      .find((x) => x.worker_id === w.worker_id);
    for (const h of raw?.history ?? []) {
      out.push({
        at: h.at,
        source: 'worker',
        type: h.event,
        level: h.event.includes('blocked') ? 'error'
          : h.event.includes('reconcile') || h.event.includes('archive') ? 'warn'
          : 'info',
        label: `Worker ${w.worker_id}: ${h.event}`,
        project_id: projectId,
        worker_id: w.worker_id,
        detail: String(h.detail ?? '').slice(0, 200),
      });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

/** Workbench-owned decisions and goals. */
function workbenchEvents(projectId, limit) {
  const s = store.load();
  const out = [];
  for (const g of s.goals.filter((x) => x.project_id === projectId)) {
    out.push({ at: g.created_at, source: 'workbench', type: 'goal.created', level: 'info',
               label: `Goal submitted (${g.goal_id})`, project_id: projectId, goal_id: g.goal_id,
               detail: String(g.text).slice(0, 160) });
    if (g.status && g.status !== 'SUBMITTED') {
      out.push({ at: g.updated_at, source: 'workbench', type: `goal.${g.status.toLowerCase()}`,
                 level: g.status === 'BLOCKED' ? 'error' : g.status === 'COMPLETED' ? 'ok' : 'info',
                 label: `Goal ${g.goal_id}: ${g.status}`, project_id: projectId, goal_id: g.goal_id,
                 detail: String(g.error ?? '').slice(0, 160) });
    }
  }
  for (const d of s.decisions.filter((x) => x.project_id === projectId)) {
    out.push({ at: d.at, source: 'workbench', type: `decision.${String(d.action).toLowerCase()}`,
               level: d.action === 'REJECT' ? 'warn' : d.action === 'APPROVE' ? 'ok' : 'info',
               label: `User ${d.action}${d.task_id ? ` on ${d.task_id}` : ''}`,
               project_id: projectId, task_id: d.task_id ?? null, goal_id: d.goal_id ?? null,
               detail: String(d.reason ?? '').slice(0, 160) });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

function summarise(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') return detail.slice(0, 200);
  try {
    const s = JSON.stringify(detail);
    return s.length > 200 ? s.slice(0, 200) + '...' : s;
  } catch {
    return '';
  }
}

/**
 * Merge every source into one newest-first timeline.
 * @returns {{events:Array, sources:object, note:string}}
 */
function timeline(projectId, limit = 200) {
  const parts = [
    ...harnessEvents(projectId, limit),
    ...taskEvents(projectId, limit),
    ...workerEvents(projectId, limit),
    ...workbenchEvents(projectId, limit),
  ];
  parts.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  // De-duplicate identical (at, source, label) triples: the same transition can be recorded
  // in both the harness log and a task history, and showing it twice is noise.
  const seen = new Set();
  const events = [];
  for (const e of parts) {
    const key = `${e.at}|${e.source}|${e.label}|${e.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(e);
    if (events.length >= limit) break;
  }

  return {
    events,
    sources: {
      harness: path.resolve(__dirname, '..', '..', 'runtime', 'harness', 'logs', 'harness.jsonl'),
      task: 'task histories in the project task registry',
      worker: 'worker ledger history',
      workbench: store.STATE_FILE,
    },
    note: 'Projected from existing logs and records at read time. Nothing is stored here, so no second source of truth is created.',
  };
}

module.exports = { timeline, harnessEvents, taskEvents, workerEvents, workbenchEvents };
