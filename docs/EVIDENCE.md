# Evidence Records: do not trust Done. Verify it.

**Do not trust Done. Verify it.**

A status word is a claim. An Evidence Record is a claim you can check field by field, and it is
written so that a reader can tell three different things apart:

- something was **verified**;
- something was **not recorded**;
- something **does not apply** to this run.

The code that builds, derives, stores and renders records lives in
`workbench/protocol/evidence.js` and `workbench/protocol/evidence-card.js`. The policy values it
reports (`review_level`, `independent_review_status`, `codex_review_mode`) come from
`workbench/protocol/policy.js`.

## Contents

1. Why a receipt, not a log
2. What a record contains
3. The marks, and why they are not interchangeable
4. NOT RECORDED is not PASS
5. DISABLED_BY_POLICY is not missing evidence
6. Static versus runtime verification
7. Review level
8. The two views
9. A worked example

---

## 1. Why a receipt, not a log

A log says what a program did. Its reader has to trust the program's own account of itself, in prose,
after the fact. It cannot be checked, only believed.

An Evidence Record is a receipt. Every field is either a recorded fact -- a hash, an acknowledgement,
a verdict, a timestamp, a diff-scope check -- or an explicit statement that the fact was not captured.
The rule that shapes `workbench/protocol/evidence.js` is stated at the top of the file: absent data
stays `null` or the literal string `'NOT RECORDED'` (the exported constant `NOT_RECORDED`), and
`final_status` is derived from what is actually present by `deriveStatus(rec)`. A record with a gap
cannot be `VERIFIED`, no matter how good the change was.

That is the whole design intent: do not let a field be filled in with a plausible default. A missing
acknowledgement is evidence of a missing acknowledgement, which is a finding, and the finding must
survive into the record instead of being smoothed over.

## 2. What a record contains

`buildRecord(spec = {})` copies explicit facts out of `spec` and nothing else. Where a caller does not
know a value it must pass `null`, and the record stores `null` rather than inventing a value. The
stored JSON is the record; the field names below are the real JSON keys.

| Field | What it holds | Load-bearing? |
|---|---|---|
| `record_version` | Fixed at `'0.2.0'` by `buildRecord` | No (provenance) |
| `protocol_version` | From `spec.protocolVersion` | No (provenance) |
| `goal_id` | The goal the task belongs to | No |
| `task_id` | The task | Identity |
| `run_id` | The run that produced the work | Yes (`listMissing` names it) |
| `supervisor_seat` | Seat that planned and reviewed | No |
| `worker_seat` | Seat that produced the proposal | Yes (`listMissing` names it) |
| `reviewer_seat` | Seat that reviewed the result | Yes when independence was required |
| `seat_providers` | `{ supervisor, worker, reviewer }` provider ids behind those seats | No (but it is how a same-provider review is visible) |
| `source_hashes` | `[{ path, sha256, bytes, present_at_dispatch }]` captured at dispatch | Yes, for a writable task |
| `source_set_hash` | One hash over the source set | No |
| `run_id_ack` | The run id the worker echoed back | Yes (`deriveStatus`, `listMissing`) |
| `source_hash_ack` | The source hash the worker echoed back | Yes, for a writable task |
| `correlation` | Free-form correlation value | No |
| `correlation_disposition` | The correlation verdict, e.g. `CORRELATED` | Yes -- a non-`CORRELATED` value forces `UNVERIFIED` |
| `proposal` | The worker's full reply text | Yes (`deriveStatus`, `listMissing`) |
| `review_result` | The supervisor's review object (verdict, criteria, concerns, summary) | Yes (`listMissing` names it) |
| `approval` | `APPROVED`, `REJECTED`, or `null` | Yes (`REJECTED` forces `BLOCKED`; `null` is listed as missing) |
| `changed_files` | Files the run changed | No (but it drives the `Files Changed` mark) |
| `diff_summary` | Prose summary of the diff | No |
| `write_scope` | The permitted write paths; empty means read-only | Yes -- it decides which standard applies |
| `diff_scope_ok` | Whether every change stayed inside `write_scope` | Yes (`false` forces `UNVERIFIED`) |
| `validation_results` | `[{ name, ok, detail }]` -- the checks that actually ran | Yes, always |
| `runtime_validation` | Free-text statement about runtime verification | No (never required for `VERIFIED`, but it is the field most likely to be mis-read) |
| `independence` | `{ required, satisfied, detail, worker_provider, reviewer_provider }` | Yes -- if `required` is `true`, `satisfied` must be `true` |
| `review_level` | `SUPERVISOR_REVIEW` or `INDEPENDENT_PROVIDER_REVIEW` | Yes (it states what the result rests on) |
| `independent_review_status` | `DISABLED_BY_POLICY`, `REQUESTED`, `NOT_REQUESTED`, `UNAVAILABLE`, `SATISFIED`, `NOT_SATISFIED` | Yes (it tells a configured choice from a gap) |
| `independent_review_detail` | Why that status was reached | No |
| `codex_review_mode` | `OFF`, `AUTO` or `REQUIRED` | No (but it explains the status above) |
| `commit` | The commit created | Yes, for a writable task |
| `started_at`, `completed_at` | ISO timestamps | No |
| `record_origin` | `PROTOCOL_RUN` (default) or `LEGACY_RUN` | Yes -- it decides whether protocol-grade correlation may be claimed |
| `legacy_reason` | Why a reconstructed record cannot claim correlation | No |
| `notes` | Free-form strings (default `[]`) | No |
| `final_status` | Derived by `deriveStatus` unless the caller supplies `finalStatus` | Yes -- the headline |
| `missing_evidence` | Derived by `listMissing` | Yes -- the named gaps |
| `record_id` | Assigned by the caller, and used as the file name of the JSON/Markdown pair | Identity |

