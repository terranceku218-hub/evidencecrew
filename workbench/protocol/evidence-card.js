'use strict';
/**
 * evidence-card.js - the Evidence Record projected as a UI-ready, HONEST view.
 *
 * WHY THIS IS A PROJECTION AND NOT A LAYOUT
 *   The record is the truth; this decides what a reader must see and in what order. Keeping the
 *   projection here rather than in the browser means the honesty rules are testable in Node: that a
 *   missing ack cannot render as a tick, that same-provider review cannot render as independent, and
 *   that a legacy run cannot render as protocol-governed.
 *
 * THE DISPLAY RULE
 *   Every element resolves to one of four marks, and the marks are not interchangeable:
 *     ok      a fact was recorded and it is good
 *     bad     a fact was recorded and it is a problem
 *     absent  the fact was NOT RECORDED - rendered as a dash, never as a tick
 *     n/a     the element does not apply to this run
 *
 *   `absent` is the entire reason this file exists. A card that shows a green tick for something
 *   nobody recorded is worse than no card, because the reader will act on it.
 */

const { EVIDENCE_STATUS } = require('./evidence.js');

const MARKS = { OK: 'ok', BAD: 'bad', ABSENT: 'absent', NA: 'n/a' };

const SYMBOL = { ok: '\u2713', bad: '\u2717', absent: '\u2013', 'n/a': '\u00b7' };

const STATUS_CLASS = {
  VERIFIED: 'verified',
  PARTIAL: 'partial',
  UNVERIFIED: 'unverified',
  BLOCKED: 'blocked',
};

function element(key, label, mark, value, note = null) {
  return { key, label, mark, symbol: SYMBOL[mark], value: value ?? null, note };
}

function present(v) {
  return v !== null && v !== undefined && v !== '' && v !== 'NOT RECORDED' && v !== 'NOT_RECORDED';
}

/**
 * Classify a runtime-validation statement.
 *
 * Runtime verification is a NEGATIVE capability in this stack - there is no compiler or runtime here -
 * so this field is where a card is most likely to lie. Four outcomes, and they are not interchangeable:
 *   explicitly not applicable to this task -> n/a
 *   recorded as not performed              -> bad (a gap the reader must not overlook)
 *   never recorded at all                  -> absent (a dash, never a tick)
 *   actually performed                     -> ok
 *
 * MEASURED DEFECT this replaces: the old rule granted `ok` to ANY string its two negative patterns did
 * not match, so the sentinel NOT RECORDED - the value this protocol itself writes for a field nobody
 * filled in - rendered as a GREEN TICK, and so did the spelling 'n/a'. A tick asserts that something was
 * verified; an unrecognised phrase is not evidence of verification, so the unknown case falls to absent,
 * which is the only honest default. `ok` has to be earned by text saying the validation actually ran.
 */
function runtimeMark(raw) {
  if (!present(raw)) return MARKS.ABSENT;
  const text = String(raw).trim().toUpperCase().replace(/\s+/g, ' ');
  if (text === 'NOT RECORDED' || text === 'NOT_RECORDED') return MARKS.ABSENT;
  if (/NOT APPLICABLE|^N\/?A\b|^N\.A\.|^NA$|^NONE\b|NO RUNTIME|STATIC ONLY/.test(text)) return MARKS.NA;
  if (/\bNO\b|= *NO\b|\bNOT\b|UNAVAILABLE|SKIPPED/.test(text)) return MARKS.BAD;
  if (/\bPASS(?:ED)?\b|\bOK\b|VERIFIED|COMPILED|SUCCEEDED|CHECKS? PASSED/.test(text)) return MARKS.OK;
  return MARKS.ABSENT;
}

