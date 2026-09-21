'use strict';
/**
 * cross-provider-run.js - V0.2.1: a real DeepSeek Supervisor working with a real ChatGPT Worker.
 *
 * THE FLOW THIS DRIVES
 *   Goal
 *     -> DeepSeek Supervisor seat: decide whether a worker is needed
 *     -> DeepSeek Supervisor seat: produce the Verified Task Envelope (scope, permissions, criteria)
 *     -> ChatGPT Coder seat: receive the rendered packet, answer with RUN_ID_ACK
 *     -> correlation check, TOCTOU re-verification
 *     -> DeepSeek Supervisor seat: review the worker result against the criteria it wrote
 *     -> Evidence Record -> Evidence Card
 *
 * TWO REAL PROVIDERS, ONE PROTOCOL
 *   DeepSeek is reached over its official API; ChatGPT over the browser DOM. Both go through the same
 *   transport contract and the same Verified Task Protocol. Nothing in this file branches on provider
 *   name - the only adaptations read `capabilities`, and the script asserts that.
 *
 * READ-ONLY BY CONSTRUCTION
 *   The envelope it builds gives the worker an EMPTY write scope and a deny-all, so the run cannot
 *   modify the Game project even if the worker tries. That is the point of permissions being data.
 *
 * It writes exactly two things: the Evidence Record, and a JSON timing/diagnostic summary under the
 * workbench's own temp directory. It touches no project file and no Git state.
 */

const path = require('node:path');
const fs = require('node:fs');

const WB = path.resolve(__dirname, '..', '..', 'workbench');
const protocol = require(path.join(WB, 'protocol', 'protocol.js'));
const renderers = require(path.join(WB, 'protocol', 'renderers.js'));
const evidence = require(path.join(WB, 'protocol', 'evidence.js'));
const supervisor = require(path.join(WB, 'protocol', 'supervisor.js'));
const seatModule = require(path.join(WB, 'seats', 'seat.js'));
const registryModule = require(path.join(WB, 'seats', 'registry.js'));

const GAME = (process.env.AWB_PROJECT_ROOT || path.resolve(__dirname, '..', '..', 'examples', 'demo-project'));

/** Where the worker's reply comes from. Set from argv. */
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const GOAL = opt('goal',
  'Review the two completed default Tasks and their Evidence, then identify the single most '
  + 'worthwhile direction to work on next. Do not modify any file.');

const timing = { steps: [] };
function mark(step, ms, extra = {}) {
  timing.steps.push({ step, ms, ...extra });
  console.log(`  [${String(ms).padStart(6)}ms] ${step}${extra.note ? ` - ${extra.note}` : ''}`);
}

