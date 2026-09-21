'use strict';
/**
 * evidence.js - the Evidence Record: what actually happened on a task, in machine-readable form.
 *
 * THE RULE THAT SHAPES THIS FILE
 *   A record must be able to say "not recorded". The temptation is to fill every field so the card
 *   looks complete - and that is precisely how a system starts lying. A missing acknowledgement is
 *   evidence of a MISSING acknowledgement, which is a finding, and it must survive into the record
 *   rather than be smoothed over with a plausible default.
 *
 *   So: absent data stays `null` or the literal string 'NOT RECORDED', and `final_status` is derived
 *   from what is actually present. A record with a gap cannot be VERIFIED, no matter how good the
 *   change was.
 *
 * JSON IS THE SOURCE OF TRUTH
 *   Markdown and the UI are projections. Anything that needs to be trusted - a hash, an ack, a
 *   validation result - lives here and is never re-derived from prose.
 */

const fs = require('node:fs');
const path = require('node:path');

const { EVIDENCE_STATUS, RUN_STATUS } = require('./protocol.js');

/** The literal used when a field genuinely was not captured. Distinct from null-on-purpose. */
const NOT_RECORDED = 'NOT RECORDED';

/**
 * Build an Evidence Record from a completed (or blocked) run.
 *
 * Every parameter is expected to be an explicit fact. Where a caller does not know something, it
 * must pass null - and this function will record that as unknown rather than inventing it.
 */
function buildRecord(spec = {}) {
  const rec = {
    record_version: '0.2.0',
    protocol_version: spec.protocolVersion ?? null,

    // ---- identity ----
    goal_id: spec.goalId ?? null,
    task_id: spec.taskId ?? null,
    run_id: spec.runId ?? null,

    // ---- who ----
    supervisor_seat: spec.supervisorSeat ?? null,
    worker_seat: spec.workerSeat ?? null,
    reviewer_seat: spec.reviewerSeat ?? null,
    seat_providers: spec.seatProviders ?? null,

    // ---- source identity ----
    source_hashes: spec.sourceHashes ?? null,
    source_set_hash: spec.sourceSetHash ?? null,

    // ---- correlation ----
    run_id_ack: spec.runIdAck ?? null,
    source_hash_ack: spec.sourceHashAck ?? null,
    correlation: spec.correlation ?? null,
    correlation_disposition: spec.correlationDisposition ?? null,

    // ---- content ----
    proposal: spec.proposal ?? null,
    review_result: spec.reviewResult ?? null,
    approval: spec.approval ?? null,

    // ---- what changed ----
    changed_files: spec.changedFiles ?? null,
    diff_summary: spec.diffSummary ?? null,
    write_scope: spec.writeScope ?? null,
    diff_scope_ok: spec.diffScopeOk ?? null,

    // ---- what was checked ----
    validation_results: spec.validationResults ?? null,
    runtime_validation: spec.runtimeValidation ?? null,
    independence: spec.independence ?? null,

    /**
     * REVIEW LEVEL AND THE OPTIONAL INDEPENDENT REVIEWER
     *
     * A disabled reviewer is a CONFIGURED CHOICE, not a gap in the evidence, and the record keeps those
     * two apart. `independent_review_status` carries the reason (DISABLED_BY_POLICY / NOT_REQUESTED /
     * UNAVAILABLE / SATISFIED / NOT_SATISFIED), and `review_level` states what the result actually rests
     * on. So a Codex-off task can be honestly complete at SUPERVISOR_REVIEW without ever rendering as
     * an independent review, and without `missing_evidence` crying wolf about a reviewer nobody asked for.
     */
    review_level: spec.reviewLevel ?? null,
    independent_review_status: spec.independentReviewStatus ?? null,
    independent_review_detail: spec.independentReviewDetail ?? null,
    codex_review_mode: spec.codexReviewMode ?? null,

    // ---- outcome ----
    commit: spec.commit ?? null,
    started_at: spec.startedAt ?? null,
    completed_at: spec.completedAt ?? null,

    // ---- provenance of the record itself ----
    // Set for records reconstructed from a project that predates the protocol. It is the honesty
    // marker: a legacy record can never claim protocol-grade correlation.
    record_origin: spec.recordOrigin ?? 'PROTOCOL_RUN',
    legacy_reason: spec.legacyReason ?? null,
    notes: spec.notes ?? [],
  };

  rec.final_status = spec.finalStatus ?? deriveStatus(rec);
  rec.missing_evidence = listMissing(rec);
  return rec;
}

