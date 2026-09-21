'use strict';
/**
 * autonomous-loop.js - the V0.3 two-provider loop: DeepSeek plans, ChatGPT works, DeepSeek reviews.
 *
 * THE SHAPE
 *   The Workbench is the ONLY orchestrator. DeepSeek and ChatGPT never call each other; every hop goes
 *   Agent -> Workbench -> Verified Task Envelope -> Agent, so permissions, retry limits and state stay
 *   under one roof.
 *
 *     DeepSeek: plan the goal into candidate tasks
 *     loop:
 *       pick the next task
 *       DeepSeek: write the worker instruction (or answer directly if no worker is needed)
 *       Workbench: build envelope, dispatch ChatGPT, correlate
 *       DeepSeek: review the result
 *       PASS  -> task complete, next task
 *       RETRY -> new instruction, dispatch again (bounded)
 *     until a stop condition
 *
 * STOP CONDITIONS: GOAL_COMPLETE, USER_APPROVAL_REQUIRED, BLOCKED, NO_PROGRESS, BUDGET_EXHAUSTED.
 * There is no unbounded conversation here: worker rounds, task retries, goal iterations and consecutive
 * no-progress iterations are all capped, and hitting a cap is a legitimate outcome.
 *
 * CODEX: `codex_review_mode` defaults to OFF, and when it is OFF this loop does not touch the Codex
 * seat at all. The Evidence Record then states `independent_review_status = DISABLED_BY_POLICY` and
 * `review_level = SUPERVISOR_REVIEW` - a configured choice, recorded as such, never dressed up as an
 * independent review and never counted as missing evidence.
 *
 * READ-ONLY BY CONSTRUCTION: every envelope this loop builds has an EMPTY write scope and deny-all, so
 * no task in it can modify the Game project even if a worker tries.
 */

const path = require('node:path');
const fs = require('node:fs');

const WB = path.resolve(__dirname, '..', '..', 'workbench');
const protocol = require(path.join(WB, 'protocol', 'protocol.js'));
const correlation = require(path.join(WB, 'protocol', 'correlation.js'));
const evidence = require(path.join(WB, 'protocol', 'evidence.js'));
const card = require(path.join(WB, 'protocol', 'evidence-card.js'));
const policy = require(path.join(WB, 'protocol', 'policy.js'));
const supervisor = require(path.join(WB, 'protocol', 'supervisor.js'));
const seatModule = require(path.join(WB, 'seats', 'seat.js'));
const registryModule = require(path.join(WB, 'seats', 'registry.js'));

const GAME = (process.env.AWB_PROJECT_ROOT || path.resolve(__dirname, '..', '..', 'examples', 'demo-project'));

/**
 * Live worker dispatch is OFF unless asked for.
 *
 * With `AWB_LIVE_WORKER=1` the loop really dispatches through the worker SEAT; otherwise the worker side
 * is replayed from `temp/loop-fixtures/task-N.txt`, which exercises the same orchestration without
 * spending a browser round trip. The loop prints which of the two it did, per iteration, and records the
 * mode in the state file - a replayed result must never be readable as a live one.
 */
const LIVE_WORKER = process.env.AWB_LIVE_WORKER === '1';

/**
 * Read-only source context for seats that cannot read files.
 *
 * A browser worker has no filesystem, so a read-only inspection goal gives it nothing to inspect unless
 * the text travels with the packet. `AWB_CONTEXT_FILES=src/hud-pulse.js` embeds those files,
 * line-numbered, into both the planner's context and the dispatched request. It is deliberately NOT a
 * bound source: the envelope stays read-only with an empty source set, because a seat that cannot hash
 * cannot honestly acknowledge a source hash, and a source hash that nobody verifies is theatre.
 */
const CONTEXT_FILES = String(process.env.AWB_CONTEXT_FILES ?? '')
  .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
const CONTEXT_CHAR_BUDGET = 24000;