/**
 * Classify the source acknowledgement.
 *
 * The element exists to show that the worker echoed the exact source revision it was given. The old rule
 * was `present(source_hash_ack) ? ok : absent`, which turned three different situations into the same
 * green tick:
 *
 *   NO_SOURCE_BOUND  no source was bound, so there was nothing to acknowledge - the tick claimed a
 *                    verification that could not have happened
 *   UNREADABLE       the worker said it could not read the source - a tick rendered beside a value that
 *                    says the opposite
 *   any other text   an unrecognised phrase, which is not evidence of an acknowledgement
 *
 * This is the third instance of the same defect class in this file (see `runtimeMark` and the correlation
 * element), and the rule that fixes all three is the same: a tick must be EARNED by a value that says the
 * thing happened. Unknown falls to `absent`, which is the only honest default; inapplicable falls to n/a;
 * and a negative statement falls to `bad`.
 */
function sourceAckMark(raw, legacy) {
  if (!present(raw)) return legacy ? MARKS.NA : MARKS.ABSENT;
  const text = String(raw).trim();
  if (/^NO_SOURCE_BOUND$/i.test(text)) return MARKS.NA;
  if (/UNREADABLE|UNAVAILABLE|UNKNOWN|NOT AVAILABLE|FAILED|ERROR/i.test(text)) return MARKS.BAD;
  if (/^[0-9a-f]{8,}$/i.test(text)) return MARKS.OK;
  return MARKS.ABSENT;
}

function sourceAckText(raw, legacy) {
  if (!present(raw)) {
    return legacy ? 'not applicable: this run predates the protocol' : 'the worker never acknowledged the source';
  }
  const text = String(raw).trim();
  const mark = sourceAckMark(raw, legacy);
  if (mark === MARKS.NA) return 'no source was bound to this run, so there was nothing to acknowledge';
  if (mark === MARKS.OK) return `acknowledged ${text.slice(0, 20)}`;
  return text.slice(0, 20);
}

/**
 * Build the card.
 *
 * @returns {{record_id, status, status_class, origin, legend, headline, elements, warnings, notes}}
 */
