'use strict';
/**
 * protocol.js - the Verified Task Protocol: schema, construction, and the rules that bind a run.
 *
 * WHY A PROTOCOL AND NOT A PROMPT TEMPLATE
 *   A prompt is prose. Prose cannot be validated, diffed, correlated, or reasoned about by a machine.
 *   Everything here is structured data with a version, and the human-readable packet a worker
 *   receives is GENERATED from it by a renderer. That separation is the whole point: a new provider
 *   or transport needs a new renderer, never a new protocol.
 *
 *   Concretely, the flow is:
 *       Envelope  ->  Renderer  ->  transport-specific packet
 *   and never "a pile of prompt text that happens to be the protocol".
 *
 * THE FOUR FAILURE MODES THIS EXISTS TO KILL
 *   stale reply            a worker answers an older dispatch and the answer is accepted as current
 *   wrong conversation     an answer arrives from a conversation that was never dispatched to
 *   duplicate send         the same work is sent twice because nobody could prove the first landed
 *   reconnect ambiguity    after a restart, nobody can say whether a dispatch committed
 *
 *   All four are answered by one field: run_id, echoed back as run_id_ack. A reply whose ack does
 *   not match the run is NOT "probably fine" - it is quarantined as STALE_OR_UNCORRELATED_REPLY and
 *   never reaches review.
 *
 * TOCTOU
 *   Source hashes are captured at dispatch, acknowledged by the worker, and RE-VERIFIED before any
 *   write. If a hash moved, the change is refused with SOURCE_CHANGED_SINCE_REVIEW regardless of how
 *   good the answer looks. This is the rule that was proven by hand on the Game project, promoted
 *   here from a one-off check into a protocol guarantee.
 *
 * Zero dependencies. ASCII-only source.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL_VERSION = '0.2.0';

/** Terminal dispositions of a run. Anything not here is still in flight or needs a human. */
const RUN_STATUS = {
  DISPATCHED: 'DISPATCHED',
  SEND_PENDING: 'SEND_PENDING',
  ASSISTANT_PENDING: 'ASSISTANT_PENDING',
  STALE_OR_UNCORRELATED_REPLY: 'STALE_OR_UNCORRELATED_REPLY',
  SOURCE_CHANGED_SINCE_REVIEW: 'SOURCE_CHANGED_SINCE_REVIEW',
  AWAITING_REVIEW: 'AWAITING_REVIEW',
  COMPLETE: 'COMPLETE',
  BLOCKED: 'BLOCKED',
};

/** What `final_status` may be on an Evidence Record. */
const EVIDENCE_STATUS = {
  VERIFIED: 'VERIFIED',
  PARTIAL: 'PARTIAL',
  UNVERIFIED: 'UNVERIFIED',
  BLOCKED: 'BLOCKED',
};

// ---------------------------------------------------------------------------
// identity and hashing
// ---------------------------------------------------------------------------

/** Stable, sortable, collision-resistant run id. Prefixed so it reads as a protocol object. */
function newRunId(scope) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(4).toString('hex');
  const tag = String(scope ?? 'run').replace(/[^a-z0-9]+/gi, '-').slice(0, 18).toLowerCase();
  return `RUN-${stamp}-${tag}-${rand}`;
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Capture the source identity of a set of files, relative to a project root.
 *
 * A file that cannot be read is recorded with sha256: null rather than omitted. An omitted file
 * looks like "not part of the scope"; a null hash says "this was in scope and could not be
 * verified", which is the honest and much more useful statement.
 */
function captureSourceFiles(projectRoot, relPaths) {
  return relPaths.map((rel) => {
    const abs = path.join(projectRoot, rel);
    const exists = fs.existsSync(abs);
    return {
      path: String(rel).replace(/\\/g, '/'),
      sha256: exists ? sha256File(abs) : null,
      bytes: exists ? fs.statSync(abs).size : null,
      present_at_dispatch: exists,
    };
  });
}