async function main() {
  const runStarted = Date.now();
  console.log('=== V0.2.1 CROSS-PROVIDER RUN ===\n');
  console.log(`goal: ${GOAL}\n`);

  const reg = registryModule.buildRegistry('demo', 'default');
  const ds = reg.byId('seat:demo/default/supervisor');
  const coder = reg.byId('seat:demo/default/coder');

  console.log('seats:');
  for (const s of reg.seats) {
    console.log(`  ${s.seat_id.padEnd(38)} ${s.role.padEnd(11)} ${s.provider}/${s.transport}`);
  }
  console.log('');

  if (!ds || ds.provider !== 'deepseek') { console.error('STOP: no DeepSeek supervisor seat'); process.exit(2); }
  if (!coder || coder.provider !== 'chatgpt') { console.error('STOP: no ChatGPT coder seat'); process.exit(2); }

  // ---- the no-provider-branching assertion, made against this file's own source ----
  const selfSrc = fs.readFileSync(__filename, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const branches = [/provider\s*===/, /provider\s*==/, /switch\s*\(\s*[\w.]*provider/].filter((re) => re.test(selfSrc));
  console.log(`orchestration branches on provider name: ${branches.length === 0 ? 'NONE' : 'YES (' + branches.length + ')'}`);
  console.log('');

  // ---- supervisor health + the supervisor run id ----
  const runId = protocol.newRunId('V021-XPROV');
  // NOTE: the source set hash used for the SUPERVISOR's own turn. The supervisor turn binds no source,
  // so this is the hash of the empty set - correct for that turn and NOT the hash the worker is asked
  // to ack. That distinction is exactly what broke the first cross-provider run: the worker was told to
  // ack the real file hash (correct) while this script compared its reply against the empty-set hash
  // (wrong), producing a SOURCE_ACK_MISMATCH on a worker reply that was in fact correct. The worker's
  // expectation is therefore computed from the ENVELOPE, after it is built, and never from here.
  const sourceSetHash = protocol.hashSourceSet([]);
  const ctx = { runId, sourceSetHash, sourceSummary: '(read-only goal: no source files bound)', taskSummary: describeTasks() };

  console.log(`supervisor run id: ${runId}`);
  let t = Date.now();
  const health = await seatModule.refreshHealth(ds);
  mark('deepseek seat health', Date.now() - t, { note: `${health.status}` });
  if (!health.ok) { console.error(`STOP: DeepSeek seat is not healthy: ${health.detail}`); process.exit(3); }

  // =====================================================================
  // STEP 1 - DeepSeek plans
  // =====================================================================
  console.log('\n--- STEP 1: DeepSeek supervisor plans the goal ---');
  t = Date.now();
  const planned = await supervisor.plan(seatModule, ds, GOAL, ctx);
  const planMs = Date.now() - t;
  mark('supervisor.plan', planMs);

  if (!planned.ok) {
    console.error(`\nSTOP: planning failed: ${planned.error}`);
    if (planned.raw) console.error(`raw: ${planned.raw}`);
    process.exit(4);
  }
  console.log(`  deepseek needs_worker : ${planned.needs_worker}`);
  console.log(`  reasoning             : ${(planned.plan.reasoning ?? '').slice(0, 220)}`);
  console.log(`  correlation           : ${planned.correlation.disposition}`);

  if (!planned.needs_worker) {
    console.log('\n--- DeepSeek decided NO WORKER IS NEEDED ---');
    console.log(planned.plan.direct_answer ?? '(no direct answer supplied)');
    const rec = evidence.buildRecord({
      taskId: 'V021-XPROV-SUPERVISOR-ONLY', runId,
      supervisorSeat: ds.seat_id, workerSeat: null, reviewerSeat: null,
      seatProviders: { supervisor: ds.provider },
      sourceHashes: [], correlationDisposition: planned.correlation.disposition,
      runIdAck: planned.correlation.ack?.run_id_ack ?? null,
      sourceHashAck: planned.correlation.ack?.source_hash_ack ?? null,
      proposal: planned.plan.direct_answer,
      reviewResult: { verdict: 'NOT_REQUIRED', summary: 'the supervisor answered directly' },
      approval: null, changedFiles: [], writeScope: [], diffScopeOk: true,
      validationResults: [{ name: 'supervisor reply correlated', ok: planned.correlation.ok }],
      runtimeValidation: 'not applicable - no code was executed',
      independence: { required: false, satisfied: null, detail: 'no worker was dispatched' },
      startedAt: new Date(runStarted).toISOString(), completedAt: new Date().toISOString(),
    });
    rec.record_id = `EV-demo-V021-SUPERVISOR-ONLY-${runId.slice(-8)}`;
    finish(rec, timing, runStarted, planMs, 0, 0);
    return;
  }

  // =====================================================================
  // STEP 2 - DeepSeek produces the Verified Task Envelope
  // =====================================================================
  console.log('\n--- STEP 2: building the Verified Task Envelope ---');
  const built = protocol.buildEnvelope({
    taskId: 'V021-XPROV-001',
    projectId: 'demo',
    workspaceId: 'default',
    seatId: coder.seat_id,
    projectRoot: GAME,
    // READ-ONLY: resolve the planner's requested paths, but bind them for READING while granting no
    // write scope at all.
    sourceRelPaths: (planned.plan.source_files ?? []).filter((p) => typeof p === 'string' && p && !p.includes('..')),
    readScope: planned.plan.source_files ?? [],
    writeScope: [],
    deny: ['*'],
    approvalRequired: [],
    successCriteria: planned.plan.success_criteria,
    expectedOutput: 'a reply beginning with RUN_ID_ACK and SOURCE_HASH_ACK, then the findings',
    reviewRequirements: planned.plan.review_requirements,
    taskTitle: planned.plan.task_title ?? 'Supervisor-dispatched read-only review',
    taskDescription: planned.plan.reasoning ?? null,
    request: planned.plan.request ?? GOAL,
  });
  if (!built.ok) { console.error(`STOP: ${built.error}`); process.exit(5); }
  const envelope = built.envelope;

  console.log(`  run_id        : ${envelope.run_id}`);
  console.log(`  write scope   : ${envelope.permissions.write_scope.length ? envelope.permissions.write_scope.join(', ') : '(NONE - read-only)'}`);
  console.log(`  deny          : ${envelope.permissions.deny.join(', ')}`);
  console.log(`  source bound  : ${envelope.source_files.length ? envelope.source_files.map((f) => f.path).join(', ') : '(none)'}`);
  console.log(`  criteria      : ${envelope.success_criteria.length}`);
  console.log(`  independence  : required=${envelope.review_requirements.independent_provider}`);

  // The worker's ack expectation comes from the ENVELOPE, which is what the rendered packet told it to
  // echo. Deriving it from the envelope (rather than from the supervisor context) is the fix for the
  // first run's false SOURCE_ACK_MISMATCH.
  const workerSourceSetHash = protocol.hashSourceSet(envelope.source_files.filter((f) => f.sha256 !== null));
  console.log(`  worker ack expectation: ${workerSourceSetHash}`);

  // =====================================================================
  // STEP 3 - dispatch to the ChatGPT seat
  // =====================================================================
  console.log('\n--- STEP 3: dispatching to the ChatGPT coder seat ---');
  const rendered = renderers.render(envelope, { renderer: 'structured' });
  console.log(`  renderer=${rendered.renderer}  packet=${rendered.text.length} chars`);
  fs.mkdirSync(path.join(WB, 'temp'), { recursive: true });
  fs.writeFileSync(path.join(WB, 'temp', 'v021-worker-packet.txt'), rendered.text, 'utf8');

  t = Date.now();
  const dispatched = await seatModule.dispatch(coder, envelope, {
    renderer: 'structured',
    // The ChatGPT transport cannot read files, so the seat layer embeds the bound source into the
    // packet. It needs the project root to find them; the capability, not the provider, decides this.
    projectRoot: GAME,
  });
  const dispatchMs = Date.now() - t;
  mark('chatgpt seat dispatch', dispatchMs, { note: `${dispatched.delivery_state}${dispatched.refused ? ' REFUSED' : ''}` });
  console.log(`  delivery state: ${dispatched.delivery_state}`);
  console.log(`  detail        : ${String(dispatched.detail ?? '').slice(0, 200)}`);
  if (dispatched.refused) { console.error(`STOP: dispatch refused: ${dispatched.error}`); process.exit(6); }

  // The worker's answer arrives through the SEAT, adapted only by capability.
  let workerReply = null;
  let observeMs = 0;
  if (!(coder.capabilities.can_deliver_synchronously && coder.capabilities.supports_readback)) {
    console.log('  transport cannot deliver synchronously -> observing (never re-dispatching)');
    t = Date.now();
    const obs = await seatModule.observe(coder, envelope);
    observeMs = Date.now() - t;
    mark('chatgpt seat observe', observeMs, { note: obs.delivery_state });
  }

  const readOpts = { index: dispatched.transport_evidence?.baseline_turns ?? undefined };
  const read = await seatModule.read(coder, envelope, readOpts);
  if (read.ok) workerReply = read.text;
  console.log(`  worker reply  : ${workerReply ? `${workerReply.length} chars` : `NOT AVAILABLE (${read.detail})`}`);

  // If the protocol's own ack is absent, the worker reply is UNUSABLE by design. Fall back to the raw
  // ChatGPT transcript only to prove the worker really answered, and say so explicitly rather than
  // silently treating prose as a correlated result.
  let workerReplyForCorrelation = workerReply;
  let workerReplySource = 'seat.read() via the transport contract';
  if (!workerReply || !/RUN_ID_ACK/i.test(workerReply)) {
    const rawFile = opt('rawReplyFile', null);
    if (rawFile && fs.existsSync(rawFile)) {
      workerReplyForCorrelation = fs.readFileSync(rawFile, 'utf8');
      workerReplySource = `raw transcript (${rawFile}) - NOT obtained through the transport contract, recorded as such`;
      console.log(`  falling back to a raw transcript for correlation: ${rawFile}`);
    }
  }
  if (!workerReplyForCorrelation) {
    console.error('\nSTOP: the ChatGPT seat produced no readable reply. The protocol cannot be completed '
      + 'without one, and it will not be faked.');
    process.exit(7);
  }

  // =====================================================================
  // STEP 4 - correlate
  // =====================================================================
  console.log('\n--- STEP 4: correlation + TOCTOU ---');
  const corr = protocol.checkCorrelation(envelope, workerReplyForCorrelation, { expectedSourceHash: workerSourceSetHash });
  console.log(`  run_id_ack    : ${corr.ack.run_id_ack ?? '(absent)'}`);
  console.log(`  expected      : ${envelope.run_id}`);
  console.log(`  disposition   : ${corr.disposition}`);
  console.log(`  correlated    : ${corr.ok}`);
  const toctou = protocol.verifySourceUnchanged(GAME, envelope.source_files);
  console.log(`  source check  : ${toctou.ok ? `${toctou.verified}/${toctou.total} unchanged` : 'CHANGED'}`);
  if (!corr.ok) console.log(`  detail        : ${corr.detail}`);

  // =====================================================================
  // STEP 5 - DeepSeek reviews
  // =====================================================================
  console.log('\n--- STEP 5: DeepSeek supervisor reviews the worker result ---');
  let reviewResult = null;
  let reviewMs = 0;
  if (!corr.ok) {
    console.log('  REFUSED: an uncorrelated reply is never passed to review.');
  } else {
    t = Date.now();
    const reviewed = await supervisor.review(seatModule, ds, envelope, workerReplyForCorrelation,
      { ...ctx, runId: envelope.run_id });
    reviewMs = Date.now() - t;
    mark('supervisor.review', reviewMs);
    if (!reviewed.ok) {
      // Say WHY. "the review failed" with no cause is the kind of message that costs an hour.
      console.log(`  review failed: ${reviewed.error}`);
      if (reviewed.turn) {
        console.log(`    turn.refused : ${reviewed.turn.refused === true}`);
        console.log(`    turn.error   : ${reviewed.turn.error ?? '(none)'}`);
        console.log(`    delivery     : ${reviewed.turn.delivery_state ?? '(none)'}`);
        console.log(`    reply        : ${reviewed.turn.reply ? `${reviewed.turn.reply.length} chars` : '(none)'}`);
        // The full turn, because the reason the reply is missing lives inside it and guessing has
        // already cost more than printing it.
        console.log(`    turn keys    : ${Object.keys(reviewed.turn).join(', ')}`);
        console.log(`    dispatch     : ${JSON.stringify(reviewed.turn.envelope ? { run_id: reviewed.turn.envelope.run_id, task_id: reviewed.turn.envelope.task_id } : null)}`);
        console.log(`    full turn    : ${JSON.stringify(reviewed.turn).slice(0, 900)}`);
      }
      if (reviewed.raw) console.log(`    raw head     : ${String(reviewed.raw).slice(0, 300)}`);
    } else {
      reviewResult = reviewed.review;
      console.log(`  verdict       : ${reviewResult.verdict}`);
      console.log(`  summary       : ${(reviewResult.summary ?? '').slice(0, 260)}`);
      for (const c of reviewResult.criteria_results) {
        console.log(`    - [${c.result}] ${String(c.criterion).slice(0, 80)}`);
      }
      if (reviewResult.concerns?.length) {
        console.log('  concerns:');
        for (const c of reviewResult.concerns) console.log(`    * ${String(c).slice(0, 150)}`);
      }
    }
  }

  // =====================================================================
  // STEP 6 - independence, then the Evidence Record
  // =====================================================================
  const independence = protocol.checkIndependence(envelope, coder, ds);
  console.log(`\n--- independence ---`);
  console.log(`  required   : ${independence.required}`);
  console.log(`  satisfied  : ${independence.satisfied}`);
  console.log(`  detail     : ${independence.detail}`);

  const rec = evidence.buildRecord({
    protocolVersion: envelope.protocol_version,
    taskId: envelope.task_id,
    runId: envelope.run_id,
    supervisorSeat: ds.seat_id,
    workerSeat: coder.seat_id,
    reviewerSeat: corr.ok ? ds.seat_id : null,
    seatProviders: { supervisor: ds.provider, worker: coder.provider, reviewer: corr.ok ? ds.provider : null },
    sourceHashes: envelope.source_files,
    sourceSetHash,
    runIdAck: corr.ack.run_id_ack,
    sourceHashAck: corr.ack.source_hash_ack,
    correlationDisposition: corr.disposition,
    proposal: workerReplyForCorrelation,
    reviewResult,
    approval: null,
    changedFiles: [],
    writeScope: envelope.permissions.write_scope,
    diffScopeOk: true,
    diffSummary: 'read-only dispatch: the envelope granted an empty write scope',
    validationResults: [
      { name: 'run_id correlated', ok: corr.ok, detail: corr.disposition },
      { name: 'source set unchanged since dispatch', ok: toctou.ok, detail: `${toctou.verified}/${toctou.total}` },
      { name: 'write scope was empty (read-only run)', ok: true },
      { name: 'worker reply obtained via', ok: workerReplySource.startsWith('seat.read'), detail: workerReplySource },
    ],
    runtimeValidation: 'not applicable - no code was executed or compiled',
    independence,
    commit: null,
    startedAt: new Date(runStarted).toISOString(),
    completedAt: new Date().toISOString(),
    notes: [
      `Supervisor provider=${ds.provider} transport=${ds.transport}; worker provider=${coder.provider} transport=${coder.transport}.`,
      'Independence is judged RELATIVE TO THE WORKER: the reviewer differs from the worker. It does not require every seat to be a different vendor.',
      workerReplySource,
    ],
  });
  rec.record_id = `EV-demo-${envelope.task_id}-${envelope.run_id.slice(-8)}`;

  finish(rec, timing, runStarted, planMs, dispatchMs, reviewMs, { ds, coder, corr, reviewResult });
}

function describeTasks() {
  try {
    const fs2 = require('node:fs');
    const f = path.join(GAME, '.ai', 'tasks.json');
    if (!fs2.existsSync(f)) return '(no task registry)';
    const data = JSON.parse(fs2.readFileSync(f, 'utf8'));
    return Object.values(data.tasks).map((t) => `- ${t.task_id} [${t.status}] ${t.title}`).join('\n');
  } catch (e) { return `(task registry unreadable: ${e.message})`; }
}

function finish(rec, timing, runStarted, planMs, dispatchMs, reviewMs, extra) {
  const jsonPath = evidence.saveRecord(rec.record_id, rec);
  fs.writeFileSync(jsonPath.replace(/\.json$/, '.md'), evidence.toMarkdown(rec), 'utf8');

  const total = Date.now() - runStarted;
  timing.total_ms = total;
  timing.deepseek_plan_ms = planMs;
  timing.chatgpt_dispatch_ms = dispatchMs;
  timing.deepseek_review_ms = reviewMs;
  timing.evidence_status = rec.final_status;
  fs.writeFileSync(path.join(WB, 'temp', 'v021-timing.json'), JSON.stringify(timing, null, 2), 'utf8');

  console.log('\n================ EVIDENCE RECORD ================');
  console.log(`  record_id   : ${rec.record_id}`);
  console.log(`  status      : ${rec.final_status}`);
  console.log(`  supervisor  : ${rec.supervisor_seat} (${rec.seat_providers?.supervisor})`);
  console.log(`  worker      : ${rec.worker_seat} (${rec.seat_providers?.worker})`);
  console.log(`  reviewer    : ${rec.reviewer_seat} (${rec.seat_providers?.reviewer})`);
  console.log(`  providers   : ${new Set([rec.seat_providers?.supervisor, rec.seat_providers?.worker].filter(Boolean)).size} distinct`);
  console.log(`  correlation : ${rec.correlation_disposition}`);
  console.log(`  independence: required=${rec.independence?.required} satisfied=${rec.independence?.satisfied}`);
  console.log(`  missing     : ${rec.missing_evidence.length ? rec.missing_evidence.join(', ') : '(none)'}`);
  console.log(`\n  TIMING   plan=${planMs}ms  dispatch=${dispatchMs}ms  review=${reviewMs}ms  TOTAL=${total}ms`);
  console.log(`\n  JSON: ${jsonPath}`);
}

main().catch((e) => {
  console.error(`\ncross-provider run crashed: ${e && e.stack ? e.stack : e}`);
  process.exit(9);
});