function readContextFiles() {
  if (!CONTEXT_FILES.length) return null;
  const parts = [];
  let total = 0;
  for (const rel of CONTEXT_FILES) {
    const abs = path.join(GAME, rel);
    if (!fs.existsSync(abs)) { parts.push(`(${rel}: NOT FOUND under ${GAME})`); continue; }
    const lines = fs.readFileSync(abs, 'utf8').split('\n').map((l, i) => `${String(i + 1).padStart(4, ' ')}| ${l.replace(/\r$/, '')}`);
    const block = `--- ${rel} (${lines.length} lines, ${rel === CONTEXT_FILES[CONTEXT_FILES.length - 1] ? 'final file' : 'file'}) ---\n${lines.join('\n')}`;
    if (total + block.length > CONTEXT_CHAR_BUDGET) {
      parts.push(`(${rel} withheld: the embedded read-only context budget of ${CONTEXT_CHAR_BUDGET} characters was reached)`);
      break;
    }
    total += block.length;
    parts.push(block);
  }
  return `${parts.join('\n\n')}\n\n(The line numbers above are the file's real line numbers, 1-based, and are the ones to cite.)`;
}

/** Where each task's worker result comes from. Supplied by earlier real runs so the loop can be
 *  exercised without repeatedly spending ChatGPT browser calls. */
function loadFixtureReply(taskIndex, runSnapshot) {
  const dir = path.join(WB, 'temp', 'loop-fixtures');
  const f = path.join(dir, `task-${taskIndex}.txt`);
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f, 'utf8');
  // A saved worker result is replayed against a NEW run id each iteration, so the ack lines are
  // tokenised in the file and bound to this run's real values here. Nothing else is rewritten.
  return raw
    .split('{{RUN_ID}}').join(runSnapshot.run_id)
    .split('{{SOURCE_HASH}}').join(runSnapshot.source_hash ?? 'NO_SOURCE_BOUND');
}

function extractJson(text) {
  const s = String(text ?? '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cands = [];
  if (fence) cands.push(fence[1]);
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) cands.push(s.slice(a, b + 1));
  cands.push(s);
  for (const c of cands) { try { const v = JSON.parse(c.trim()); if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v }; } catch { /* next */ } }
  return { ok: false };
}

const GOAL = process.argv.slice(2).join(' ') || [
  'Produce a short factual report on the demo workspace:',
  'identify which Tasks exist and their recorded statuses, and state what the next piece of work',
  'should be. This is read-only: modify nothing.',
].join(' ');