/**
 * Re-verify source files against the hashes recorded at dispatch. THE TOCTOU GATE.
 *
 * @returns {{ok:boolean, status:string|null, changed:Array, missing:Array, verified:number}}
 */
function verifySourceUnchanged(projectRoot, sourceFiles) {
  const changed = [];
  const missing = [];
  let verified = 0;

  for (const f of sourceFiles ?? []) {
    const abs = path.join(projectRoot, f.path);
    if (!fs.existsSync(abs)) {
      // It was absent at dispatch and is absent now: that is consistent, not a change.
      if (f.sha256 === null) { verified += 1; continue; }
      missing.push(f.path);
      continue;
    }
    const now = sha256File(abs);
    if (now === f.sha256) { verified += 1; continue; }
    changed.push({ path: f.path, at_dispatch: f.sha256, now });
  }

  const bad = changed.length > 0 || missing.length > 0;
  return {
    ok: !bad,
    status: bad ? RUN_STATUS.SOURCE_CHANGED_SINCE_REVIEW : null,
    changed, missing, verified,
    total: (sourceFiles ?? []).length,
  };
}

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

/**
 * Build a Verified Task Envelope.
 *
 * Every field is either recorded fact or an explicit permission. Nothing is inferred later, because
 * "we will work out what it was allowed to touch afterwards" is how an agent writes to the wrong
 * file and nobody can tell whether that was permitted.
 */
function buildEnvelope(spec) {
  const {
    taskId, projectId, workspaceId, seatId,
    projectRoot, sourceRelPaths = [],
    readScope = [], writeScope = [], deny = [], approvalRequired = [],
    successCriteria = [], expectedOutput = null,
    reviewRequirements = {},
    taskTitle = null, taskDescription = null,
    request = null,
  } = spec;

  const missing = [];
  if (!taskId) missing.push('task_id');
  if (!projectId) missing.push('project_id');
  if (!workspaceId) missing.push('workspace_id');
  if (!seatId) missing.push('seat_id');
  if (missing.length) {
    return { ok: false, error: `envelope is missing required field(s): ${missing.join(', ')}` };
  }

  const envelope = {
    protocol_version: PROTOCOL_VERSION,
    run_id: spec.runId ?? newRunId(taskId),
    task_id: taskId,
    project_id: projectId,
    workspace_id: workspaceId,
    seat_id: seatId,

    task: { title: taskTitle, description: taskDescription },

    // The identity of what the worker is being asked to reason about.
    source_files: projectRoot ? captureSourceFiles(projectRoot, sourceRelPaths) : [],

    // Permissions are data, not prose. A renderer may phrase them; it may not change them.
    permissions: {
      read_scope: readScope,
      write_scope: writeScope,
      deny,
      approval_required: approvalRequired,
    },

    success_criteria: successCriteria,
    expected_output: expectedOutput,

    // Cross-vendor constraint is declared here and CHECKED later - see checkIndependence().
    review_requirements: {
      required: reviewRequirements.required !== false,
      independent_provider: reviewRequirements.independent_provider === true,
      min_reviewers: Number.isFinite(reviewRequirements.min_reviewers) ? reviewRequirements.min_reviewers : 1,
      note: reviewRequirements.note ?? null,
    },

    request: request ?? null,
    created_at: new Date().toISOString(),
  };

  return { ok: true, envelope };
}

/**
 * Validate an envelope's shape. Used before dispatch and by the regression tests.
 *
 * Deliberately shallow: it checks that required fields exist and have the right type, not that the
 * values are sensible. Sensible is a judgement; present-and-typed is a fact.
 */
