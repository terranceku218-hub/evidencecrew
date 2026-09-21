'use strict';
/**
 * runs.js - the run orchestrator: one task, from envelope to Evidence Record.
 *
 * WHAT IT ORCHESTRATES
 *   envelope -> render -> dispatch to a seat -> correlate the ack -> re-verify source (TOCTOU)
 *   -> review (independence checked) -> approval -> Evidence Record
 *
 * WHAT IT REFUSES
 *   - It never re-dispatches. The only action available on a pending run is observation.
 *   - It never advances an uncorrelated reply into review. A mismatched ack is a terminal finding,
 *     not a reason to try again.
 *   - It never writes to a project. Applying a change is a separate, approved step; this module
 *     produces the record that makes that step safe, and stops.
 *
 * WHY SOURCE RE-VERIFICATION SITS BETWEEN REPLY AND REVIEW
 *   A worker can take minutes. In that time a human can edit the file. If a review is performed on a
 *   stale basis, the approval is worthless - so the order is fixed: correlate, then re-hash, then
 *   review. A hash that moved ends the run as SOURCE_CHANGED_SINCE_REVIEW before any human is asked
 *   to approve anything.
 */

const fs = require('node:fs');
const path = require('node:path');

const protocol = require('./protocol.js');
const renderers = require('./renderers.js');
const evidence = require('./evidence.js');
const seatModule = require('../seats/seat.js');
const { DELIVERY } = require('./transport-contract.js');

/** Active runs, in memory. The Evidence Record on disk is the durable artifact. */
const runs = new Map();

let logEvent = () => {};
function setLogger(fn) { logEvent = fn; }