### `final_status` is derived, in this order

`EVIDENCE_STATUS` in `workbench/protocol/protocol.js` allows exactly four values: `VERIFIED`,
`PARTIAL`, `UNVERIFIED`, `BLOCKED`. `deriveStatus` walks this ladder and returns the first match:

| Order | Condition | Result |
|---|---|---|
| 1 | `correlation_disposition` is set and is not `CORRELATED` | `UNVERIFIED` |
| 2 | `diff_scope_ok === false` | `UNVERIFIED` |
| 3 | `approval === 'REJECTED'` | `BLOCKED` |
| 4 | No non-empty `proposal` | `UNVERIFIED` |
| 5 | `run_id_ack` absent, or `correlation_disposition` is not `CORRELATED` | `PARTIAL` |
| 6 | Writable task with no `source_hashes` entry carrying a `sha256` | `PARTIAL` |
| 7 | Writable task with empty `validation_results` | `PARTIAL` |
| 8 | Read-only task with empty `validation_results` | `PARTIAL` |
| 9 | `independence.required === true` and `independence.satisfied !== true` | `PARTIAL` |
| 10 | `independence.required === true` and `reviewer_seat === null` | `PARTIAL` |
| 11 | Otherwise | `VERIFIED` |

A task is treated as writable when `write_scope` is an array with at least one entry. A read-only task
is deliberately not asked for source hashes or a commit: it has nothing to hash at dispatch and
nothing to commit at the end, so demanding them would make the honest answer look like a gap. The
`UNVERIFIED` result is not softened to `PARTIAL`: a change that cannot be attributed is not partially
verified, it is unverified.

`buildCard` maps each status to a headline (`buildCard` field `headline`):

| `final_status` | Headline |
|---|---|
| `VERIFIED` | `Every load-bearing element is recorded and checks out.` |
| `PARTIAL` | `Some evidence is present, but at least one load-bearing element is missing or unsatisfied.` |
| `UNVERIFIED` | `The result cannot be attributed or stayed inside its permissions, so it is not verified.` |
| `BLOCKED` | `The run was stopped: either the source changed under it, or approval was refused.` |

### `missing_evidence` is a named list, not a mood

`listMissing(rec)` returns the exact field names that are absent, and never more than these:

