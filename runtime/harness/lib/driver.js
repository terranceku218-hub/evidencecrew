'use strict';
/**
 * driver.js - the ONLY place that invokes the protected ChatGPT Web Worker.
 *
 * WHY A SINGLE CHOKEPOINT
 *   The worker is a verified, protected component. If several modules each shelled out to
 *   it, a change to its CLI contract would require finding every caller. Everything goes
 *   through here, so the coupling surface is one file with one documented contract.
 *
 * WHAT IT DOES NOT DO
 *   It never edits the worker, never touches its profile, and never writes its state. It
 *   calls the worker's PUBLIC CLI surface (`cw.js send | await | read | url | new |
 *   open_conversation | health_check`) and reads only what comes back on stdout.
 *
 * ASCII-ONLY source: see the encoding note in ../config.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const { CONFIG, run, logEvent } = require('./paths.js');

/** Absolute path to the protected worker CLI, from global config. */
function cliPath() {
  return CONFIG.paths.workerCli;
}

/**
 * Run one worker CLI command and parse its JSON stdout.
 *
 * The CLI prints a single JSON object and uses a non-zero exit only for adapter-level
 * failure; a BLOCKED state is a normal, well-formed result. So output is parsed even on a
 * non-zero exit, and the parse result is preferred over the exit code whenever it is
 * available.
 *
 * @param {string[]} args
 * @param {{projectId?:string, timeoutMs?:number}} [opts]
 * @returns {{ok:boolean, value?:any, error?:string, raw?:string, exitCode?:number}}
 */
function invoke(args, opts = {}) {
  const cli = cliPath();
  if (!fs.existsSync(cli)) {
    return { ok: false, error: `worker CLI not found: ${cli}` };
  }

  const res = run(process.execPath, [cli, ...args], {
    timeoutMs: opts.timeoutMs ?? CONFIG.limits.cliTimeoutMs,
    cwd: opts.cwd,
  });

  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();

  let parsed;
  try {
    parsed = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined) {
    logEvent('driver.invoke.unparsed', { args: args[0], exitCode: res.status }, opts.projectId);
    return {
      ok: false,
      error: stderr || stdout || `worker CLI produced no JSON (exit ${res.status})`,
      raw: `${stdout}\n${stderr}`.trim(),
      exitCode: res.status,
    };
  }

  return { ok: true, value: parsed, exitCode: res.status };
}

// ---------------------------------------------------------------------------
// capability wrappers - thin, so the worker stays the source of truth
// ---------------------------------------------------------------------------

function healthCheck(opts) {
  return invoke(['health_check'], opts);
}

function currentUrl(opts) {
  return invoke(['url'], opts);
}

function newConversation(opts) {
  return invoke(['new'], opts);
}

function openConversation(url, opts) {
  return invoke(['open_conversation', url], opts);
}

function send(file, opts) {
  return invoke(['send', file], opts);
}

function awaitCompletion(baselineTurns, opts) {
  return invoke(['await', String(baselineTurns)], opts);
}

function readReply(index, opts) {
  return invoke(['read', String(index)], opts);
}

/**
 * Send a packet and wait for completion, WITHOUT reading the reply.
 *
 * HOTFIX 2.0.1 (H2) - WHY THIS RETURNS A STRUCTURED OUTCOME
 *   The old version collapsed everything into `ok`, so a failure AFTER the message had
 *   actually landed (wait_complete timing out, a false-negative completion check) looked
 *   identical to a failure BEFORE it was sent. The caller then skipped round accounting even
 *   though the ChatGPT conversation had genuinely grown - so the rotation counter
 *   under-counted exactly the context growth it exists to bound.
 *
 *   The outcome now distinguishes the two moments:
 *     SEND_NOT_CONFIRMED  -> nothing landed; the round must NOT be counted
 *     USER_TURN_CONFIRMED -> the user turn is really in the conversation; count it
 *     ASSISTANT_COMPLETE  -> the turn was counted and the reply finished normally
 *     FAILED_AFTER_SEND   -> counted, but completion/reading failed afterwards
 *
 *   A round is "a user turn that really appeared", not "a round the harness believed
 *   succeeded", so the counter never rolls back once the turn is confirmed.
 *
 * @returns {{ok:boolean, outcome:string, sentConfirmed:boolean, round?:number,
 *            baselineTurns?:number, waitStatus?:string, detail?:string, stage?:string}}
 */
function sendAndWait(text, opts = {}) {
  const tmp = path.join(require('node:os').tmpdir(), `harness-packet-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    const sent = send(tmp, opts);
    if (!sent.ok || !sent.value?.ok) {
      // Nothing landed (or it is unknown whether anything landed). The adapter only reports
      // ok:true after confirming BOTH the user and the assistant turn appeared, so an
      // unsuccessful send is never mistaken for a counted round.
      return {
        ok: false,
        outcome: 'SEND_NOT_CONFIRMED',
        sentConfirmed: false,
        stage: 'send',
        waitStatus: sent.value?.status,
        detail: sent.value?.detail ?? sent.error ?? 'send failed',
      };
    }

    const baseline = sent.value.baselineTurns;
    const done = awaitCompletion(baseline, opts);
    if (!done.ok || done.value?.status !== 'COMPLETE') {
      return {
        ok: false,
        // The user turn IS in the conversation, so this round counts.
        outcome: 'FAILED_AFTER_SEND',
        sentConfirmed: true,
        stage: 'wait',
        waitStatus: done.value?.status ?? 'ERROR',
        baselineTurns: baseline,
        detail: done.value?.detail ?? done.error ?? 'wait failed',
      };
    }

    return {
      ok: true,
      outcome: 'ASSISTANT_COMPLETE',
      sentConfirmed: true,
      stage: 'complete',
      waitStatus: 'COMPLETE',
      baselineTurns: baseline,
      waitDetail: done.value.detail,
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp cleanup is best-effort */ }
  }
}

/** Full round: send, wait, read. Returns the raw reply text. */
function round(text, opts = {}) {
  const sent = sendAndWait(text, opts);
  if (!sent.ok) return sent;
  const reply = readReply(sent.baselineTurns, opts);
  if (!reply.ok || !reply.value?.ok) {
    return { ...sent, ok: false, outcome: 'FAILED_AFTER_SEND', stage: 'read',
             detail: reply.value?.detail ?? reply.error ?? 'read failed' };
  }
  return { ...sent, reply: reply.value.text };
}

module.exports = {
  cliPath,
  invoke,
  healthCheck,
  currentUrl,
  newConversation,
  openConversation,
  send,
  awaitCompletion,
  readReply,
  sendAndWait,
  round,
};
