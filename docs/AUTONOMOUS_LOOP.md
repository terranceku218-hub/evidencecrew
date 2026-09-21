# The Autonomous Loop: bounded agents, verified handoffs

**This is not unlimited agents talking forever.**

The loop is one supervised pipeline with a cap on every axis that could otherwise run away: worker
rounds, task retries, goal iterations, consecutive no-progress iterations, and the number of tasks a
single goal may dispatch. Every hop goes through the Workbench, so permissions, retry limits and state
stay under one roof. Planning, reviewing and task selection are done by one supervisor seat; the work
is done by a separate worker seat; and the Codex reviewer is an optional third seat that this loop does
not touch at all when `codex_review_mode` is `OFF`.

The implementation is `workbench/scripts/autonomous-loop.js`, with the supervisor's own turns in
`workbench/protocol/supervisor.js` and the bounds in `workbench/protocol/policy.js`.

## Contents

1. The loop, step by step
2. Hard limits
3. Stop conditions
4. The goal does not end because a queue ran dry
5. RETRY is a feature, not a failure
6. The reviewer prompt and truncation
7. Conversation rotation
8. What the loop never does

---

## 1. The loop, step by step

The seats are resolved from the registry as `seat:demo/default/supervisor` (the planner/reviewer) and
`seat:demo/default/coder` (the worker). DeepSeek and the worker never call each other: the shape is
Agent -> Workbench -> Verified Task Envelope -> Agent.

```
  GOAL
   |
   v
  supervisor.plan  (turn kind PLAN)
   |
   +-- needs_worker == false --> direct_answer --> GOAL_COMPLETE, 0 worker tasks
   |
   +-- needs_worker == true ---> one task queued (title, request, success_criteria)
                                  |
        +-------------------------+
        |
        v
  protocol.buildEnvelope   read-only: readScope [], writeScope [], deny ['*']
        |
        v
  correlation.captureRunSnapshot  (run id + source hash, frozen at dispatch)
        |
        v
  seatModule.dispatch(worker) --> observe (if the transport needs it) --> read
        |
        v
  protocol.correlateWithSnapshot   --> correlation_disposition
        |
        v
  supervisor.review  (turn kind REVIEW)  --> PASS | RETRY | BLOCKED
        |
        +-- PASS    --> tasksCompleted += 1, noProgressStreak = 0
        +-- RETRY   --> the same task is re-queued at the front, with the criticism
        +-- BLOCKED --> stop: BLOCKED
        |
        v
  queue empty? --> supervisor.plan again, with [PROGRESS SO FAR]
                    |
                    +-- needs_worker == true  --> exactly one more task
                    +-- needs_worker == false --> GOAL_COMPLETE (goal closure record)
        |
        v
  policy.evaluateStop --> STOP condition, reported in the loop summary
```

In detail, per iteration:

1. **Stop check.** At the top of the loop, `policy.evaluateStop(state, LIMITS)` is consulted. If it
   returns `stop: true`, the loop prints `STOP: <condition> - <detail>`, records the condition in
   `state.stopCondition` and exits the loop.
2. **Next task.** When the queue is empty, the supervisor is asked again (see section 4). Otherwise the
   next task is taken from the front of the queue.
3. **Rotation check.** `policy.shouldRotate(state.workerRounds, LIMITS)` is consulted and a `[rotation]`
   line is printed when the worker's conversation has reached its budget (section 7).
4. **Envelope.** `protocol.buildEnvelope` builds a fresh envelope for the task, with a new run id from
   `protocol.newRunId`. Failure is a hard stop: the loop sets `state.blocked = true` with
   `state.blockedReason = envBuilt.error` and breaks.
5. **Dispatch.** `correlation.captureRunSnapshot` freezes the run id and source hash at dispatch. With
   `AWB_LIVE_WORKER=1` the loop really dispatches through the worker seat
   (`seatModule.dispatch`, then `observe` when the seat cannot deliver synchronously, then `read`).
   Without it, the worker side is replayed from `workbench/temp/loop-fixtures/task-N.txt` via
   `loadFixtureReply`, and the run id and source hash tokens in that file are bound to this run's real
   values. The loop prints which of the two happened, and `workbench/temp/loop-timing.json` records
   `worker_mode` as `LIVE` or `REPLAY`, so a replayed result can never be read as a live one.
6. **Correlation.** `protocol.correlateWithSnapshot(envelope, runSnapshot, reply)` decides the
   disposition, which is printed and recorded.
7. **Review.** `supervisor.review` is given the envelope, the reply, the run id and the snapshot source
   hash, and returns a verdict.
8. **Record.** An Evidence Record is built for the task, saved as JSON, and its Markdown view is
   written beside it.