- `run_id`, `run_id_ack`;
- for a writable task only: `source_hashes`, `source_hash_ack`, `commit`;
- `worker_seat`, `proposal`, `review_result`, `approval`, `validation_results`.

The list is deliberately narrow. Inflating it (asking a read-only task for a commit, or listing a
reviewer nobody switched on) would train the reader to ignore it, and a list nobody reads is worse
than no list. What is missing must mean something.

## 3. The marks, and why they are not interchangeable

`workbench/protocol/evidence-card.js` is a projection, not a layout, and its whole reason for existing
is one rule, quoted from the file: a card that shows a green tick for something nobody recorded is
worse than no card, because the reader will act on it.

Every element of a card resolves to exactly one of four marks. `MARKS` holds the names, `SYMBOL` holds
the glyphs, and the four are not interchangeable:

| `MARKS` value | Meaning (from the card legend) | Glyph | ASCII-safe here |
|---|---|---|---|
| `ok` | recorded, and it checks out | check mark (U+2713) | `v` |
| `bad` | recorded, and it is a problem | ballot X (U+2717) | `x` |
| `absent` | NOT RECORDED - shown as a dash, never as a tick | dash (U+2013) | `-` |
| `n/a` | does not apply to this run | middle dot (U+00B7) | `.` |

Only `ok` is a tick. A dash is not a soft tick, and it is not a failure either: it is the statement
that the field was never filled in. The UI (`workbench/public/protocol-ui.js`) titles the `absent` mark
with the literal text `NOT RECORDED` and renders the legend row verbatim.

The interface refuses to treat an empty field as a value. `present(v)` returns `false` for `null`,
`undefined`, the empty string, and both spellings of the sentinel, `'NOT RECORDED'` and
`'NOT_RECORDED'`. Every element that can be absent goes through either `present` or an explicit `===`
test, so there is no path where a blank field drifts into `ok`.

### The three real defects this rule was fixed to handle

**An unrecognised runtime-validation phrase must not become a tick.** The classification lives in
`runtimeMark(raw)`, and it is a function rather than an inline ternary precisely because the inline
version defaulted to a tick. The old rule granted `ok` to any string that two negative patterns did
not match, so an unknown phrase rendered as a green tick -- a tick that asserts something was verified
when nothing was. Today `runtimeMark` returns `ok` only for text that says the validation actually
ran:

- `/\bPASS(?:ED)?\b|\bOK\b|VERIFIED|COMPILED|SUCCEEDED|CHECKS? PASSED/` -> `ok`
- `/\bNO\b|= *NO\b|\bNOT\b|UNAVAILABLE|SKIPPED/` -> `bad` (recorded, and it is a gap)
- `NOT APPLICABLE`, `N/A`, `N.A.`, `NA`, `NONE`, `NO RUNTIME`, `STATIC ONLY` -> `n/a`
- anything unrecognised, including `pending`, -> `absent`

`workbench/verify/v03-codex-optional.test.js` asserts the table directly, including the row
`['pending', CARD.MARKS.ABSENT, 'an unrecognised phrase, which must NOT become a tick']`, and
`workbench/verify/protocol.test.js` asserts that `RUNTIME VERIFIED = NO` renders as `bad`, not a tick.

**The protocol's own NOT RECORDED sentinel must not become a tick either.** `'NOT RECORDED'` is the
value this protocol itself writes for a field nobody filled in, and `'n/a'` is a legal spelling of not
applicable. Both were previously treated as "a string the negative patterns did not match", so both
rendered as ticks -- the card praising a field for being empty. `runtimeMark` now returns `absent` for
`'NOT RECORDED'` and `'NOT_RECORDED'` before any pattern matching, and `present()` filters both
spellings before that. The suite states the doctrine as a test: a never-recorded runtime validation can
never render a tick.

**The source acknowledgement must be earned too, not merely present.** The third instance of the same
class, found by reading the card against real records rather than by testing it. The rule used to be
`present(source_hash_ack) ? ok : absent`, which collapsed three different situations into one green tick:

- `NO_SOURCE_BOUND` -- no source was bound to the run, so there was nothing that could have been
  acknowledged, and the tick claimed a verification that never happened. 49 records in the corpus read
  this way. It is now `n/a`.