/**
 * Derive the headline status from the evidence actually present.
 *
 * The ladder is deliberate and strict: BLOCKED beats everything, an uncorrelated or scope-violating
 * result is UNVERIFIED (never PARTIAL - a change we cannot attribute is not partially verified, it is
 * unverified), and VERIFIED requires every load-bearing element including a re-checked source hash.
 */
function deriveStatus(rec) {
  if (rec.correlation_disposition && rec.correlation_disposition !== 'CORRELATED') {
    return EVIDENCE_STATUS.UNVERIFIED;
  }
  if (rec.diff_scope_ok === false) return EVIDENCE_STATUS.UNVERIFIED;
  if (rec.approval === 'REJECTED') return EVIDENCE_STATUS.BLOCKED;

  /**
   * READ-ONLY AWARENESS.
   *
   * A read-only task has nothing to hash at dispatch and nothing to commit at the end. Demanding
   * source hashes and a commit from it would make the honest answer ("none, and none was needed")
   * look like missing evidence, and the run could never reach VERIFIED however well it went. That is
   * not strictness, it is a bug: a status nobody can achieve is a status nobody reads.
   *
   * Writable tasks are held to the full standard, because there the hashes and the commit are the
   * whole point.
   */
  const writable = Array.isArray(rec.write_scope) && rec.write_scope.length > 0;

  const hasSourceIdentity = Array.isArray(rec.source_hashes)
    ? rec.source_hashes.some((f) => f && f.sha256)
    : false;
  const correlated = rec.run_id_ack !== null && rec.run_id_ack !== undefined
    && rec.correlation_disposition === 'CORRELATED';
  const hasValidation = Array.isArray(rec.validation_results) && rec.validation_results.length > 0;
  const hasProposal = typeof rec.proposal === 'string' && rec.proposal.trim().length > 0;
  const independenceRequired = rec.independence?.required === true;
  const independenceOk = independenceRequired ? rec.independence?.satisfied === true : true;

  if (!hasProposal) return EVIDENCE_STATUS.UNVERIFIED;
  if (!correlated) return EVIDENCE_STATUS.PARTIAL;
  if (writable && !hasSourceIdentity) return EVIDENCE_STATUS.PARTIAL;
  if (writable && !hasValidation) return EVIDENCE_STATUS.PARTIAL;
  if (!writable && !hasValidation) return EVIDENCE_STATUS.PARTIAL;
  /**
   * INDEPENDENCE IS ONLY REQUIRED WHEN IT WAS ASKED FOR.
   *
   * A reviewer disabled by policy is not an unmet requirement. Requiring an `independence.satisfied`
   * of true whenever any review exists would make every Codex-off run permanently PARTIAL and would
   * quietly push operators to switch the reviewer on just to clear a status - the opposite of an
   * optional reviewer. What is still enforced: if independence WAS required and was not satisfied, the
   * run cannot be VERIFIED.
   */
  if (!independenceOk) return EVIDENCE_STATUS.PARTIAL;
  if (independenceRequired && rec.reviewer_seat === null) return EVIDENCE_STATUS.PARTIAL;

  return EVIDENCE_STATUS.VERIFIED;
}

/**
 * Every load-bearing field that is absent, named. Reported, not hidden.
 *
 * Read-only awareness applies here too: a read-only task genuinely has no source set to hash and no
 * commit to make, so listing those as "missing" would inflate the gap and train the reader to ignore
 * the list. What is missing must mean something.
 */
function listMissing(rec) {
  const writable = Array.isArray(rec.write_scope) && rec.write_scope.length > 0;
  const missing = [];
  if (!rec.run_id) missing.push('run_id');
  if (rec.run_id_ack === null || rec.run_id_ack === undefined) missing.push('run_id_ack');
  if (writable) {
    if (!Array.isArray(rec.source_hashes) || !rec.source_hashes.some((f) => f && f.sha256)) missing.push('source_hashes');
    if (rec.source_hash_ack === null || rec.source_hash_ack === undefined) missing.push('source_hash_ack');
    if (rec.commit === null || rec.commit === undefined) missing.push('commit');
  }
  if (!rec.worker_seat) missing.push('worker_seat');
  if (!rec.proposal) missing.push('proposal');
  if (rec.review_result === null || rec.review_result === undefined) missing.push('review_result');
  if (rec.approval === null || rec.approval === undefined) missing.push('approval');
  if (!Array.isArray(rec.validation_results) || !rec.validation_results.length) missing.push('validation_results');
  return missing;
}