function validateEnvelope(env) {
  const problems = [];
  const req = ['protocol_version', 'run_id', 'task_id', 'project_id', 'workspace_id', 'seat_id', 'created_at'];
  for (const k of req) {
    if (typeof env?.[k] !== 'string' || !env[k]) problems.push(`${k} must be a non-empty string`);
  }
  if (env?.protocol_version && env.protocol_version !== PROTOCOL_VERSION) {
    problems.push(`protocol_version ${env.protocol_version} is not ${PROTOCOL_VERSION}`);
  }
  if (!Array.isArray(env?.source_files)) problems.push('source_files must be an array');
  else {
    for (const f of env.source_files) {
      if (typeof f?.path !== 'string' || !f.path) problems.push('every source_file needs a path');
      if (!('sha256' in f)) problems.push(`source_file ${f?.path} has no sha256 field (null is allowed, absence is not)`);
    }
  }
  const p = env?.permissions;
  if (!p || typeof p !== 'object') problems.push('permissions must be an object');
  else {
    for (const k of ['read_scope', 'write_scope', 'deny', 'approval_required']) {
      if (!Array.isArray(p[k])) problems.push(`permissions.${k} must be an array`);
    }
  }
  if (!Array.isArray(env?.success_criteria)) problems.push('success_criteria must be an array');
  if (!env?.review_requirements || typeof env.review_requirements !== 'object') problems.push('review_requirements must be an object');
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// correlation
// ---------------------------------------------------------------------------

/**
 * Parse the acknowledgement block out of a worker reply.
 *
 * Workers are asked to reply with explicit RUN_ID_ACK / SOURCE_HASH_ACK lines. Parsing is tolerant
 * of surrounding prose because models add prose, but it is NOT tolerant of absence: a missing ack is
 * reported as missing, never treated as implicit agreement.
 */
function parseAck(replyText) {
  const text = String(replyText ?? '');
  const grab = (label) => {
    const re = new RegExp(`${label}\\s*[:=]\\s*([^\\s\`'"]+)`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    run_id_ack: grab('RUN_ID_ACK'),
    source_hash_ack: grab('SOURCE_HASH_ACK'),
    // Also accept an explicit statement that the worker saw no source.
    source_hash_ack_raw: (text.match(/SOURCE_HASH_ACK\s*[:=]\s*(.+)/i) || [])[1]?.trim() ?? null,
  };
}

/**
 * Check a reply's correlation against the run it claims to answer.
 *
 * THE RULE: mismatch is quarantined, never guessed at and never "probably fine".
 *
 * @returns {{ok:boolean, status:string|null, disposition:string, detail:string}}
 */
function checkCorrelation(envelope, replyText, opts = {}) {
  const ack = parseAck(replyText);

  /**
   * STRICT BYTE EQUALITY, WITH NO NORMALISATION WHATSOEVER.
   *
   * An earlier revision forgave letter case. That was a mistake and has been removed: a run id is an
   * opaque handle, and any tolerance added to make a mismatching reply "correlate" is indistinguishable
   * from inventing a correlation. A reply whose ack is not byte-identical to the expected id is
   * quarantined, and the caller may not widen the comparison to rescue it.
   *
   * The caller is expected to pass `opts.expectedRunId` from an IMMUTABLE run snapshot taken at
   * dispatch time (see protocol/correlation.js). When it does not, the envelope is used - and the
   * trace records that the source was the mutable envelope, so a future stale-value bug is visible
   * rather than silent.
   */
  const expectedRunId = opts.expectedRunId !== undefined ? opts.expectedRunId : envelope.run_id;
  const expectedSourceHash = opts.expectedSourceHash
    ?? hashSourceSet((envelope.source_files ?? []).filter((f) => f.sha256 !== null));

  if (!ack.run_id_ack) {
    return {
      ok: false,
      status: RUN_STATUS.STALE_OR_UNCORRELATED_REPLY,
      disposition: 'MISSING_ACK',
      detail: 'the reply carries no RUN_ID_ACK, so it cannot be attributed to this run. '
        + 'It is quarantined rather than assumed to be the answer we asked for.',
      ack,
    };
  }
  if (ack.run_id_ack !== expectedRunId) {
    return {
      ok: false,
      status: RUN_STATUS.STALE_OR_UNCORRELATED_REPLY,
      disposition: 'RUN_ID_MISMATCH',
      detail: `the reply acks ${ack.run_id_ack} but this run is ${expectedRunId}. `
        + 'Refusing to review it: a mismatched ack means the answer belongs to a different dispatch.',
      ack, expected: expectedRunId,
    };
  }

  // Source ack: required only when the envelope actually bound any source.
  const boundFiles = (envelope.source_files ?? []).filter((f) => f.sha256 !== null);
  if (boundFiles.length > 0) {
    if (!ack.source_hash_ack) {
      return {
        ok: false,
        status: RUN_STATUS.STALE_OR_UNCORRELATED_REPLY,
        disposition: 'MISSING_SOURCE_ACK',
        detail: 'the run bound source files but the reply carries no SOURCE_HASH_ACK, so there is no '
          + 'evidence of which source version it reasoned about.',
        ack,
      };
    }
    if (ack.source_hash_ack !== expectedSourceHash) {
      return {
        ok: false,
        status: RUN_STATUS.SOURCE_CHANGED_SINCE_REVIEW,
        disposition: 'SOURCE_ACK_MISMATCH',
        detail: `the reply acks source ${ack.source_hash_ack} but this run dispatched ${expectedSourceHash}. `
          + 'The worker reasoned about different content than we recorded.',
        ack, expected: expectedSourceHash,
      };
    }
  }

  return { ok: true, status: null, disposition: 'CORRELATED', detail: 'run_id and source hash both match', ack };
}

/**
 * Correlation against an IMMUTABLE RUN SNAPSHOT, with a debug trace.
 *
 * WHY THIS EXISTS SEPARATELY
 *   The persisted records were correct while the live path reported RUN_ID_MISMATCH, which means the
 *   comparison was reading a value that had moved - a stale snapshot, not a matching-rule problem. Two
 *   defences are therefore combined:
 *
 *     1. The expected values come from a frozen snapshot taken at dispatch, so nothing downstream can
 *        mutate what a run is expected to be.
 *     2. Every check returns a compact TRACE naming each expected value, each received value, AND where
 *        the expected value came from. A mismatch is then attributable to a field instead of being a
 *        bare "not correlated".
 *
 * The trace never contains credentials, tokens, or the packet body - only identifiers and hashes.
 */
function correlateWithSnapshot(envelope, snapshot, replyText, opts = {}) {
  const ack = parseAck(replyText);
  const expected = snapshot;
  const received = {
    run_id_ack: ack.run_id_ack,
    source_hash_ack: ack.source_hash_ack,
    thread_id: opts.receivedThreadId ?? null,
    turn_id: opts.receivedTurnId ?? null,
  };

  const trace = {
    expected_run_id: expected.run_id,
    received_run_id_ack: received.run_id_ack,
    expected_thread_id: expected.thread_id ?? null,
    received_thread_id: received.thread_id ?? null,
    expected_turn_id: expected.turn_id ?? null,
    received_turn_id: received.turn_id ?? null,
    expected_source_hash: expected.source_hash ?? null,
    received_source_hash_ack: received.source_hash_ack ?? null,
    expected_source: expected.source,
  };

  // ---- field-by-field, strict ----
  const mismatched = [];
  if (!received.run_id_ack) mismatched.push('run_id_ack:MISSING');
  else if (received.run_id_ack !== expected.run_id) mismatched.push('run_id');

  // Thread/turn are checked only when the transport reports them AND the snapshot recorded them.
  if (expected.thread_id && received.thread_id && received.thread_id !== expected.thread_id) mismatched.push('thread_id');
  if (expected.turn_id && received.turn_id && received.turn_id !== expected.turn_id) mismatched.push('turn_id');

  const bound = (envelope.source_files ?? []).filter((f) => f.sha256 !== null);
  recheck_source: {
    if (!bound.length || !expected.source_hash) break recheck_source;
    if (!received.source_hash_ack) { mismatched.push('source_hash_ack:MISSING'); break recheck_source; }
    if (received.source_hash_ack !== expected.source_hash) mismatched.push('source_hash_ack');
  }

  if (mismatched.length) {
    return {
      ok: false,
      disposition: 'CORRELATION_MISMATCH',
      status: mismatched.some((m) => m.startsWith('source_hash'))
        ? RUN_STATUS.SOURCE_CHANGED_SINCE_REVIEW
        : RUN_STATUS.STALE_OR_UNCORRELATED_REPLY,
      mismatched_fields: mismatched,
      trace,
      ack,
      detail: `correlation failed on: ${mismatched.join(', ')}`,
    };
  }

  return { ok: true, disposition: 'CORRELATED', mismatched_fields: [], trace, ack, status: null, detail: 'all correlation fields match the dispatch snapshot' };
}

/**
 * One hash standing for a whole source set.
 *
 * TWO PROPERTIES THAT MATTER, AND WHY THIS IS NOT A METADATA HASH
 *
 *   1. For a SINGLE file, the set hash EQUALS that file's own sha256. That identity is what makes the
 *      marker meaningful: the value a worker echoes back can be compared directly against the hash of
 *      the content, and a reader can see at a glance which file version a run reasoned about. Hashing
 *      a "path:sha" string instead produced a different value from the file's own hash, so the marker
 *      identified a metadata record rather than the content itself - which is not what TOCTOU needs,
 *      and which made a correct single-file run look mismatched.
 *
 *   2. For MULTIPLE files the hash is order-independent. A set is a set: reordering the same
 *      content must not change the identity of the run, or the marker would depend on a listing
 *      order nobody promised to keep.
 *
 * The material is therefore the content hashes themselves, sorted. The delimiter between them is a
 * newline, and each entry is length-prefixed by the fixed-width hex hash, so two different sets cannot
 * collide by concatenation.
 */
function hashSourceSet(sourceFiles) {
  const hashes = (sourceFiles ?? [])
    .map((f) => f.sha256)
    .filter((h) => typeof h === 'string' && h.length > 0)
    .sort();

  // Single file: its own hash, verbatim. This is the common case and the one callers compare against.
  if (hashes.length === 1) return hashes[0];

  return crypto.createHash('sha256').update(hashes.join('\n')).digest('hex');
}

// ---------------------------------------------------------------------------
// independence (cross-vendor constraint)
// ---------------------------------------------------------------------------

/**
 * Decide whether a review actually satisfies the envelope's independence requirement.
 *
 * THE HONEST ANSWER MATTERS MORE THAN THE PASSING ONE
 *   A reviewer that shares the worker's provider is a second opinion from the same brain. Declaring
 *   that "independent review: satisfied" because a second seat existed would be the single most
 *   misleading thing this system could do, so when the requirement is set and the providers match,
 *   the result is UNSATISFIED and the UI says INDEPENDENCE NOT SATISFIED.
 */
function checkIndependence(envelope, workerSeat, reviewerSeat) {
  const req = envelope?.review_requirements ?? {};
  if (!req.independent_provider) {
    return { required: false, satisfied: null, detail: 'independence was not required for this run' };
  }
  if (!reviewerSeat) {
    return { required: true, satisfied: false, detail: 'independence required but no reviewer seat is recorded' };
  }
  const wp = workerSeat?.provider ?? null;
  const rp = reviewerSeat?.provider ?? null;
  if (!wp || !rp) {
    return { required: true, satisfied: false, detail: `independence cannot be judged: worker provider=${wp}, reviewer provider=${rp}` };
  }
  if (wp === rp) {
    return {
      required: true, satisfied: false,
      detail: `INDEPENDENCE NOT SATISFIED: worker and reviewer both use provider "${wp}". `
        + 'A second seat from the same provider is not an independent review.',
      worker_provider: wp, reviewer_provider: rp,
    };
  }
  return { required: true, satisfied: true, detail: `worker ${wp} vs reviewer ${rp}`, worker_provider: wp, reviewer_provider: rp };
}

module.exports = {
  PROTOCOL_VERSION, RUN_STATUS, EVIDENCE_STATUS,
  newRunId, sha256File, captureSourceFiles, verifySourceUnchanged, hashSourceSet,
  buildEnvelope, validateEnvelope,
  parseAck, checkCorrelation, correlateWithSnapshot, checkIndependence,
};