- `UNREADABLE` -- the worker stated it could not read the source, and a tick sat beside a value saying the
  opposite. Two records in the corpus did exactly that. It is now `bad`.
- any unrecognised text -- not evidence of an acknowledgement. It is now `absent`.

`sourceAckMark(raw, legacy)` is the classification, in the same shape as `runtimeMark`, and
`workbench/verify/v03-codex-optional.test.js` asserts every row of it, including that a genuine echoed
digest still renders `ok`, so the fix is a correction rather than a downgrade. The lesson generalises:
this card has now produced the same bug three times, in `runtimeMark`, in the correlation element and in
the source acknowledgement, and each time the cause was a default of "not obviously bad, therefore good".
A mark that is not earned by a positive statement has to fall to `absent`.

One related distinction the code makes explicit, because it points the other way: zero changed files is
only good news on a read-only task. `Files Changed` reads `write_scope` to decide which case it is --
`0` against a writable scope is `bad` (`0 - a writable task that changed nothing`), while `0` on a
read-only task is `ok` (`0 (read-only task, as required)`), because an empty `changed_files` array is a
recorded fact, not a missing one. A non-array `changed_files` is `absent`.

## 4. NOT RECORDED is not PASS

The distinction has one consequence, and it is the only one that matters: a reader who sees a tick for
an unrecorded field will act on it. They will merge the change, accept the report, or close the task,
on the strength of a mark that meant nothing.

Concretely, for `Runtime Validation` a tick means "runtime verification happened". In this stack no
compiler or runtime for a target project is available, so a tick on that element would be an outright
false claim about work that never ran. That is why the unknown case falls to `absent`: the absence of a
recognisable statement is not evidence of verification, and `ok` has to be earned by text saying the
validation ran.

The same rule drives the record's own bookkeeping. `missing_evidence` names the gaps so that a card
never has to choose between a silent tick and a vague bad feeling, and `buildCard` collects warnings a
reader must not miss, including `Not recorded: <field list>` whenever `missing_evidence` is non-empty.
A `VERIFIED` record is required to have an empty `missing_evidence` list; the test suite asserts
exactly that pairing.

## 5. DISABLED_BY_POLICY is not missing evidence

Switching the independent reviewer off is a configuration choice, not a hole in the evidence.
`workbench/protocol/policy.js` makes the reviewer a switch whose default is `OFF`, and `OFF` must never
block a goal: the supervisor reviews its own work and the record says so plainly.

`wantsIndependentReview(mode, task, context)` returns a status from `INDEPENDENT_REVIEW`:

- mode `OFF` -> `DISABLED_BY_POLICY`, `wanted: false`;
- mode `REQUIRED` -> `REQUESTED`, `wanted: true`;
- mode `AUTO` -> `REQUESTED` when a signal is present, otherwise `NOT_REQUESTED`.

The `AUTO` signals are a coding task (`task.type === 'coding'`), an architecture-level change (a match
for `/architect|design|migration|refactor/i` in the title or description), a high-risk write (a
non-empty write scope plus `context.highRisk === true`), a disputed supervisor verdict
(`context.disputed === true`), and repeated retries (`context.retries >= 2`).

The record carries the outcome twice, on purpose:

- `independent_review_status` states why the reviewer was or was not used
  (`DISABLED_BY_POLICY`, `REQUESTED`, `NOT_REQUESTED`, `UNAVAILABLE`, `SATISFIED`, `NOT_SATISFIED`);
- `review_level` states what the result actually rests on.

So a Codex-off task can be honestly complete at `review_level = SUPERVISOR_REVIEW` with
`independent_review_status = DISABLED_BY_POLICY`, and a reader can tell that apart from a task that was
independently reviewed (`review_level = INDEPENDENT_PROVIDER_REVIEW`, `independent_review_status =
SATISFIED`), without either result being dressed up as the other.