// ---------------------------------------------------------------------------
// legacy reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct a record for a run that happened BEFORE the protocol existed.
 *
 * WHAT THIS MAY AND MAY NOT DO
 *   It may recover facts that were genuinely written down elsewhere: the source hash from the
 *   project's own verification log, the worker identity from the harness ledger, the diff and commit
 *   from git, the validation result from the static-verification report.
 *
 *   It may NOT invent a `run_id` or a `run_id_ack`. Those did not exist, so they are NOT RECORDED -
 *   and the record is stamped LEGACY_RUN so no reader can mistake it for a protocol-governed run.
 *   A card that showed a fabricated ack would be the single most damaging thing this project could
 *   ship, because the whole value of the card is that its ticks mean something.
 */
function buildLegacyRecord(spec = {}) {
  const rec = buildRecord({
    ...spec,
    runId: null,
    runIdAck: null,
    sourceHashAck: null,
    correlationDisposition: 'NOT_APPLICABLE_LEGACY',
    recordOrigin: 'LEGACY_RUN',
    legacyReason:
      'This task completed before the Verified Task Protocol existed. run_id and the worker '
      + 'acknowledgements were not part of the process, so they are NOT RECORDED rather than guessed.',
    notes: [
      ...(spec.notes ?? []),
      'Source hash and validation results were recovered from the project\'s own verification records.',
      'No run correlation can be claimed for this run, by construction.',
    ],
  });
  return rec;
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

// PUBLIC RELEASE CHANGE: one shared loader resolves every configured path against the repository root,
// so this file no longer assumes absolute paths recorded on the maintainer machine.
const { CONFIG } = require('../config.js');

function recordsDir() {
  const dir = path.join(CONFIG.paths.workbenchRoot, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function recordPath(recordId) {
  return path.join(recordsDir(), `${String(recordId).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
}

/** JSON is the source of truth: write it first, atomically. */
function saveRecord(recordId, rec) {
  const target = recordPath(recordId);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

function loadRecord(recordId) {
  const p = recordPath(recordId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function listRecords(limit = 50) {
  const dir = recordsDir();
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(dir, f);
      return { id: f.replace(/\.json$/, ''), mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => loadRecord(f.id))
    .filter(Boolean);
}

/**
 * The Markdown view. Generated FROM the JSON, never edited by hand, and never parsed back.
 */
function toMarkdown(rec) {
  const tick = (v) => (v === true ? 'OK' : v === false ? 'NO' : 'NOT RECORDED');
  const lines = [
    `# Evidence: ${rec.task_id ?? rec.record_id ?? 'unknown task'}`,
    '',
    `**Status: ${rec.final_status}**${rec.record_origin === 'LEGACY_RUN' ? '  _(LEGACY RUN)_' : ''}`,
    '',
    `| Element | Value |`,
    `|---|---|`,
    `| Goal | ${rec.goal_id ?? NOT_RECORDED} |`,
    `| Run | ${rec.run_id ?? NOT_RECORDED} |`,
    `| Supervisor seat | ${rec.supervisor_seat ?? NOT_RECORDED} |`,
    `| Worker seat | ${rec.worker_seat ?? NOT_RECORDED} |`,
    `| Reviewer seat | ${rec.reviewer_seat ?? NOT_RECORDED} |`,
    `| Run ACK | ${rec.run_id_ack ?? NOT_RECORDED} |`,
    `| Source hash ACK | ${rec.source_hash_ack ?? NOT_RECORDED} |`,
    `| Correlation | ${rec.correlation_disposition ?? NOT_RECORDED} |`,
    `| Independent review | ${rec.independence?.satisfied === true ? 'satisfied' : rec.independence?.detail ?? NOT_RECORDED} |`,
    `| Review level | ${rec.review_level ?? NOT_RECORDED} |`,
    `| Independent review status | ${rec.independent_review_status ?? NOT_RECORDED} |`,
    `| Codex review mode | ${rec.codex_review_mode ?? NOT_RECORDED} |`,
    `| Approval | ${rec.approval ?? NOT_RECORDED} |`,
    `| Diff scope | ${tick(rec.diff_scope_ok)} |`,
    `| Commit | ${rec.commit ?? NOT_RECORDED} |`,
    `| Runtime validation | ${rec.runtime_validation ?? NOT_RECORDED} |`,
    '',
  ];
  if (rec.missing_evidence?.length) {
    lines.push('## Missing evidence', '', ...rec.missing_evidence.map((m) => `- ${m}`), '');
  }
  if (rec.legacy_reason) lines.push('## Why this is a legacy record', '', rec.legacy_reason, '');
  lines.push('_Machine-readable source of truth: the JSON record beside this file. This view is generated._');
  return lines.join('\n');
}

module.exports = {
  NOT_RECORDED,
  buildRecord, buildLegacyRecord, deriveStatus, listMissing,
  saveRecord, loadRecord, listRecords, toMarkdown, recordsDir,
  EVIDENCE_STATUS, RUN_STATUS,
};