function newOrchestrator(opts = {}) {
  const registry = opts.registry;
  if (!registry) throw new Error('the run orchestrator needs a seat registry');
  const projectRootOf = opts.projectRootOf ?? (() => null);

  /**
   * Open a run: build the envelope and dispatch it to a worker seat.
   *
   * Returns as soon as the DISPATCH has returned. It does not wait for the answer, because a
   * transport may legitimately take minutes to confirm and the caller must stay responsive.
   */
  async function open(spec) {
    const workerSeat = registry.byId(spec.workerSeatId) ?? registry.byRole(spec.workerRole ?? 'coder');
    if (!workerSeat) return { ok: false, error: `no worker seat: ${spec.workerSeatId ?? spec.workerRole ?? 'coder'}` };

    const supervisorSeat = registry.byRole('supervisor');
    const projectRoot = projectRootOf(spec.projectId);

    const built = protocol.buildEnvelope({
      taskId: spec.taskId,
      projectId: spec.projectId,
      workspaceId: spec.workspaceId,
      seatId: workerSeat.seat_id,
      projectRoot,
      sourceRelPaths: spec.sourceRelPaths ?? [],
      readScope: workerSeat.permissions.read_scope,
      writeScope: spec.writeScope ?? workerSeat.permissions.write_scope,
      deny: workerSeat.permissions.deny,
      approvalRequired: workerSeat.permissions.approval_required,
      successCriteria: spec.successCriteria ?? [],
      expectedOutput: spec.expectedOutput ?? null,
      reviewRequirements: spec.reviewRequirements ?? { required: true, independent_provider: false },
      taskTitle: spec.taskTitle ?? null,
      taskDescription: spec.taskDescription ?? null,
      request: spec.request ?? null,
    });
    if (!built.ok) return built;
    const envelope = built.envelope;

    const run = {
      run_id: envelope.run_id,
      envelope,
      goal_id: spec.goalId ?? null,
      supervisor_seat: supervisorSeat?.seat_id ?? null,
      worker_seat: workerSeat.seat_id,
      reviewer_seat: null,
      project_root: projectRoot,
      status: protocol.RUN_STATUS.DISPATCHED,
      opened_at: new Date().toISOString(),
      dispatch: null,
      correlation: null,
      toctou: null,
      review: null,
      approval: null,
      record_id: null,
      notes: [],
    };
    runs.set(run.run_id, run);

    const dispatched = await seatModule.dispatch(workerSeat, envelope, { renderer: spec.renderer });
    run.dispatch = dispatched;
    run.status = dispatched.delivery_state === DELIVERY.USER_TURN_CONFIRMED
      ? protocol.RUN_STATUS.ASSISTANT_PENDING
      : protocol.RUN_STATUS.SEND_PENDING;

    logEvent('run.opened', {
      run_id: run.run_id, task_id: envelope.task_id, seat: workerSeat.seat_id,
      provider: workerSeat.provider, transport: workerSeat.transport,
      renderer: dispatched.renderer, delivery_state: dispatched.delivery_state,
      source_files: envelope.source_files.length,
    });

    return { ok: dispatched.ok !== false, run_id: run.run_id, delivery_state: dispatched.delivery_state, dispatch: dispatched, envelope };
  }

  /** Observation only. The single legal action while a run is pending. */
  async function observe(runId) {
    const run = runs.get(runId);
    if (!run) return { ok: false, error: `no such run: ${runId}` };
    const seat = registry.byId(run.worker_seat);
    if (!seat) return { ok: false, error: `the worker seat for this run no longer exists: ${run.worker_seat}` };
    const r = await seatModule.observe(seat, run.envelope);
    if (r.confirmed && run.status === protocol.RUN_STATUS.SEND_PENDING) {
      run.status = protocol.RUN_STATUS.ASSISTANT_PENDING;
      logEvent('run.pending.resolved', { run_id: runId, detail: r.detail });
    }
    return { ok: true, run_id: runId, delivery_state: r.delivery_state, confirmed: r.confirmed, detail: r.detail };
  }

  /**
   * Complete the run from an obtained reply.
   *
   * The order here is the protocol: correlate FIRST, then re-verify source, then allow review. Each
   * step can end the run, and none of them can be skipped by passing a flag.
   */
  async function completeFromReply(runId, replyText, opts2 = {}) {
    const run = runs.get(runId);
    if (!run) return { ok: false, error: `no such run: ${runId}` };
    const envelope = run.envelope;

    // ---- 1. correlation ----
    const corr = protocol.checkCorrelation(envelope, replyText, {
      expectedSourceHash: protocol.hashSourceSet(envelope.source_files.filter((f) => f.sha256 !== null)),
    });
    run.correlation = corr;
    if (!corr.ok) {
      run.status = corr.status;
      logEvent('run.uncorrelated', { run_id: runId, disposition: corr.disposition, detail: corr.detail });
      return {
        ok: false, run_id: runId, status: corr.status, disposition: corr.disposition,
        detail: corr.detail,
        note: 'The reply was NOT passed to review. A reply that cannot be attributed is not a result.',
      };
    }

    // ---- 2. TOCTOU: the source must still be what the worker reasoned about ----
    const toctou = protocol.verifySourceUnchanged(run.project_root, envelope.source_files);
    run.toctou = toctou;
    if (!toctou.ok) {
      run.status = protocol.RUN_STATUS.SOURCE_CHANGED_SINCE_REVIEW;
      logEvent('run.source_changed', { run_id: runId, changed: toctou.changed, missing: toctou.missing });
      return {
        ok: false, run_id: runId, status: protocol.RUN_STATUS.SOURCE_CHANGED_SINCE_REVIEW,
        detail: `source changed after dispatch: ${toctou.changed.map((c) => c.path).join(', ') || ''} ${toctou.missing.join(', ')}`.trim(),
        toctou,
        note: 'No patch may be applied. Re-dispatch against the current source instead of reviewing a stale basis.',
      };
    }

    run.proposal = replyText;
    run.status = protocol.RUN_STATUS.AWAITING_REVIEW;
    logEvent('run.awaiting_review', { run_id: runId, source_verified: toctou.verified });

    return { ok: true, run_id: runId, status: run.status, correlation: corr.disposition, toctou: { verified: toctou.verified, total: toctou.total } };
  }

  /**
   * Record a review, checking the independence requirement rather than assuming it.
   *
   * A review by a seat sharing the worker's provider is recorded as REVIEWED but leaves the
   * envelope's independence requirement UNSATISFIED - and the card will say so.
   */
  function recordReview(runId, reviewSpec) {
    const run = runs.get(runId);
    if (!run) return { ok: false, error: `no such run: ${runId}` };
    if (run.status !== protocol.RUN_STATUS.AWAITING_REVIEW) {
      return { ok: false, error: `run ${runId} is ${run.status}; a review is only accepted for a correlated, source-verified run` };
    }

    const reviewerSeat = reviewSpec.reviewerSeatId ? registry.byId(reviewSpec.reviewerSeatId) : registry.byRole('reviewer');
    const workerSeat = registry.byId(run.worker_seat);
    const independence = protocol.checkIndependence(run.envelope, workerSeat, reviewerSeat);

    run.reviewer_seat = reviewerSeat?.seat_id ?? null;
    run.review = {
      verdict: reviewSpec.verdict ?? null,
      reviewer_seat: run.reviewer_seat,
      reviewer_provider: reviewerSeat?.provider ?? null,
      reviewer_transport: reviewerSeat?.transport ?? null,
      summary: reviewSpec.summary ?? null,
      reviewed_at: new Date().toISOString(),
    };
    run.independence = independence;

    logEvent('run.reviewed', {
      run_id: runId, verdict: run.review.verdict, reviewer: run.reviewer_seat,
      independence_satisfied: independence.satisfied, detail: independence.detail,
    });
    return { ok: true, run_id: runId, review: run.review, independence };
  }

  /** Record the human decision. Approval is data; applying it is a different, later thing. */
  function recordApproval(runId, approvalSpec) {
    const run = runs.get(runId);
    if (!run) return { ok: false, error: `no such run: ${runId}` };
    run.approval = {
      decision: approvalSpec.decision ?? null,
      by: approvalSpec.by ?? 'user',
      reason: approvalSpec.reason ?? null,
      at: new Date().toISOString(),
    };
    logEvent('run.approval', { run_id: runId, decision: run.approval.decision });
    return { ok: true, run_id: runId, approval: run.approval };
  }

  /**
   * Produce the Evidence Record. This is the product of a run.
   *
   * Everything is copied from what was actually observed; nothing is defaulted into looking present.
   */
  function finalize(runId, finalSpec = {}) {
    const run = runs.get(runId);
    if (!run) return { ok: false, error: `no such run: ${runId}` };
    const env = run.envelope;
    const workerSeat = registry.byId(run.worker_seat);

    const rec = evidence.buildRecord({
      protocolVersion: env.protocol_version,
      goalId: run.goal_id,
      taskId: env.task_id,
      runId: env.run_id,
      supervisorSeat: run.supervisor_seat,
      workerSeat: run.worker_seat,
      reviewerSeat: run.reviewer_seat,
      seatProviders: {
        supervisor: registry.byId(run.supervisor_seat)?.provider ?? null,
        worker: workerSeat?.provider ?? null,
        reviewer: run.review?.reviewer_provider ?? null,
      },
      sourceHashes: env.source_files,
      sourceSetHash: protocol.hashSourceSet(env.source_files.filter((f) => f.sha256 !== null)),
      runIdAck: run.correlation?.ack?.run_id_ack ?? null,
      sourceHashAck: run.correlation?.ack?.source_hash_ack ?? null,
      correlation: env.run_id,
      correlationDisposition: run.correlation?.disposition ?? null,
      proposal: run.proposal ?? null,
      reviewResult: run.review ?? null,
      approval: run.approval?.decision ?? null,
      changedFiles: finalSpec.changedFiles ?? null,
      diffSummary: finalSpec.diffSummary ?? null,
      writeScope: env.permissions.write_scope,
      diffScopeOk: finalSpec.diffScopeOk ?? null,
      validationResults: finalSpec.validationResults ?? null,
      runtimeValidation: finalSpec.runtimeValidation ?? evidence.NOT_RECORDED,
      independence: run.independence ?? { required: env.review_requirements.independent_provider, satisfied: null, detail: 'no review was recorded' },
      commit: finalSpec.commit ?? null,
      startedAt: run.opened_at,
      completedAt: new Date().toISOString(),
      notes: run.notes,
    });

    rec.run_status = run.status;
    rec.record_id = `EV-${env.project_id}-${env.task_id}-${env.run_id.slice(-8)}`;
    run.record_id = rec.record_id;

    const jsonPath = evidence.saveRecord(rec.record_id, rec);
    const md = evidence.toMarkdown(rec);
    fs.writeFileSync(jsonPath.replace(/\.json$/, '.md'), md, 'utf8');

    logEvent('run.evidence', { run_id: runId, record_id: rec.record_id, final_status: rec.final_status, missing: rec.missing_evidence });

    return { ok: true, record: rec, record_id: rec.record_id, json: jsonPath, missing_evidence: rec.missing_evidence };
  }

  function get(runId) {
    const run = runs.get(runId);
    if (!run) return null;
    return {
      run_id: run.run_id,
      status: run.status,
      task_id: run.envelope.task_id,
      worker_seat: run.worker_seat,
      reviewer_seat: run.reviewer_seat,
      supervisor_seat: run.supervisor_seat,
      delivery_state: run.dispatch?.delivery_state ?? null,
      correlation_disposition: run.correlation?.disposition ?? null,
      toctou_ok: run.toctou?.ok ?? null,
      independence: run.independence ?? null,
      review_verdict: run.review?.verdict ?? null,
      approval: run.approval?.decision ?? null,
      record_id: run.record_id,
      opened_at: run.opened_at,
    };
  }

  function list() { return [...runs.keys()].map(get); }

  return { open, observe, completeFromReply, recordReview, recordApproval, finalize, get, list };
}

module.exports = { newOrchestrator, setLogger };