On the card, the `Independent Review` element renders `DISABLED_BY_POLICY` as the not-applicable mark
with the value `DISABLED_BY_POLICY - codex_review_mode=OFF; review_by=supervisor`. `UNAVAILABLE`
renders as `bad`, because a reviewer that was asked for and could not be obtained is a real problem.
Nothing recorded at all renders as `absent` with the value `no review recorded`.

A disabled reviewer is never listed as missing evidence, and that is structural rather than a special
case: `listMissing(rec)` names only `run_id`, `run_id_ack`, the writable-task fields, `worker_seat`,
`proposal`, `review_result`, `approval` and `validation_results`. Independence never appears in that
list. "No second reviewer" cannot be reported as a gap, because the gap did not happen.

A genuinely unrecorded human approval is a different fact and may legitimately be listed. When
`approval` is `null`, `listMissing` names it and `buildCard` renders `Approval` as `absent` with the
value `not recorded`. That is deliberate: a configured choice is not an absence of evidence, whereas an
unfilled field is exactly that. The two must not be collapsed in either direction. Collapsing them the
other way -- rendering `DISABLED_BY_POLICY` as a dash-with-a-shrug -- would push operators to switch
the reviewer on merely to clear a mark, which is the opposite of an optional reviewer.

## 6. Static versus runtime verification

This system has no compiler and no runtime for a target project. It therefore separates two claims it
could otherwise blur into one:

- **STATIC verification**: checks that can be performed on text and structure without executing the
  target -- parsing, syntax review, scope checks, hash comparison. These land in `validation_results`
  as `{ name, ok, detail }` records of checks that actually ran, and `deriveStatus` requires at least
  one for any run to reach `VERIFIED`.
- **RUNTIME verification**: executing the target and observing it. This is a **negative capability**
  here: the honest position is that the system cannot do it, so it must never claim it.

A negative capability means the absence of a result is a fact about the tool, not about the code. Two
consequences follow. First, `runtime_validation` is free text and is never required for `VERIFIED`.
Second, the card classifies it strictly: a statement of non-performance (`bad`), a statement that it
does not apply (`n/a`), a statement that it really ran (`ok`), and nothing else (`absent`). "We could
not run it" is recorded as a gap the reader can see; "it does not apply to this task" is recorded as
not applicable; and a phrase the classifier does not recognise is recorded as not recorded, never as
success.

## 7. Review level

`REVIEW_LEVEL` has exactly two values: `SUPERVISOR_REVIEW` and `INDEPENDENT_PROVIDER_REVIEW`. The
rule is enforced in one function, `reviewLevelFor(independentStatus)`, and it is one line of policy:

- `INDEPENDENT_REVIEW.SATISFIED` -> `INDEPENDENT_PROVIDER_REVIEW`;
- everything else (`DISABLED_BY_POLICY`, `REQUESTED`, `NOT_REQUESTED`, `UNAVAILABLE`,
  `NOT_SATISFIED`) -> `SUPERVISOR_REVIEW`.

Independent review is only claimed when it really happened. A requested-but-unsatisfied or unavailable
reviewer falls back to `SUPERVISOR_REVIEW`, which is an honest description rather than a downgrade
worth hiding.

Two further guarantees keep the label from being borrowed:

- Independence itself is judged by `protocol.checkIndependence`, not by a seat name. The suite asserts
  that a supervisor sharing the worker's provider is **not** independent -- a second seat from the same
  provider is not an independent review, and without that check a supervisor reviewing itself could
  silently become `INDEPENDENT_PROVIDER_REVIEW`.
- A record whose review came from the supervisor also records `reviewer_seat` as the supervisor seat
  and `seat_providers.reviewer` as the supervisor's provider, so the fact is visible in the identity
  fields as well as in the level.

`codex_review_mode` is reported alongside, as `OFF`, `AUTO` or `REQUIRED`. The `ON` spelling emitted by
the UI toggle is mapped to `AUTO` by `normalizeCodexMode`, because `ON` is a request to use the
reviewer rather than a mode; an unrecognised value falls back to `OFF` so a typo cannot spend quota, and
that fallback is itself visible in the record as `codex_review_mode=OFF`.

## 8. The two views