9. **Advance.** The verdict decides what happens next (section 5).

## 2. Hard limits

`DEFAULT_LIMITS` in `workbench/protocol/policy.js`:

| Limit | Default | Enforced by |
|---|---|---|
| `max_worker_rounds` | 8 | `shouldRotate(workerRounds, limits)` -- reaching it triggers conversation rotation |
| `max_task_retries` | 3 | the loop's retry guard: `verdict === 'RETRY' && state.retries < LIMITS.max_task_retries` |
| `max_goal_iterations` | 12 | `evaluateStop` -> `BUDGET_EXHAUSTED` |
| `no_progress_limit` | 2 | `evaluateStop` -> `NO_PROGRESS` |

All four are data, not constants scattered through the orchestrator. `evaluateStop(state, limits)` and
`shouldRotate(workerRounds, limits)` both merge overrides over the defaults
(`{ ...DEFAULT_LIMITS, ...limits }`), so a goal can be bounded differently by passing its own `limits`.
The shipped loop calls them with `LIMITS = policy.DEFAULT_LIMITS`, so in that script the four numbers
are the defaults.

There is a fifth bound that is specific to the loop: `MAX_TASKS`, from `AWB_MAX_TASKS` and defaulting to
`3`. It caps how many worker tasks one goal may dispatch. When the queue is empty, the supervisor is
still asking for work, and `state.tasksCompleted >= MAX_TASKS`, the loop stops with
`BUDGET_EXHAUSTED` and the detail `task bound 3 reached with the supervisor still requesting work`.
"Keep going" is not the same as "keep going forever".

Hitting a limit is a **legitimate, reported outcome rather than a crash**. `BUDGET_EXHAUSTED` and
`NO_PROGRESS` are stop conditions like any other: the condition is printed as
`STOP: <condition> - <detail>`, stored in `state.stopCondition`, written into the loop summary and into
`workbench/temp/loop-timing.json`, and the process leaves with a success exit code. The loop reserves
non-zero exits for real failures: `process.exit(2)` when goal planning fails, `process.exit(3)` for a
Codex policy violation, and `process.exit(9)` from the top-level crash handler.

## 3. Stop conditions

`STOP` holds five conditions: `GOAL_COMPLETE`, `USER_APPROVAL_REQUIRED`, `BLOCKED`, `NO_PROGRESS`,
`BUDGET_EXHAUSTED`.

| Condition | Trigger | What the operator should do next |
|---|---|---|
| `GOAL_COMPLETE` | `state.goalComplete === true`; detail `goal criteria satisfied`. Set either when the first plan needed no worker, or when the next-task decision says no worker is warranted. | Nothing is required. Read the completion record (`V03-GOAL-DIRECT` or `V03-GOAL-CLOSURE`) and the task records to judge the work itself. |
| `USER_APPROVAL_REQUIRED` | `state.needsApproval === true`; detail `state.approvalReason ?? 'a human decision is required'`. | A person must decide. The loop will not proceed past this on its own. |
| `BLOCKED` | `state.blocked === true`; detail `state.blockedReason ?? 'blocked'`. Inside the loop this is set by an envelope build failure, a failed next-task plan, a refused worker dispatch, an unreadable worker reply, a seat left `SEND_UNCERTAIN`, or a `BLOCKED` verdict from the supervisor. | Read `state.blockedReason` first: it names the cause. Fix that cause -- usually by confirming whether a message landed, or by attending to a seat that stopped answering -- then re-run. |
| `NO_PROGRESS` | `(state.noProgressStreak ?? 0) >= no_progress_limit` (2); detail `<N> consecutive iterations produced no new completed task`. | The current task definition is not advancing the goal. Rephrase the goal or the task, or take the work over by hand. |
| `BUDGET_EXHAUSTED` | Either `(state.iterations ?? 0) >= max_goal_iterations` (12), detail `goal iteration limit 12 reached`; or the loop's task bound, detail `task bound 3 reached with the supervisor still requesting work`. | The goal is too large or too vague for its bounds. Split it, tighten it, or raise the bounds deliberately rather than by accident. |

Ordinary `BLOCKED` breaks -- envelope build failure, close-and-break paths after a refused dispatch --
leave `state.stopCondition` unset, and the post-loop block fills it in by calling `evaluateStop` once
more, so the reported condition is `BLOCKED` rather than silence.

### Precedence

`evaluateStop` returns the **first** match, in this fixed order:

1. `GOAL_COMPLETE`
2. `BLOCKED`
3. `USER_APPROVAL_REQUIRED`
4. `NO_PROGRESS`
5. `BUDGET_EXHAUSTED`