function buildCard(rec) {
  if (!rec) return null;
  const legacy = rec.record_origin === 'LEGACY_RUN';
  const correlationOk = rec.correlation_disposition === 'CORRELATED';
  const ind = rec.independence ?? {};

  const elements = [
    // ---- Source Identity ----
    element('source_hash',
      'Source Hash',
      Array.isArray(rec.source_hashes) && rec.source_hashes.some((f) => f && f.sha256) ? MARKS.OK : MARKS.ABSENT,
      Array.isArray(rec.source_hashes) && rec.source_hashes.length
        ? `${rec.source_hashes.length} file(s)` + (rec.source_set_hash ? ` · set ${String(rec.source_set_hash).slice(0, 12)}` : '')
        : 'no source bound to this run'),

    // ---- Worker Identity ----
    element('worker_identity',
      'Worker Identity',
      present(rec.worker_seat) ? MARKS.OK : MARKS.ABSENT,
      present(rec.worker_seat)
        ? `${rec.worker_seat}${rec.seat_providers?.worker ? ` (${rec.seat_providers.worker})` : ''}`
        : 'the seat that produced the proposal is not recorded'),

    // ---- Run Correlation ----
    // Three distinct outcomes, and conflating them would be a lie in one direction or the other:
    //   CORRELATED        ack present and matching            -> ok
    //   legacy            the protocol did not exist          -> n/a (not applicable, not a failure)
    //   absent            no correlation was EVER attempted    -> dash. "Not attempted" is missing
    //                                                            evidence, not a recorded defect, so
    //                                                            it must not borrow the red cross that
    //                                                            means "we checked and it is wrong".
    //   attempted+failed  ack present but wrong/missing ack    -> bad
    element('run_correlation',
      'Run Correlation',
      correlationOk ? MARKS.OK
        : legacy ? MARKS.NA
          : (present(rec.correlation_disposition) ? MARKS.BAD : MARKS.ABSENT),
      correlationOk
        ? `ack ${String(rec.run_id_ack).slice(-14)}`
        : legacy
          ? 'not applicable: this run predates the protocol'
          : present(rec.correlation_disposition)
            ? `NOT CORRELATED (${rec.correlation_disposition})`
            : 'not recorded'),

    // ---- Source ACK ----
    // The classification, and the defect it fixes, live in `sourceAckMark` above. It is a function rather
    // than an inline ternary for the same reason `runtimeMark` is: the inline version defaulted to a tick.
    element('source_ack',
      'Source ACK',
      sourceAckMark(rec.source_hash_ack, legacy),
      sourceAckText(rec.source_hash_ack, legacy)),

    // ---- Independent Review ----
    //
    // A DISABLED reviewer must not read as a missing one. Those are different facts: `DISABLED_BY_POLICY`
    // is a configured choice the operator made, while "no review recorded" is an absence of evidence.
    // Rendering the first as the second would push operators to switch the reviewer on merely to clear a
    // dash - the opposite of an optional reviewer.
    element('independent_review',
      'Independent Review',
      ind.satisfied === true ? MARKS.OK
        : ind.satisfied === false ? MARKS.BAD
          : (rec.independent_review_status === 'DISABLED_BY_POLICY' ? MARKS.NA
            : (rec.independent_review_status === 'UNAVAILABLE' ? MARKS.BAD : MARKS.ABSENT)),
      ind.satisfied === true
        ? `${rec.reviewer_seat} (${ind.worker_provider} vs ${ind.reviewer_provider})`
        : rec.independent_review_status === 'DISABLED_BY_POLICY'
          ? `DISABLED_BY_POLICY - codex_review_mode=${rec.codex_review_mode ?? 'OFF'}; review_by=supervisor`
          : ind.satisfied === false
            ? (ind.detail ?? 'independence not satisfied')
            : (rec.independent_review_status ?? 'no review recorded')),

    // ---- Approval ----
    element('approval',
      'Approval',
      rec.approval === 'APPROVED' ? MARKS.OK : (rec.approval === 'REJECTED' ? MARKS.BAD : MARKS.ABSENT),
      rec.approval ?? 'not recorded'),

    // ---- Write Scope / Diff ----
    element('write_scope',
      'Write Scope',
      Array.isArray(rec.write_scope) && rec.write_scope.length ? MARKS.OK : MARKS.NA,
      Array.isArray(rec.write_scope) && rec.write_scope.length ? rec.write_scope.join(', ') : 'read-only task'),

    /**
     * Files Changed.
     *
     * ZERO IS ONLY GOOD NEWS ON A READ-ONLY TASK. Otherwise zero changes against a writable scope
     * means the work did not happen - and rendering that with a tick would be the card congratulating
     * a run for doing nothing. The task's own writability decides which of those two it is, so it is
     * read from write_scope rather than assumed.
     */
    element('files_changed',
      'Files Changed',
      !Array.isArray(rec.changed_files) ? MARKS.ABSENT
        : (rec.changed_files.length > 0 ? MARKS.OK
          : (Array.isArray(rec.write_scope) && rec.write_scope.length ? MARKS.BAD : MARKS.OK)),
      Array.isArray(rec.changed_files)
        ? (rec.changed_files.length > 0
          ? String(rec.changed_files.length)
          : (Array.isArray(rec.write_scope) && rec.write_scope.length
            ? '0 - a writable task that changed nothing'
            : '0 (read-only task, as required)'))
        : 'not recorded'),

    element('diff_scope',
      'Diff Scope',
      rec.diff_scope_ok === true ? MARKS.OK : (rec.diff_scope_ok === false ? MARKS.BAD : MARKS.ABSENT),
      rec.diff_scope_ok === true ? 'every change is inside the permitted scope'
        : rec.diff_scope_ok === false ? 'CHANGES OUTSIDE THE PERMITTED SCOPE' : 'not checked'),

    // ---- Validation ----
    element('static_validation',
      'Static Validation',
      Array.isArray(rec.validation_results) && rec.validation_results.length
        ? (rec.validation_results.every((v) => v && v.ok !== false) ? MARKS.OK : MARKS.BAD)
        : MARKS.ABSENT,
      Array.isArray(rec.validation_results) && rec.validation_results.length
        ? rec.validation_results.map((v) => v.name ?? 'check').join(', ')
        : 'not recorded'),

    // Runtime validation is a NEGATIVE capability in this stack: there is no compiler or runtime
    // here, so "RUNTIME VERIFIED = NO" is a recorded statement that runtime verification DID NOT
    // HAPPEN. The classification, and the defect it fixes, live in `runtimeMark` above - it is a
    // function rather than an inline ternary because the inline version defaulted to a tick.
    element('runtime_validation',
      'Runtime Validation',
      runtimeMark(rec.runtime_validation),
      present(rec.runtime_validation) ? String(rec.runtime_validation) : 'not recorded'),

    // ---- Commit ----
    element('commit',
      'Git Commit',
      present(rec.commit) ? MARKS.OK : MARKS.ABSENT,
      present(rec.commit) ? String(rec.commit) : 'not recorded'),
  ];

  /** Warnings a reader must not miss. Collected rather than scattered through the elements. */
  const warnings = [];
  if (legacy) {
    warnings.push({
      level: 'info',
      text: 'LEGACY_RUN: this task completed before the Verified Task Protocol existed. '
        + 'Run correlation is not applicable, and it is shown as not recorded rather than reconstructed.',
    });
  }
  if (ind.required === true && ind.satisfied === false) {
    warnings.push({ level: 'warn', text: ind.detail ?? 'INDEPENDENCE NOT SATISFIED' });
  }
  if (rec.correlation_disposition && rec.correlation_disposition !== 'CORRELATED' && !legacy) {
    warnings.push({ level: 'error', text: `The reply was not correlated to this run (${rec.correlation_disposition}). It was never passed to review.` });
  }
  if (rec.diff_scope_ok === false) {
    warnings.push({ level: 'error', text: 'Files changed outside the permitted write scope.' });
  }
  if ((rec.missing_evidence ?? []).length) {
    warnings.push({ level: 'warn', text: `Not recorded: ${rec.missing_evidence.join(', ')}` });
  }

  const headlines = {
    VERIFIED: 'Every load-bearing element is recorded and checks out.',
    PARTIAL: 'Some evidence is present, but at least one load-bearing element is missing or unsatisfied.',
    UNVERIFIED: 'The result cannot be attributed or stayed inside its permissions, so it is not verified.',
    BLOCKED: 'The run was stopped: either the source changed under it, or approval was refused.',
  };

  return {
    record_id: rec.record_id ?? null,
    task_id: rec.task_id ?? null,
    run_id: rec.run_id ?? null,
    status: rec.final_status ?? EVIDENCE_STATUS.UNVERIFIED,
    status_class: STATUS_CLASS[rec.final_status] ?? 'unverified',
    origin: rec.record_origin ?? 'PROTOCOL_RUN',
    legacy,
    headline: headlines[rec.final_status] ?? null,
    elements,
    warnings,
    missing_evidence: rec.missing_evidence ?? [],
    legend: [
      { mark: MARKS.OK, symbol: SYMBOL.ok, meaning: 'recorded, and it checks out' },
      { mark: MARKS.BAD, symbol: SYMBOL.bad, meaning: 'recorded, and it is a problem' },
      { mark: MARKS.ABSENT, symbol: SYMBOL.absent, meaning: 'NOT RECORDED - shown as a dash, never as a tick' },
      { mark: MARKS.NA, symbol: SYMBOL['n/a'], meaning: 'does not apply to this run' },
    ],
    started_at: rec.started_at ?? null,
    completed_at: rec.completed_at ?? null,
    seat_providers: rec.seat_providers ?? null,
    notes: rec.notes ?? [],
  };
}

module.exports = { buildCard, MARKS, SYMBOL, STATUS_CLASS };