The JSON record is the source of truth. The Markdown file and the UI card are generated views of it,
and nothing that must be trusted is ever re-derived from prose.

- `saveRecord(recordId, rec)` writes the JSON first, atomically: a temporary file
  (`<target>.tmp-<pid>`), then a rename. `recordPath` sanitises the record id (`[^a-zA-Z0-9._-]`
  becomes `_`) and stores records under the evidence directory reported by `recordsDir()`.
- `loadRecord(recordId)` returns `null` for a missing file, and `null` for a file that does not parse.
  A corrupt record has no view, and no view pretends otherwise.
- `toMarkdown(rec)` renders the table a human reads: `Goal`, `Run`, `Supervisor seat`, `Worker seat`,
  `Reviewer seat`, `Run ACK`, `Source hash ACK`, `Correlation`, `Independent review`, `Review level`,
  `Independent review status`, `Codex review mode`, `Approval`, `Diff scope`, `Commit`,
  `Runtime validation`; then `## Missing evidence` when the list is non-empty, then
  `## Why this is a legacy record` for a `LEGACY_RUN`. Its footer states what it is: the JSON beside it
  is the source of truth, and this view is generated. Its `tick` helper prints `OK`, `NO` or
  `NOT RECORDED` -- it has no way to print a bare blank.
- `buildCard(rec)` is the projection the server hands to the browser: `{ record_id, task_id, run_id,
  status, status_class, origin, legacy, headline, elements, warnings, missing_evidence, legend,
  started_at, completed_at, seat_providers, notes }`. It returns `null` for a falsy record. Keeping this
  projection server-side is what makes the honesty rules testable in Node rather than in a browser.

The two views are not identical. The Markdown table carries rows the card does not: `Goal`, `Run`,
`Supervisor seat`, `Worker seat`, `Reviewer seat`, `Run ACK`, `Review level`, `Independent review
status` and `Codex review mode`. The card carries elements the Markdown table does not: `Source Hash`,
`Worker Identity`, `Source ACK`, `Write Scope`, `Files Changed` and `Static Validation`. Some fields
appear in both under different labels -- `Run Correlation` in the card is `Correlation` in the
Markdown, and `Git Commit` is `Commit`. They answer different questions about the same JSON, and either
one is regenerable.

### When a renderer changes, the views must be regenerated

The Markdown view is a pure function of the record, so the moment the renderer changes, every `.md`
file already on disk is stale by definition. This is not hypothetical. When V0.3 added `review_level`,
`independent_review_status` and `codex_review_mode` to the record, every existing view still omitted
them, so the Markdown quietly **understated** what the JSON knew -- a reader opening the `.md` instead
of the `.json` saw a record with less evidence in it than the record actually had.

`workbench/scripts/regenerate-evidence-views.js` exists for exactly that, and it is safe because it is
one-way: it reads each JSON, writes `toMarkdown(rec)` beside it, and never edits a record. It supports
`--dry`, and it reports which rows a view was missing
(`review_level`, `independent_review_status`, `codex_review_mode`) so the drift is visible rather than
merely repaired.

The rule for a reader is therefore: trust the JSON, and treat a stale view as an understatement of the
record rather than as the record. A view that omits a field cannot be evidence that the field was never
recorded.

## 9. A worked example

A read-only task that went well: the shipped record `EV-demo-T-E2E-41932a6b` in `workbench/evidence/`.
Its JSON carries `write_scope: []`, `changed_files: []`, `diff_scope_ok: true`,
`correlation_disposition: "CORRELATED"`, `independence: { required: true, satisfied: true }`,
`record_origin: "PROTOCOL_RUN"`, `final_status: "VERIFIED"` and `missing_evidence: []`.

Rendered by `buildCard`, with the marks written ASCII-safe (`v` = `ok`, `x` = `bad`, `-` = `absent`,
`.` = `n/a`):