So a goal that finished on its last allowed iteration is reported as `GOAL_COMPLETE`, not as a budget
failure -- the suite asserts exactly that case. `BLOCKED` outranks the counters and the cap, and
progress counters are only consulted once nothing more decisive is true.

One honest note about `USER_APPROVAL_REQUIRED`: this script builds envelopes with `approvalRequired: []`
and `deny: ['*']`, and it never sets `state.needsApproval`. In the shipped read-only loop the condition
is therefore a capability of `evaluateStop` available to callers, rather than something this particular
script produces. A refusal that does get recorded is a different path: `deriveStatus` turns
`approval === 'REJECTED'` into `final_status = BLOCKED` on the record itself.

## 4. The goal does not end because a queue ran dry

A drained queue is not completion. When the queue is empty the supervisor is asked again, with the
completed work in front of it, whether the goal is now satisfied or another task is warranted. The goal
ends because the supervisor, seeing the results, says it is done.

That second plan call is sent with a `progress` string assembled from the completed tasks
(`"<n>. <title> - supervisor verdict <verdict>; <summary>"`), and the plan prompt turns it into a
`[PROGRESS SO FAR]` section that says the supervisor is being consulted again after those tasks were
completed and reviewed, that it should answer `needs_worker=false` with the closing statement in
`direct_answer` if the goal is satisfied, that real remaining work should be defined as exactly ONE
next task, and that inventing work to stay busy is a defect rather than diligence.

- `needs_worker: false` -> `state.goalComplete = true`, the loop prints
  `-> GOAL_COMPLETE: the supervisor closed the goal after <N> task(s)`, and it writes a closure record
  with `task_id` `V03-GOAL-CLOSURE` whose id is derived from the run id. That record's
  `validation_results` include `goal-closure decision correlated to its dispatch snapshot` and
  `at least one worker task completed and passed review`, the latter with `ok: state.tasksCompleted > 0`.
- `needs_worker: true` -> exactly one more task is queued, and the loop continues.

The same distinction appears at the very start. If the first plan reports `needs_worker: false`, the
goal was answerable from context: the loop prints the direct answer, sets `state.goalComplete = true`,
and writes a record with `task_id` `V03-GOAL-DIRECT` and
`runtime_validation = 'not applicable - no worker ran'`. That is a **legitimate completion with zero
tasks**, not a stall. It is stated as a measured defect in the source: the first run of this loop
reported `NO_PROGRESS` for an outcome that was in fact the supervisor doing exactly its job, and
calling that "no progress" would train the operator to ignore the status.

## 5. RETRY is a feature, not a failure

A review that can only ever say `PASS` is not a review. `RETRY` is the loop's normal corrective
mechanism, and it is bounded on purpose.

When the supervisor returns `RETRY` and `state.retries < max_task_retries`, the loop increments
`state.retries`, re-queues the **same** task at the front of the queue, and appends the criticism to the
instruction it will dispatch:

```
(Retry <n>: the supervisor was not satisfied. <review summary, first 300 characters>)
```

What makes that retry good is upstream. The review prompt requires a per-criterion result, and the
allowed results are `satisfied`, `partial` and `not_addressed`; the reviewer must cite what the worker
said, must not accept a claim merely because it is confidently worded, and must say so if the worker
asserted something it could not have known. So the criticism that rides into the re-dispatch names the
criterion that was not satisfied, and the next dispatch is a sharper instruction rather than a repeat
of the same one.

If the supervisor keeps returning `RETRY` after `max_task_retries` is reached, the retry branch is no
longer taken: the verdict falls to the no-progress branch, `state.noProgressStreak` increases, and the
loop prints `-> RETRY: counted as no progress (N/2)`. Every retry also increments `noProgressStreak`,
so two retries in a row with no completed task reach `NO_PROGRESS` at the default limit of 2. A retry is
therefore a real attempt to fix a real defect, not a way to buy more turns.

The inverse holds too: if nothing is ever rejected, nothing is being reviewed.

## 6. The reviewer prompt and truncation

A long worker reply is truncated before it reaches the reviewer, and the truncation is **declared** in
the prompt. The cap is `WORKER_REPLY_CHAR_LIMIT = 24000` in `workbench/protocol/supervisor.js`; a reply
longer than that is cut, and the prompt carries a notice that:

- is headed `[TRUNCATION NOTICE - READ THIS BEFORE JUDGING]`;
- states the true length of the reply and exactly how many trailing characters are withheld;
- states that the cut is a limitation of the harness and `not evidence about the worker`;
- instructs the reviewer to judge every criterion only on the text shown;
- instructs it to record a criterion that is not addressed in the shown text as `partial` rather than
  `not_addressed`, and to say in the evidence that it may lie beyond the cut;