async function main() {
  const t0 = Date.now();
  const timing = {};
  /**
   * The reviewer mode comes from the operator, and the operator may set it in the UI.
   *
   * Resolution order: the environment override wins (an unattended or scripted run states its intent
   * explicitly), otherwise the mode saved by the UI toggle, otherwise OFF. Both paths go through
   * `policy.normalizeCodexMode`, so the string ON stored by the toggle resolves to AUTO here exactly as
   * it does in the server - one mapping, not two that can disagree.
   */
  const configMode = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(WB, 'config.json'), 'utf8')).review?.codexReviewMode ?? null; }
    catch { return null; }
  })();
  const savedMode = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(WB, 'state.json'), 'utf8')).review?.game ?? null; }
    catch { return null; }
  })();
  const requestedMode = process.env.AWB_CODEX_MODE ?? savedMode ?? configMode ?? 'OFF';
  const CODEX_MODE = policy.normalizeCodexMode(requestedMode);
  const LIMITS = policy.DEFAULT_LIMITS;
  /** A goal is bounded in tasks as well as in rounds: "keep going" is not the same as "keep going forever". */
  const MAX_TASKS = Number(process.env.AWB_MAX_TASKS ?? 3);

  // Declared before the first decision point: the "supervisor answered directly" path below touches it.
  const state = { iterations: 0, tasksCompleted: 0, workerRounds: 0, retries: 0, noProgressStreak: 0, blocked: false };
  const records = [];
  const completed = [];

  console.log('=== V0.3 TWO-PROVIDER AUTONOMOUS LOOP ===\n');
  console.log(`goal        : ${GOAL}`);
  console.log(`codex mode  : ${CODEX_MODE}${CODEX_MODE === 'OFF' ? ' (the Codex seat will not be touched)' : ''}`);
  console.log(`worker mode : ${LIVE_WORKER ? 'LIVE - real dispatch through the worker seat' : 'REPLAY - saved worker result, no browser round trip spent'}`);
  const contextBlock = readContextFiles();
  if (contextBlock) console.log(`context     : embedding ${CONTEXT_FILES.join(', ')} read-only (${contextBlock.length} chars), NOT bound as a source`);
  console.log(`limits      : ${JSON.stringify(LIMITS)}\n`);

  const reg = registryModule.buildRegistry('demo', 'default');
  const ds = reg.byId('seat:demo/default/supervisor');
  const worker = reg.byId('seat:demo/default/coder');
  const codexSeat = reg.byId('seat:demo/default/reviewer-codex');
  console.log(`supervisor  : ${ds.seat_id} (${ds.provider})`);
  console.log(`worker      : ${worker.seat_id} (${worker.provider})`);
  console.log(`codex seat  : ${codexSeat ? `${codexSeat.seat_id} (present, unused when mode=OFF)` : 'absent'}\n`);

  // ================= DeepSeek plans the goal into tasks =================
  let step = Date.now();
  const planRunId = protocol.newRunId('GOAL-PLAN');
  const planned = await supervisor.plan(seatModule, ds, GOAL, {
    runId: planRunId, sourceSetHash: protocol.hashSourceSet([]),
    sourceSummary: contextBlock ?? '(read-only goal: no source bound)',
    taskSummary: describeTasks(),
  });
  timing.deepseek_goal_plan_ms = Date.now() - step;
  if (!planned.ok) { console.error(`STOP: goal planning failed: ${planned.error}`); process.exit(2); }
  console.log(`--- DeepSeek goal plan (${timing.deepseek_goal_plan_ms}ms) ---`);
  console.log(`  needs_worker : ${planned.needs_worker}`);
  console.log(`  reasoning    : ${String(planned.plan.reasoning ?? '').slice(0, 220)}`);

  /**
   * The plan's task titles ARE the task queue. A supervisor that returns no worker-requiring task means
   * the goal was answerable directly, which is a legitimate GOAL_COMPLETE with zero iterations - and is
   * reported as exactly that rather than being padded with busywork.
   */
  const taskQueue = planned.needs_worker
    ? [{
      title: planned.plan.task_title ?? 'Supervisor-dispatched task',
      request: planned.plan.request ?? GOAL,
      criteria: planned.plan.success_criteria ?? [],
    }]
    : [];
  if (!taskQueue.length) {
    console.log('\n--- DeepSeek answered the goal directly; no worker was needed ---');
    console.log(String(planned.plan.direct_answer ?? '(no direct answer)').slice(0, 900));
    /**
     * A supervisor that answers the goal alone is a COMPLETED goal, not a stalled one.
     *
     * Measured: the first run of this loop reported NO_PROGRESS for an outcome that was in fact the
     * supervisor doing exactly its job - the goal was answerable from context, so no worker was
     * warranted and no task existed to complete. Calling that "no progress" would train the operator to
     * ignore the status. GOAL_COMPLETE with zero worker tasks is a legitimate, distinguishable outcome,
     * and the direct answer is recorded so the reader can judge it.
     */
    state.goalComplete = true;
    const dirRec = evidence.buildRecord({
      taskId: 'V03-GOAL-DIRECT',
      runId: planRunId,
      supervisorSeat: ds.seat_id, workerSeat: null, reviewerSeat: ds.seat_id,
      seatProviders: { supervisor: ds.provider, worker: null, reviewer: ds.provider },
      sourceHashes: [], correlationDisposition: planned.correlation?.disposition ?? null,
      runIdAck: planned.correlation?.ack?.run_id_ack ?? null,
      sourceHashAck: planned.correlation?.ack?.source_hash_ack ?? null,
      proposal: planned.plan.direct_answer ?? null,
      reviewResult: { verdict: 'PASS', summary: 'the supervisor answered the goal directly; no worker was warranted' },
      approval: 'APPROVED', changedFiles: [], writeScope: [], diffScopeOk: true,
      validationResults: [{ name: 'supervisor reply correlated to its dispatch snapshot', ok: planned.correlation?.ok === true, detail: planned.correlation?.disposition }],
      runtimeValidation: 'not applicable - no worker ran',
      reviewLevel: policy.REVIEW_LEVEL.SUPERVISOR_REVIEW,
      independentReviewStatus: policy.INDEPENDENT_REVIEW.DISABLED_BY_POLICY,
      independentReviewDetail: `codex_review_mode=${CODEX_MODE}`,
      codexReviewMode: CODEX_MODE,
      independence: { required: false, satisfied: null, detail: 'no worker was dispatched' },
      commit: null,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      notes: [
        `codex_review_mode=${CODEX_MODE}; the Codex seat was never resolved or dispatched.`,
        'GOAL_COMPLETE with zero worker tasks: the goal was answerable from context.',
      ],
    });
    dirRec.record_id = `EV-demo-V03-GOAL-DIRECT-${planRunId.slice(-8)}`;
    const dp = evidence.saveRecord(dirRec.record_id, dirRec);
    fs.writeFileSync(dp.replace(/\.json$/, '.md'), evidence.toMarkdown(dirRec), 'utf8');
    records.push(dirRec);
  }

  // ================= the loop =================

  while (true) {
    const stop = policy.evaluateStop(state, LIMITS);
    if (stop.stop) { console.log(`\nSTOP: ${stop.condition} - ${stop.detail}`); state.stopCondition = stop.condition; break; }

    /**
     * NEXT TASK.
     *
     * When the queue is empty the supervisor is asked again - with the completed work in front of it -
     * whether the goal is now satisfied or another task is warranted. The goal does not end because a
     * queue ran dry; it ends because the supervisor, seeing the results, says it is done. That decision
     * is bounded by MAX_TASKS and max_goal_iterations, and an unnecessary task is refused rather than
     * manufactured.
     */
    if (!taskQueue.length) {
      if (state.tasksCompleted >= MAX_TASKS) {
        state.stopCondition = policy.STOP.BUDGET_EXHAUSTED;
        console.log(`\nSTOP: ${state.stopCondition} - task bound ${MAX_TASKS} reached with the supervisor still requesting work`);
        break;
      }
      const ntRunId = protocol.newRunId('NEXT-TASK');
      step = Date.now();
      const nextPlan = await supervisor.plan(seatModule, ds, GOAL, {
        runId: ntRunId, sourceSetHash: protocol.hashSourceSet([]),
        sourceSummary: contextBlock ?? '(read-only goal: no source bound)',
        taskSummary: describeTasks(),
        progress: completed.length
          ? completed.map((c, i) => `${i + 1}. ${c.title} - supervisor verdict ${c.verdict}; ${String(c.summary ?? '').slice(0, 200)}`).join('\n')
          : '(nothing has been dispatched yet)',
      });
      timing[`next_task_plan_${state.tasksCompleted}_ms`] = Date.now() - step;
      if (!nextPlan.ok) {
        state.blocked = true; state.blockedReason = `next-task planning failed: ${nextPlan.error}`;
        console.log(`\nSTOP: BLOCKED - ${state.blockedReason}`);
        state.stopCondition = policy.STOP.BLOCKED;
        break;
      }
      console.log(`\n--- DeepSeek NEXT TASK decision (${timing[`next_task_plan_${state.tasksCompleted}_ms`]}ms) ---`);
      console.log(`  needs_worker : ${nextPlan.needs_worker}`);
      console.log(`  reasoning    : ${String(nextPlan.plan.reasoning ?? '').slice(0, 220)}`);
      if (!nextPlan.needs_worker) {
        state.goalComplete = true;
        console.log(`  -> GOAL_COMPLETE: the supervisor closed the goal after ${state.tasksCompleted} task(s)`);
        console.log(`  closing note : ${String(nextPlan.plan.direct_answer ?? '(none)').slice(0, 600)}`);
        const cl = evidence.buildRecord({
          taskId: 'V03-GOAL-CLOSURE', runId: ntRunId,
          supervisorSeat: ds.seat_id, workerSeat: worker.seat_id, reviewerSeat: ds.seat_id,
          seatProviders: { supervisor: ds.provider, worker: worker.provider, reviewer: ds.provider },
          sourceHashes: [], correlationDisposition: nextPlan.correlation?.disposition ?? null,
          runIdAck: nextPlan.correlation?.ack?.run_id_ack ?? null,
          sourceHashAck: nextPlan.correlation?.ack?.source_hash_ack ?? null,
          proposal: nextPlan.plan.direct_answer ?? null,
          reviewResult: { verdict: 'PASS', summary: `the supervisor closed the goal after ${state.tasksCompleted} completed task(s); no further worker task was warranted` },
          approval: 'APPROVED', changedFiles: [], writeScope: [], diffScopeOk: true,
          validationResults: [
            { name: 'goal-closure decision correlated to its dispatch snapshot', ok: nextPlan.correlation?.ok === true, detail: nextPlan.correlation?.disposition },
            { name: 'at least one worker task completed and passed review', ok: state.tasksCompleted > 0, detail: `${state.tasksCompleted} task(s)` },
          ],
          runtimeValidation: 'not applicable - read-only goal',
          reviewLevel: policy.REVIEW_LEVEL.SUPERVISOR_REVIEW,
          independentReviewStatus: policy.INDEPENDENT_REVIEW.DISABLED_BY_POLICY,
          independentReviewDetail: `codex_review_mode=${CODEX_MODE}`,
          codexReviewMode: CODEX_MODE,
          independence: { required: false, satisfied: null, detail: 'goal closure needs no independent review' },
          commit: null,
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          notes: [
            `codex_review_mode=${CODEX_MODE}; the Codex seat was never resolved or dispatched.`,
            `GOAL_COMPLETE declared by the supervisor after ${state.tasksCompleted} completed task(s), not by an empty queue.`,
          ],
        });
        cl.record_id = `EV-demo-V03-GOAL-CLOSURE-${ntRunId.slice(-8)}`;
        const cp = evidence.saveRecord(cl.record_id, cl);
        fs.writeFileSync(cp.replace(/\.json$/, '.md'), evidence.toMarkdown(cl), 'utf8');
        records.push(cl);
        state.stopCondition = policy.STOP.GOAL_COMPLETE;
        break;
      }
      taskQueue.push({
        title: nextPlan.plan.task_title ?? `Supervisor-dispatched task ${state.tasksCompleted + 1}`,
        request: nextPlan.plan.request ?? GOAL,
        criteria: nextPlan.plan.success_criteria ?? [],
      });
      continue;
    }

    state.iterations += 1;
    const task = taskQueue.shift();
    console.log(`\n${'='.repeat(92)}\nITERATION ${state.iterations}: ${task.title}\n${'='.repeat(92)}`);

    // ---- rotation check: a conversation is a budgeted resource, not a permanent home ----
    const rot = policy.shouldRotate(state.workerRounds, LIMITS);
    if (rot.rotate) console.log(`  [rotation] ${rot.reason}`);

    // ---- DeepSeek writes the worker instruction ----
    const runId = protocol.newRunId(`TASK-${state.iterations}`);
    const envBuilt = protocol.buildEnvelope({
      taskId: `V03-TASK-${String(state.iterations).padStart(2, '0')}`,
      projectId: 'demo', workspaceId: 'default', seatId: worker.seat_id,
      projectRoot: GAME, sourceRelPaths: [],
      readScope: [], writeScope: [], deny: ['*'], approvalRequired: [],
      successCriteria: task.criteria.length ? task.criteria : ['the report answers the instruction', 'nothing was modified'],
      expectedOutput: 'a reply beginning with RUN_ID_ACK and SOURCE_HASH_ACK, then the report',
      reviewRequirements: { required: true, independent_provider: false },
      taskTitle: task.title,
      request: contextBlock
        ? `${task.request}\n\n[READ-ONLY SOURCE CONTEXT]\nThis worker cannot read the filesystem, so the file under inspection travels with the instruction.\nNothing here may be written back; the envelope grants an empty write scope.\n\n${contextBlock}`
        : task.request,
    });
    if (!envBuilt.ok) { state.blocked = true; state.blockedReason = envBuilt.error; break; }
    const envelope = envBuilt.envelope;

    const runSnapshot = correlation.captureRunSnapshot({ envelope, source: 'run_snapshot (frozen at dispatch)' });

    // ---- Workbench dispatches. With mode=OFF the Codex seat is never resolved or touched here. ----
    step = Date.now();
    let reply;
    let replyOrigin;
    if (LIVE_WORKER) {
      const dispatched = await seatModule.dispatch(worker, envelope, { renderer: 'structured', projectRoot: GAME });
      if (dispatched.refused) {
        state.blocked = true; state.blockedReason = `worker dispatch refused: ${dispatched.error}`;
        console.log(`  worker dispatch : REFUSED - ${dispatched.error}`);
        break;
      }
      console.log(`  worker dispatch : ${dispatched.delivery_state}, transport detail: ${String(dispatched.detail ?? '').slice(0, 120)}`);
      // The transport decides whether the answer can be read straight away. Never re-dispatch while pending.
      if (!(worker.capabilities.can_deliver_synchronously && worker.capabilities.supports_readback)) {
        const obs = await seatModule.observe(worker, envelope);
        console.log(`  worker observe  : ${obs.delivery_state}`);
      }
      const read = await seatModule.read(worker, envelope, { index: dispatched.transport_evidence?.baseline_turns ?? undefined });
      reply = read.ok ? read.text : '';
      replyOrigin = 'live dispatch through the seat';
      if (!reply) {
        state.blocked = true;
        state.blockedReason = `the worker seat produced no readable reply: ${read.detail}`;
        console.log(`  worker reply    : NOT AVAILABLE (${read.detail})`);
        break;
      }
      console.log(`  worker reply    : ${reply.length} chars from the live seat`);

      /**
       * Close the turn before the loop asks for another task.
       *
       * Measured defect: this transport renders late, so a send can still be SEND_PENDING when the reply
       * arrives. The reply was read and correlated, but the seat kept holding the run open, and TASK 2's
       * dispatch was then refused - correctly - with "a packet for this run is already SEND_PENDING".
       * A two-task goal therefore stopped at BLOCKED with one task done. `settleTurn` closes the turn
       * ONLY on proof that it landed (the observed reply carries this run's id), so the anti-duplicate
       * rule stays intact: this is not a retry, it is the acknowledgement that no retry is needed.
       */
      const settled = seatModule.settleTurn(worker, {
        replyText: reply,
        detail: 'live reply read from the seat; the turn landed and no re-dispatch is needed',
      });
      if (settled.ok) {
        console.log(`  seat settled    : ${settled.from} -> USER_TURN_CONFIRMED -> ${worker.delivery_state} (run closed, next task may dispatch)`);
      } else {
        console.log(`  seat settle     : refused - ${settled.error}`);
        if (worker.delivery_state === 'SEND_UNCERTAIN') {
          state.blocked = true;
          state.blockedReason = 'the worker seat is SEND_UNCERTAIN: a human must confirm whether the message landed';
          break;
        }
      }
    } else {
      reply = loadFixtureReply(state.iterations, runSnapshot) ?? [
        `RUN_ID_ACK: ${runSnapshot.run_id}`,
        `SOURCE_HASH_ACK: ${runSnapshot.source_hash ?? 'NO_SOURCE_BOUND'}`,
        '',
        `Report for: ${task.title}`,
        describeTasks(),
        '',
        'Read-only: nothing was modified.',
      ].join('\n');
      replyOrigin = 'replayed saved worker result';
      console.log(`  worker reply    : ${reply.length} chars, replayed from a saved result - no browser round trip spent`);
    }
    timing[`task${state.iterations}_dispatch_ms`] = Date.now() - step;
    state.workerRounds += 1;
    console.log(`  worker origin   : ${replyOrigin} (${timing[`task${state.iterations}_dispatch_ms`]}ms)`);

    const corr = protocol.correlateWithSnapshot(envelope, runSnapshot, reply);
    console.log(`  correlation     : ${corr.disposition}`);

    // ---- DeepSeek reviews ----
    step = Date.now();
    const reviewed = await supervisor.review(seatModule, ds, envelope, reply, {
      runId: envelope.run_id, sourceSetHash: runSnapshot.source_hash,
    });
    timing[`task${state.iterations}_review_ms`] = Date.now() - step;
    const verdict = reviewed.ok ? reviewed.review.verdict : null;
    console.log(`  DeepSeek review : ${verdict} (${timing[`task${state.iterations}_review_ms`]}ms)`);
    if (reviewed.ok) console.log(`    summary: ${String(reviewed.review.summary ?? '').slice(0, 200)}`);

    // ---- independent review decision (policy, NOT a hard-coded Codex call) ----
    const indep = policy.wantsIndependentReview(CODEX_MODE, { type: 'review', title: task.title }, {
      writeScope: envelope.permissions.write_scope, retries: state.retries,
    });
    console.log(`  independent review: ${indep.status}${indep.wanted ? ` (${indep.reason})` : ` - ${indep.reason}`}`);
    // mode=OFF never reaches the Codex seat. ASSERTED, not assumed:
    if (CODEX_MODE === 'OFF' && indep.wanted) { console.error('  BUG: OFF requested an independent review'); process.exit(3); }

    const reviewLevel = policy.reviewLevelFor(indep.status);

    // ---- record the task ----
    const rec = evidence.buildRecord({
      taskId: envelope.task_id, runId: envelope.run_id,
      supervisorSeat: ds.seat_id, workerSeat: worker.seat_id,
      reviewerSeat: indep.status === policy.INDEPENDENT_REVIEW.SATISFIED ? codexSeat?.seat_id ?? null : ds.seat_id,
      seatProviders: { supervisor: ds.provider, worker: worker.provider, reviewer: ds.provider },
      sourceHashes: envelope.source_files, sourceSetHash: runSnapshot.source_hash,
      runIdAck: corr.trace.received_run_id_ack, sourceHashAck: corr.trace.received_source_hash_ack,
      correlationDisposition: corr.disposition,
      proposal: reply, reviewResult: reviewed.ok ? reviewed.review : null,
      approval: null, changedFiles: [], writeScope: [], diffScopeOk: true,
      validationResults: [
        { name: 'run_id correlated to the dispatch snapshot', ok: corr.ok, detail: corr.disposition },
        { name: 'worker produced a readable result', ok: reply.length > 0 },
        { name: 'read-only envelope (empty write scope)', ok: true },
      ],
      runtimeValidation: 'not applicable - read-only reporting task',
      reviewLevel,
      independentReviewStatus: indep.status,
      independentReviewDetail: indep.reason,
      codexReviewMode: CODEX_MODE,
      independence: { required: false, satisfied: null, detail: indep.reason },
      commit: null,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      notes: [
        `codex_review_mode=${CODEX_MODE}; independent review ${indep.status}; review_level=${reviewLevel}.`,
        `correlation disposition ${corr.disposition}; snapshot source ${corr.trace.expected_source}.`,
        /**
         * A replayed worker result must SAY it is replayed.
         *
         * The loop can run with a saved worker result instead of a live dispatch, which is what makes it
         * testable without spending a browser round trip. That is a legitimate mode and a dangerous one to
         * leave unlabelled: the resulting Evidence Record looks exactly like the product of a real worker
         * turn, and anyone reading it - or screenshotting it - would reasonably assume a live ChatGPT run
         * happened. The record now states which mode produced it, so the difference is in the artefact
         * rather than in the operator's memory.
         */
        `worker_mode=${replyOrigin === 'replayed saved worker result' ? 'REPLAY (a saved worker result was replayed; no live worker turn occurred)' : 'LIVE (a real worker turn was dispatched and read)'}.`,
      ],
    });
    rec.record_id = `EV-demo-${envelope.task_id}-${envelope.run_id.slice(-8)}`;
    const jp = evidence.saveRecord(rec.record_id, rec);
    fs.writeFileSync(jp.replace(/\.json$/, '.md'), evidence.toMarkdown(rec), 'utf8');
    records.push(rec);

    // ---- advance the loop on the supervisor's verdict ----
    if (verdict === 'PASS') {
      state.tasksCompleted += 1;
      state.noProgressStreak = 0;
      completed.push({ title: task.title, verdict, summary: reviewed.ok ? reviewed.review.summary : null });
      console.log(`  -> PASS: task complete (${state.tasksCompleted} completed)`);
    } else if (verdict === 'RETRY' && state.retries < LIMITS.max_task_retries) {
      state.retries += 1;
      state.noProgressStreak += 1;
      console.log(`  -> RETRY ${state.retries}/${LIMITS.max_task_retries}: re-dispatching with a new instruction`);
      taskQueue.unshift({ ...task, request: `${task.request}\n\n(Retry ${state.retries}: the supervisor was not satisfied. ${reviewed.ok ? String(reviewed.review.summary ?? '').slice(0, 300) : ''})` });
    } else if (verdict === 'BLOCKED') {
      state.blocked = true; state.blockedReason = 'DeepSeek returned BLOCKED';
    } else {
      state.noProgressStreak += 1;
      console.log(`  -> ${verdict ?? 'no verdict'}: counted as no progress (${state.noProgressStreak}/${LIMITS.no_progress_limit})`);
    }

    /**
     * A drained queue is NOT goal completion any more: the supervisor decides that at the top of the
     * next iteration, with the results in hand. Keeping the old rule here would have ended the goal
     * after the first passing task and quietly made "NEXT TASK" unreachable.
     */
  }

  if (!state.stopCondition) {
    const final = policy.evaluateStop(state, LIMITS);
    state.stopCondition = final.condition ?? (state.goalComplete ? policy.STOP.GOAL_COMPLETE : policy.STOP.NO_PROGRESS);
    if (state.goalComplete) state.stopCondition = policy.STOP.GOAL_COMPLETE;
  }

  // ================= report =================
  timing.total_ms = Date.now() - t0;
  console.log(`\n${'='.repeat(92)}\nLOOP SUMMARY\n${'='.repeat(92)}`);
  console.log(`  iterations      : ${state.iterations}`);
  console.log(`  tasks completed : ${state.tasksCompleted}`);
  console.log(`  worker rounds   : ${state.workerRounds}`);
  console.log(`  retries         : ${state.retries}`);
  console.log(`  stop condition  : ${state.stopCondition}`);
  console.log(`  evidence records: ${records.length}`);
  for (const r of records) {
    console.log(`    ${r.record_id}  ${r.final_status}  review_level=${r.review_level}  indep=${r.independent_review_status}`);
  }
  /**
   * PROOF, NOT ASSERTION, that mode OFF never reached the Codex seat.
   *
   * "0 codex processes" is weak evidence. The checkable facts, read from inside the process that did the
   * work, are:
   *   - the Codex SEAT was never bound to a run and never left IDLE;
   *   - the Codex TRANSPORT reports `initialised: false` and `runs: 0`, so no app-server session was
   *     ever opened and no turn was ever started on it.
   *
   * The transport MODULE being loaded is expected and is NOT a violation: building the registry
   * constructs every seat's transport object, and construction is side-effect-free (it resolves a
   * launcher path and prepares an isolated home; it does not spawn). An earlier version of this check
   * treated module loading as a violation and fired on a run where nothing had happened - a false alarm
   * that would have trained the operator to ignore it. What matters is not whether the object exists but
   * whether anything ever opened or dispatched it, and `_debug()` answers exactly that.
   */
  const codexTransportLoaded = Object.keys(require.cache)
    .some((k) => /transport\.codex-app-server/.test(k));
  const codexSeatState = codexSeat?.delivery_state ?? 'IDLE';
  const codexSeatUsed = Boolean(codexSeat && (codexSeat.current_run || codexSeatState !== 'IDLE'));
  let codexDebug = null;
  try { codexDebug = codexSeat?._transport?._debug?.() ?? null; } catch { codexDebug = null; }
  const codexOpened = codexDebug ? (codexDebug.initialised === true || (codexDebug.runs ?? 0) > 0) : false;
  const codexUntouched = !codexSeatUsed && !codexOpened;
  console.log(`\n  codex mode              : ${CODEX_MODE}`);
  console.log(`  codex transport loaded  : ${codexTransportLoaded ? 'yes (expected: the registry constructs every seat up front; construction does not spawn)' : 'no'}`);
  console.log(`  codex session opened    : ${codexDebug ? `${codexOpened ? 'YES - POLICY VIOLATION' : 'no'} (initialised=${codexDebug.initialised}, runs=${codexDebug.runs})` : 'not observable'}`);
  console.log(`  codex seat bound to run : ${codexSeatUsed ? `YES - POLICY VIOLATION (state ${codexSeatState})` : 'no (never left IDLE)'}`);
  console.log(`  codex seat touched      : ${CODEX_MODE === 'OFF' ? (codexUntouched ? 'NO (mode=OFF, proven by seat state and transport debug, not assumed)' : 'YES - POLICY VIOLATION') : 'per policy'}`);
  console.log(`  TIMING ${JSON.stringify(timing)}`);
  fs.writeFileSync(path.join(WB, 'temp', 'loop-timing.json'), JSON.stringify({
    ...timing, state, codex_mode: CODEX_MODE,
    codex_transport_loaded: codexTransportLoaded, codex_seat_state: codexSeatState,
    codex_debug: codexDebug, codex_untouched: codexUntouched,
    worker_mode: LIVE_WORKER ? 'LIVE' : 'REPLAY',
  }, null, 2), 'utf8');
  if (CODEX_MODE === 'OFF' && !codexUntouched) {
    console.error('\nFAILED: codex_review_mode was OFF but the Codex seat was opened or dispatched to. This is not a warning.');
    process.exitCode = 3;
  }

  const last = records[records.length - 1];
  if (last) {
    const c = card.buildCard(last);
    console.log(`\n  LAST EVIDENCE CARD: ${c.record_id} = ${c.status}`);
    for (const e of c.elements) console.log(`   ${e.symbol}  ${e.label.padEnd(22)} ${String(e.value ?? '').slice(0, 80)}`);
  }
}

function describeTasks() {
  try {
    const f = path.join(GAME, '.ai', 'tasks.json');
    if (!fs.existsSync(f)) return '(no task registry)';
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Object.values(d.tasks).map((t) => `- ${t.task_id} [${t.status}] ${t.title}`).join('\n');
  } catch (e) { return `(task registry unreadable: ${e.message})`; }
}

main().catch((e) => { console.error(`crashed: ${e && e.stack ? e.stack : e}`); process.exit(9); });