| Mark | Element | Value |
|---|---|---|
| `v` | `Source Hash` | `1 file(s)` plus set prefix `4da65b242a68` |
| `v` | `Worker Identity` | `seat:t/coder (stub-provider)` |
| `v` | `Run Correlation` | `ack` plus the run-id suffix `t-e2e-41932a6b` |
| `v` | `Source ACK` | `4da65b242a68ed371d1d` |
| `v` | `Independent Review` | `seat:t/reviewer (stub-provider vs human)` |
| `v` | `Approval` | `APPROVED` |
| `.` | `Write Scope` | `read-only task` |
| `v` | `Files Changed` | `0 (read-only task, as required)` |
| `v` | `Diff Scope` | `every change is inside the permitted scope` |
| `v` | `Static Validation` | `the reply parses` |
| `.` | `Runtime Validation` | `not applicable - read-only task` |
| `-` | `Git Commit` | `not recorded` |

Status: `VERIFIED`. Headline: `Every load-bearing element is recorded and checks out.` No warnings.
An important presentation detail: the `Source Hash` value is built by the projection as the file count
and the set prefix joined by a bullet character, which this document renders as `plus`.

### How to read it, line by line

- `Source Hash` `v` -- a real source file was bound at dispatch and its `sha256` was captured. The value
  tells the reader how many files were bound and shows the first 12 characters of `source_set_hash`.
- `Worker Identity` `v` -- the seat that produced the proposal is recorded, and the provider behind it
  is named in parentheses. An unrecorded seat here would be `-`, not `v`.
- `Run Correlation` `v` -- the worker echoed this run's id and the disposition is `CORRELATED`. The
  value shows the tail of the ack. If correlation had been attempted and failed, this would be `x`; if
  it had never been attempted, `-`; on a pre-protocol run, `.`.
- `Source ACK` `v` -- the reply carried a source-hash acknowledgement. The mark asserts that the ack
  was **recorded**, and the value is the first 20 characters of what was echoed. It is not by itself a
  statement that the echoed hash still matches the file on disk; that is what the dispatch-time
  re-check and `diff_scope_ok` are for.
- `Independent Review` `v` -- the review was actually independent: a different seat on a different
  provider (`stub-provider` vs `human`), with `independence.satisfied === true`. This is the only
  element that can justify the `INDEPENDENT_PROVIDER_REVIEW` level, and here `review_level` is `null`
  in the JSON -- a record written before that field existed -- so the Markdown view honestly prints
  `NOT RECORDED` for it rather than assuming a level.
- `Approval` `v` -- `APPROVED` was recorded, by a human in this run.
- `Write Scope` `.` -- the not-applicable mark, not a dash. An empty `write_scope` is a positive
  statement that this task was read-only, so there is nothing to permit and nothing to violate.
- `Files Changed` `v` with the value `0 (read-only task, as required)` -- zero changes is the required
  outcome here, and the value says so. On a writable task the same zero would be `x`
  (`0 - a writable task that changed nothing`).
- `Diff Scope` `v` -- every change stayed inside the permitted scope. `x` here
  (`CHANGES OUTSIDE THE PERMITTED SCOPE`) would also have forced `final_status` to `UNVERIFIED`.
- `Static Validation` `v` -- at least one check ran and none recorded `ok: false`. The value names the
  checks (`the reply parses`). With no checks recorded at all this element would be `-`, and the record
  could not have reached `VERIFIED`.
- `Runtime Validation` `.` -- not applicable to this task, correctly, and the mark is not a tick. The
  system has no runtime for the target project, so `n/a` and `bad` are the only honest outcomes when
  nothing ran.
- `Git Commit` `-` -- the dash means NOT RECORDED. This is a read-only task with nothing to commit, so
  `commit` is not demanded by `listMissing`, and the record is still `VERIFIED` with an empty
  `missing_evidence` list. That is the distinction this whole document is about: the dash says "nobody
  recorded a commit", and it does not say "something went wrong" and it does not say "fine either way".
  A reader who needs the commit to exist must look at `write_scope` -- if the task was writable and
  `commit` is `-`, that is a real gap and `missing_evidence` will name it.

Two documents are produced for this record: the `.json` that is the source of truth and the `.md`
generated from it. If a reader disagrees with a row in the `.md`, the `.json` settles it.
