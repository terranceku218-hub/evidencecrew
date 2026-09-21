'use strict';
/**
 * correlation.js - the IMMUTABLE run snapshot that correlation is compared against.
 *
 * THE BUG THIS FIXES
 *   Persisted records showed `run_id` and `run_id_ack` byte-identical, while the live acceptance path
 *   still reported RUN_ID_MISMATCH. That combination means one thing: the comparison was not reading
 *   the value it had recorded. Expected identifiers were being re-derived at check time from things
 *   that move - a mutable envelope, a seat's `current_run`, or "the latest run" - so a later write could
 *   change what a finished run was expected to be. It was never a matching-rule problem, and it is not
 *   fixed by widening the match.
 *
 * THE FIX
 *   At dispatch time, freeze a snapshot of exactly what this run expects:
 *     run_id, thread_id, turn_id, source_hash, seat_id, task_id
 *   Correlation then reads from that snapshot and NOWHERE ELSE. The snapshot is deeply frozen, so an
 *   accidental write throws in strict mode instead of silently changing history.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   No prompt text, no credentials, no tokens. A trace of a mismatch must be safe to store and to paste
 *   into an issue, so it carries identifiers and hashes only.
 */

/** Deep-freeze so nothing can mutate an in-flight run's expectations. */
function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

/**
 * Take the snapshot. Call this ONCE, immediately before dispatch.
 *
 * @param {{envelope:object, threadId?:string|null, turnId?:string|null, source?:string}} spec
 */
function captureRunSnapshot(spec) {
  const env = spec.envelope ?? {};
  const bound = (env.source_files ?? []).filter((f) => f.sha256 !== null);

  const snap = {
    /* What this run is expected to be. Frozen at dispatch; never re-derived. */
    run_id: env.run_id,
    thread_id: spec.threadId ?? null,
    turn_id: spec.turnId ?? null,
    source_hash: bound.length ? require('./protocol.js').hashSourceSet(bound) : null,
    seat_id: env.seat_id ?? null,
    task_id: env.task_id ?? null,
    project_id: env.project_id ?? null,
    workspace_id: env.workspace_id ?? null,
    /* Provenance, so a trace can say WHERE the expectation came from. */
    source: spec.source ?? (spec.threadId ? 'dispatch_transport_ids' : 'mutable_envelope'),
    captured_at: new Date().toISOString(),
    /** Filled in once the transport reports the ids it created; the run id is never touched. */
    transport_ids_confirmed: false,
  };
  return deepFreeze(snap);
}

/**
 * The transport's thread/turn ids, which are only known AFTER dispatch returns.
 *
 * A run id is known before dispatch, so it is frozen at capture. Thread and turn ids come from the
 * transport's response, so they are recorded as a SEPARATE frozen pair rather than written back into
 * the first snapshot - writing back would reintroduce exactly the mutation this design removes.
 */
function captureTransportIds(threadId, turnId, at) {
  return deepFreeze({
    thread_id: threadId ?? null,
    turn_id: turnId ?? null,
    at: at ?? new Date().toISOString(),
    source: 'transport_dispatch_response',
  });
}

/**
 * Build the comparison view: the run snapshot plus the transport ids.
 *
 * This is a NEW frozen object. It never modifies the run snapshot, so the expectation recorded at
 * dispatch remains auditable even if the transport later disagrees with itself.
 */
function effectiveExpectation(runSnapshot, transportIds) {
  return deepFreeze({
    ...runSnapshot,
    thread_id: transportIds?.thread_id ?? runSnapshot.thread_id ?? null,
    turn_id: transportIds?.turn_id ?? runSnapshot.turn_id ?? null,
    source: transportIds
      ? `${runSnapshot.source}+transport_dispatch_response`
      : runSnapshot.source,
  });
}

module.exports = { captureRunSnapshot, captureTransportIds, effectiveExpectation, deepFreeze };