- instructs it to add the concern `reply_truncated_by_harness`, so the truncation is visible in the
  record;
- forbids failing the task solely because the shown text ends mid-sentence;
- and the shown text itself ends with a marker of the form
  `[END OF SHOWN TEXT - <N> trailing characters withheld by the harness]`.

**The defect this fixes.** The reply used to be cut at 8000 characters with nothing said about it. The
reviewer then failed a task for "not stating that runtime testing was unavailable" when that statement
was simply past the cut. The supervisor cannot judge what it was never shown, and a silent cut is
indistinguishable from a worker that stopped mid-sentence -- so the reviewer scores a harness
limitation as a worker failure, the loop retries work that was already done, and one mistake consumes
retry budget and a browser round trip. The cut is now both generous and declared.
`workbench/verify/v03-codex-optional.test.js` asserts each of these behaviours, including that a short
reply carries no notice, that a long one states its true length, and that the notice protects the
worker.

The same prompt discipline applies to correlation: both supervisor turns -- `PLAN` and `REVIEW` -- end
with an acknowledgement section asking the reply to begin with `RUN_ID_ACK: <run id>` and
`SOURCE_HASH_ACK: <source set hash>` verbatim, because a review is also a correlated reply.

## 7. Conversation rotation

A browser conversation is a budgeted resource, not a permanent home.

`policy.shouldRotate(workerRounds, limits)` returns `{ rotate, reason, rounds, threshold }` and sets
`rotate: true` once `workerRounds >= max_worker_rounds` (8 by default). The shipped loop consults it
once per iteration, before building the envelope, and prints the returned reason, which ends
`rotate the conversation and hand off compactly`.

What a compact handoff means here: long-term state lives in the Workbench and in the Evidence Records,
never in a chat transcript. The replacement conversation is not asked to reconstruct the goal from
scrollback; it is given a compact statement of what has happened and what is next. That is the same
discipline the loop already applies elsewhere -- the next-task decision is made from the `progress`
summary of completed tasks rather than from the transcript, and the planner's context is built from
`sourceSummary`, `taskSummary` and `progress` rather than from history.

Note what the shipped script does and does not do: it computes the rotation decision and reports it. The
loop itself does not open a replacement conversation, because the browser session belongs to the
transport and the seat, not to the orchestration script.

## 8. What the loop never does

- **It never re-dispatches while a turn is pending.** `seatModule.dispatch` is gated by
  `contract.mayRedispatch(seat.delivery_state)`, so a second dispatch while a run is in flight is
  refused. After reading a reply the loop calls `settleTurn`, which closes the turn only on proof that
  it landed. If the seat is left `SEND_UNCERTAIN`, the loop does not guess: it stops with `BLOCKED` and
  the reason that a human must confirm whether the message landed. This is a measured fix -- a
  late-rendering transport left a run open, and TASK 2's dispatch was refused with "a packet for this
  run is already SEND_PENDING", ending a two-task goal at `BLOCKED` with one task done.
- **It never proceeds on an uncorrelated reply.** Every worker reply goes through
  `protocol.correlateWithSnapshot` against the snapshot frozen at dispatch, and the disposition is
  recorded. A `correlation_disposition` that is not `CORRELATED` forces `final_status = UNVERIFIED` in
  `deriveStatus`, and the card raises the error: the reply was not correlated to this run, and it was
  never passed to review.
- **It never writes outside the envelope's write scope.** The envelopes this loop builds are read-only
  by construction: `readScope: []`, `writeScope: []`, `deny: ['*']`, `approvalRequired: []`. The record
  stores `write_scope`, `changed_files` and `diff_scope_ok`, and `diff_scope_ok === false` forces
  `UNVERIFIED` and raises the error `Files changed outside the permitted write scope.`
- **It never lets the reviewer be the same provider as the worker when independence is required.**
  Independence is decided by `protocol.checkIndependence`, not by a seat's name; a supervisor sharing
  the worker's provider is not independent. `independence.required === true` with
  `satisfied !== true` forces `PARTIAL`, and `reviewLevelFor` claims `INDEPENDENT_PROVIDER_REVIEW` only
  on `INDEPENDENT_REVIEW.SATISFIED`.
- **It never loops without a bound.** `DEFAULT_LIMITS` bounds worker rounds, retries, iterations and
  consecutive no-progress iterations; `MAX_TASKS` bounds the tasks one goal may dispatch. Every exit
  from the loop -- including the refusals and the unreadable replies, which break out and are resolved
  by a final `evaluateStop` -- ends in a reported stop condition, and there is no path that continues
  without a limit.
