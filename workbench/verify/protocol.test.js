'use strict';
/**
 * protocol.test.js - V0.2 regression suite for seats, the transport contract, the envelope and the
 * Evidence Record.
 *
 * SCOPE, PER THE TEST POLICY
 *   This is the CORE_CHANGE suite for the seat and protocol layers. It touches no harness code and
 *   drives no browser, so it runs in seconds. The DAILY tier still runs zero module suites; this one
 *   is for a round that changed the workbench, the seat layer or the protocol - which is exactly this
 *   round.
 *
 * WHAT IT IS DESIGNED TO CATCH
 *   The claims V0.2 makes are architectural, so the tests target the properties that would quietly
 *   become false: a transport that stops satisfying the contract, a renderer that forgets the ack
 *   block, a reply that correlates when it should not, an independence check that passes when both
 *   seats share a provider, and an Evidence Card that renders a tick for something nobody recorded.
 */

const path = require('node:path');
const fs = require('node:fs');

const WB = path.resolve(__dirname, '..', '..', 'workbench');
const P = require(path.join(WB, 'protocol', 'protocol.js'));
const R = require(path.join(WB, 'protocol', 'renderers.js'));
const C = require(path.join(WB, 'protocol', 'transport-contract.js'));
const E = require(path.join(WB, 'protocol', 'evidence.js'));
const CARD = require(path.join(WB, 'protocol', 'evidence-card.js'));
const RUNS = require(path.join(WB, 'protocol', 'runs.js'));
const seatModule = require(path.join(WB, 'seats', 'seat.js'));
const registryModule = require(path.join(WB, 'seats', 'registry.js'));
const { createHumanTransport } = require(path.join(WB, 'transports', 'transport.human.js'));
const { createOpenAiHttpTransport } = require(path.join(WB, 'transports', 'transport.openai-http.js'));
const { createPlaywrightDomTransport } = require(path.join(WB, 'transports', 'transport.playwright-dom.js'));

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name} :: ${detail}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const GAME = (process.env.AWB_PROJECT_ROOT || path.resolve(__dirname, '..', '..', 'examples', 'demo-project'));

/** A seat over an arbitrary transport, for tests that do not need a real one. */
function seatOver(transport, extra = {}) {
  return seatModule.createSeat({
    seatId: extra.seatId ?? 'seat:test/a',
    role: extra.role ?? 'coder',
    transport,
    projectId: 'demo',
    workspaceId: 'default',
    permissions: extra.permissions,
  });
}

async function main() {
  // ======================================================================
  section('A. Transport contract conformance (the executable form of "transport-neutral")');
  {
    const results = registryModule.conformance();
    for (const r of results) {
      check(`transport ${r.transport} satisfies the contract`, r.ok, r.problems.join('; '));
    }
    check('at least three transports are conformance-checked', results.length >= 3, `got ${results.length}`);

    // A deliberately broken transport must FAIL, or the check proves nothing.
    const broken = {
      id: 'broken', kind: 'x', provider: 'y',
      capabilities: {},
      open: async () => ({ ok: true }), health: async () => ({ ok: true }),
      // dispatch and observe missing on purpose
      read: async () => ({ ok: true }),
    };
    const verdict = C.checkContract(broken);
    check('a transport missing dispatch/observe FAILS conformance',
      verdict.ok === false && verdict.problems.some((p) => p.includes('dispatch')),
      JSON.stringify(verdict.problems));

    // A transport that branches on provider name inside itself must be flagged.
    const tmp = path.join(WB, 'temp', 'provider-branch-probe.js');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp,
      'function t(){ if (seat.provider === "chatgpt") { return 1; } return 2; }\n', 'utf8');
    const branchy = { ...broken, dispatch: async () => ({}), observe: async () => ({}), sourceFile: tmp };
    const bv = C.checkContract(branchy, { sourceFile: tmp });
    check('provider-name branching inside a transport is flagged',
      bv.problems.some((p) => p.includes('branches on provider')),
      JSON.stringify(bv.problems));
    fs.unlinkSync(tmp);
  }

  // ======================================================================
  section('B. Seat schema: provider and transport are independent axes');
  {
    const b = registryModule.buildRegistry('demo', 'default');
    check('the registry builds seats', b.seats.length >= 2, `built ${b.seats.length}`);

    const kinds = new Set(b.seats.map((s) => s.transport));
    check('buildable seats span MORE THAN ONE transport kind', kinds.size >= 2, [...kinds].join(','));

    const coder = b.byRole('coder');
    const sup = b.byRole('supervisor');
    check('a seat carries provider AND transport as separate fields',
      typeof coder.provider === 'string' && typeof coder.transport === 'string',
      `${coder.provider} / ${coder.transport}`);
    check('two seats with the same role differ by transport',
      coder.transport !== sup.transport, `${coder.transport} vs ${sup.transport}`);
    check('the coder seat is chatgpt over a DOM transport',
      coder.provider === 'chatgpt' && coder.transport === 'playwright-dom',
      `${coder.provider}/${coder.transport}`);

    for (const f of ['seat_id', 'role', 'provider', 'transport', 'project_id', 'workspace_id',
      'conversation', 'capabilities', 'permissions', 'health', 'rounds', 'delivery_state', 'current_task']) {
      check(`seat exposes ${f}`, f in coder, Object.keys(coder).join(','));
    }

    // The transport object must not leak into the seat's public view.
    const v = seatModule.view(coder);
    check('the seat view does NOT expose the transport object', !('_transport' in v), Object.keys(v).join(','));

    check('the unconnected HTTP seat is declared but reported unavailable',
      b.unavailable.some((u) => /http/.test(u.seat_id)) && !b.seats.some((s) => /http/.test(s.seat_id)),
      JSON.stringify(b.unavailable.map((u) => u.seat_id)));
  }

  // ======================================================================
  section('C. A seat refuses to carry the wrong envelope');
  {
    const human = createHumanTransport({ id: 'test:human' });
    const seat = seatOver(human);
    const built = P.buildEnvelope({
      taskId: 'T-REFUSE', projectId: 'demo', workspaceId: 'default',
      seatId: 'seat:NOT-THIS-ONE', sourceRelPaths: [],
    });
    const r = await seatModule.dispatch(seat, built.envelope);
    check('dispatching an envelope addressed to another seat is REFUSED',
      r.ok === false && r.refused === true, JSON.stringify(r).slice(0, 160));
  }

  // ======================================================================
  section('D. Renderers: the envelope is data, the packet is generated');
  {
    const built = P.buildEnvelope({
      taskId: 'T-RENDER', projectId: 'demo', workspaceId: 'default', seatId: 'seat:test/a',
      projectRoot: GAME, sourceRelPaths: ['src/hud-pulse.js'],
      successCriteria: ['say how timing is computed'],
      reviewRequirements: { independent_provider: true },
    });
    const env = built.envelope;

    for (const id of Object.keys(R.RENDERERS)) {
      const out = R.render(env, { renderer: id });
      check(`renderer "${id}" emits RUN_ID_ACK and SOURCE_HASH_ACK`,
        out.text.includes('RUN_ID_ACK') && out.text.includes('SOURCE_HASH_ACK'),
        `${out.text.length} chars`);
      check(`renderer "${id}" embeds the real run id`, out.text.includes(env.run_id), 'run id missing');
    }

    const human = R.render(env, { renderer: 'human' });
    const structured = R.render(env, { renderer: 'structured' });
    check('two renderers produce DIFFERENT packets for the SAME envelope',
      human.text !== structured.text, 'renderers are identical');
    check('the envelope is unchanged by rendering',
      JSON.stringify(env) === JSON.stringify(built.envelope), 'render mutated the envelope');

    // Renderers must be pure: same input, same output, twice.
    const again = R.render(env, { renderer: 'structured' });
    check('rendering is deterministic', again.text === structured.text, 'output differed between calls');
  }

  // ======================================================================
  section('E. Correlation: run_id_ack decides, and mismatch is quarantined');
  {
    const built = P.buildEnvelope({
      taskId: 'T-CORR', projectId: 'demo', workspaceId: 'default', seatId: 'seat:test/a',
      projectRoot: GAME, sourceRelPaths: ['src/hud-pulse.js'],
    });
    const env = built.envelope;
    const setHash = P.hashSourceSet(env.source_files.filter((f) => f.sha256 !== null));

    const good = P.checkCorrelation(env, `RUN_ID_ACK: ${env.run_id}\nSOURCE_HASH_ACK: ${setHash}\nhere is the answer`);
    check('a matching ack correlates', good.ok === true && good.disposition === 'CORRELATED', good.disposition);

    const wrongRun = P.checkCorrelation(env, `RUN_ID_ACK: RUN-OTHER-999\nSOURCE_HASH_ACK: ${setHash}\nanswer`);
    check('a WRONG run_id is quarantined as STALE_OR_UNCORRELATED_REPLY',
      wrongRun.ok === false && wrongRun.status === P.RUN_STATUS.STALE_OR_UNCORRELATED_REPLY,
      `${wrongRun.status}/${wrongRun.disposition}`);
    check('a wrong run_id is reported as RUN_ID_MISMATCH', wrongRun.disposition === 'RUN_ID_MISMATCH', wrongRun.disposition);

    const noAck = P.checkCorrelation(env, 'I did the thing, all good.');
    check('a reply with NO ack is quarantined, never assumed',
      noAck.ok === false && noAck.disposition === 'MISSING_ACK', noAck.disposition);

    const wrongSource = P.checkCorrelation(env, `RUN_ID_ACK: ${env.run_id}\nSOURCE_HASH_ACK: 0000deadbeef\nanswer`);
    check('a wrong SOURCE_HASH_ACK is refused as SOURCE_CHANGED_SINCE_REVIEW',
      wrongSource.ok === false && wrongSource.status === P.RUN_STATUS.SOURCE_CHANGED_SINCE_REVIEW,
      `${wrongSource.status}/${wrongSource.disposition}`);
  }

  // ======================================================================
  section('F. TOCTOU: the source must not move under a run');
  {
    const tmpDir = path.join(WB, 'temp', 'toctou');
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, 'subject.txt');
    fs.writeFileSync(file, 'version one\n', 'utf8');

    const files = P.captureSourceFiles(tmpDir, ['subject.txt']);
    check('a captured source file has a sha256', !!files[0].sha256, JSON.stringify(files[0]));

    const same = P.verifySourceUnchanged(tmpDir, files);
    check('unchanged source verifies', same.ok === true && same.verified === 1, JSON.stringify(same));

    fs.writeFileSync(file, 'version two - edited while the worker was thinking\n', 'utf8');
    const changed = P.verifySourceUnchanged(tmpDir, files);
    check('a source edited mid-run FAILS verification',
      changed.ok === false && changed.status === P.RUN_STATUS.SOURCE_CHANGED_SINCE_REVIEW,
      JSON.stringify(changed));
    check('the change is reported per file with both hashes',
      changed.changed.length === 1 && changed.changed[0].at_dispatch !== changed.changed[0].now,
      JSON.stringify(changed.changed));

    // A file that was absent at dispatch and is absent now is consistent, not a change.
    const ghost = P.captureSourceFiles(tmpDir, ['never-existed.txt']);
    check('a file absent at dispatch is recorded as absent, not omitted',
      ghost[0].sha256 === null && ghost[0].present_at_dispatch === false, JSON.stringify(ghost[0]));
    check('absent-then-absent is not treated as a change',
      P.verifySourceUnchanged(tmpDir, ghost).ok === true, 'absent file reported as changed');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ======================================================================
  section('G. Independence: a second seat is not automatically an independent review');
  {
    const envSame = { review_requirements: { required: true, independent_provider: true } };
    const same = P.checkIndependence(envSame, { provider: 'chatgpt' }, { provider: 'chatgpt' });
    check('same provider -> NOT satisfied', same.satisfied === false, JSON.stringify(same));
    check('the refusal names INDEPENDENCE NOT SATISFIED',
      /INDEPENDENCE NOT SATISFIED/.test(same.detail), same.detail);

    const diff = P.checkIndependence(envSame, { provider: 'chatgpt' }, { provider: 'deepseek' });
    check('different providers -> satisfied', diff.satisfied === true, JSON.stringify(diff));

    const notRequired = P.checkIndependence({ review_requirements: { independent_provider: false } },
      { provider: 'a' }, { provider: 'a' });
    check('when independence is not required it is reported as not required, not as satisfied',
      notRequired.required === false && notRequired.satisfied === null, JSON.stringify(notRequired));

    const noReviewer = P.checkIndependence(envSame, { provider: 'chatgpt' }, null);
    check('required but no reviewer -> NOT satisfied',
      noReviewer.satisfied === false && /no reviewer/.test(noReviewer.detail), noReviewer.detail);
  }

  // ======================================================================
  section('H. Delivery state machine: no path back to a send');
  {
    check('IDLE -> SUBMITTING is legal', C.isLegalTransition('IDLE', 'SUBMITTING'));
    check('SUBMITTING -> SEND_PENDING is legal', C.isLegalTransition('SUBMITTING', 'SEND_PENDING'));
    check('SEND_PENDING -> USER_TURN_CONFIRMED is legal', C.isLegalTransition('SEND_PENDING', 'USER_TURN_CONFIRMED'));
    check('SEND_PENDING -> SEND_UNCERTAIN is legal', C.isLegalTransition('SEND_PENDING', 'SEND_UNCERTAIN'));

    check('SEND_PENDING -> SUBMITTING (a silent re-send) is ILLEGAL',
      C.isLegalTransition('SEND_PENDING', 'SUBMITTING') === false, 're-send path exists');
    check('COMPLETE -> SUBMITTING is ILLEGAL', C.isLegalTransition('COMPLETE', 'SUBMITTING') === false);
    check('SEND_UNCERTAIN has NO outgoing transitions',
      (C.LEGAL_TRANSITIONS.SEND_UNCERTAIN ?? []).length === 0, JSON.stringify(C.LEGAL_TRANSITIONS.SEND_UNCERTAIN));

    for (const st of ['SUBMITTING', 'SEND_PENDING', 'USER_TURN_CONFIRMED', 'ASSISTANT_PENDING', 'SEND_UNCERTAIN']) {
      const r = C.mayRedispatch(st);
      check(`re-dispatch is REFUSED from ${st}`, r.allowed === false, JSON.stringify(r));
    }

    // An illegal transition must be rejected by the seat, not silently applied.
    const human = createHumanTransport({ id: 'test:illegal' });
    const seat = seatOver(human);
    seatModule.bindRun(seat, { run_id: 'R1', task_id: 'T1' });
    const bad = seatModule.setDeliveryState(seat, 'COMPLETE', 'skipping the middle');
    check('an illegal transition is rejected with the legal set named',
      bad.ok === false && Array.isArray(bad.legal), JSON.stringify(bad).slice(0, 160));
  }

  // ======================================================================
  section('I. Evidence Record: absent data cannot become a tick');
  {
    const empty = E.buildRecord({ taskId: 'T-EMPTY', runId: 'R-EMPTY', writeScope: ['a.cs'] });
    check('a record with nothing recorded is UNVERIFIED',
      empty.final_status === E.EVIDENCE_STATUS.UNVERIFIED, empty.final_status);
    check('a WRITABLE record with nothing recorded lists the source and commit gaps',
      empty.missing_evidence.includes('run_id_ack')
      && empty.missing_evidence.includes('source_hashes')
      && empty.missing_evidence.includes('commit'),
      empty.missing_evidence.join(','));

    // A READ-ONLY task genuinely has no source set to hash and no commit to make. Listing those as
    // missing would inflate the gap and train the reader to ignore the list, so they are not
    // demanded - and that difference is asserted rather than assumed.
    const readOnly = E.buildRecord({ taskId: 'T-RO', runId: 'R-RO', writeScope: [] });
    check('a READ-ONLY record does NOT demand source hashes or a commit',
      !readOnly.missing_evidence.includes('source_hashes')
      && !readOnly.missing_evidence.includes('source_hash_ack')
      && !readOnly.missing_evidence.includes('commit'),
      readOnly.missing_evidence.join(','));

    const card = CARD.buildCard(empty);
    const ackEl = card.elements.find((e) => e.key === 'run_correlation');
    check('the card shows an ABSENT correlation as a dash, never a tick',
      ackEl.mark === CARD.MARKS.ABSENT && ackEl.symbol !== '\u2713', `${ackEl.mark} ${ackEl.symbol}`);

    const rt = CARD.buildCard(E.buildRecord({ runtimeValidation: 'RUNTIME VERIFIED = NO' }))
      .elements.find((e) => e.key === 'runtime_validation');
    check('"RUNTIME VERIFIED = NO" renders as a problem, not a tick',
      rt.mark === CARD.MARKS.BAD, `${rt.mark} ${rt.value}`);

    // A fully-populated record must reach VERIFIED.
    const full = E.buildRecord({
      taskId: 'T-FULL', runId: 'R-FULL', workerSeat: 'seat:w', reviewerSeat: 'seat:r',
      sourceHashes: [{ path: 'a.cs', sha256: 'abc' }],
      runIdAck: 'R-FULL', sourceHashAck: 'abc', correlationDisposition: 'CORRELATED',
      proposal: 'the proposal', reviewResult: { verdict: 'PASS' }, approval: 'APPROVED',
      validationResults: [{ name: 'syntax', ok: true }], diffScopeOk: true, commit: 'abc123',
      independence: { required: true, satisfied: true },
    });
    check('a fully evidenced record is VERIFIED', full.final_status === E.EVIDENCE_STATUS.VERIFIED, full.final_status);
    check('a VERIFIED record has no missing evidence', full.missing_evidence.length === 0, full.missing_evidence.join(','));

    // An uncorrelated record must never be VERIFIED, however complete it otherwise looks.
    const uncorr = E.buildRecord({
      taskId: 'T-UNCORR', runId: 'R-UNCORR', workerSeat: 'seat:w',
      sourceHashes: [{ path: 'a.cs', sha256: 'abc' }],
      correlationDisposition: 'RUN_ID_MISMATCH',
      proposal: 'p', reviewResult: {}, approval: 'APPROVED',
      validationResults: [{ name: 'x', ok: true }], diffScopeOk: true, commit: 'c',
    });
    check('an uncorrelated record is UNVERIFIED even when everything else is present',
      uncorr.final_status === E.EVIDENCE_STATUS.UNVERIFIED, uncorr.final_status);
  }

  // ======================================================================
  section('J. The orchestrator: ordering, refusals and the produced record');
  {
    // A tiny HTTP transport backed by a local stub server: this is the SECOND, non-browser transport
    // exercised end to end, and it is genuinely different in kind from the DOM one.
    const http = require('node:http');
    const stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let prompt = '';
        try { prompt = JSON.parse(body).messages?.[0]?.content ?? ''; } catch { /* ignore */ }
        const runId = (prompt.match(/RUN_ID_ACK:\s*(\S+)/) || [])[1] ?? 'UNKNOWN';
        const srcHash = (prompt.match(/SOURCE_HASH_ACK:\s*(\S+)/) || [])[1] ?? 'UNKNOWN';
        const answer = `RUN_ID_ACK: ${runId}\nSOURCE_HASH_ACK: ${srcHash}\nI read the bound source and report: timing is computed from unscaled delta time.`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'stub-1', choices: [{ message: { content: answer } }], usage: { total_tokens: 42 } }));
      });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const port = stub.address().port;

    const httpTransport = createOpenAiHttpTransport({
      baseUrl: `http://127.0.0.1:${port}`, model: 'stub-1', provider: 'stub-provider',
    });
    const humanTransport = createHumanTransport({ id: 'test:supervisor' });

    // A registry with TWO transports and THREE seats, two of which are non-browser.
    const coderSeat = seatOver(httpTransport, { seatId: 'seat:t/coder', role: 'coder' });
    const reviewerSeat = seatOver(humanTransport, { seatId: 'seat:t/reviewer', role: 'reviewer' });
    const supervisorSeat = seatOver(createHumanTransport({ id: 'test:sup' }), { seatId: 'seat:t/supervisor', role: 'supervisor' });

    const reg = {
      byId: (id) => [coderSeat, reviewerSeat, supervisorSeat].find((s) => s.seat_id === id) ?? null,
      byRole: (r) => [supervisorSeat, coderSeat, reviewerSeat].find((s) => s.role === r) ?? null,
    };

    const orch = RUNS.newOrchestrator({ registry: reg, projectRootOf: () => GAME });

    const opened = await orch.open({
      taskId: 'T-E2E', projectId: 'demo', workspaceId: 'default',
      workerSeatId: 'seat:t/coder',
      sourceRelPaths: ['src/hud-pulse.js'],
      successCriteria: ['report the timing computation'],
      reviewRequirements: { required: true, independent_provider: true },
      request: 'read only',
    });
    check('the run opens and dispatches', opened.ok === true, JSON.stringify(opened).slice(0, 200));
    check('the transport reported a delivery state', !!opened.delivery_state, opened.delivery_state);

    // The HTTP transport answers immediately, so its reply is available.
    const reply = await coderSeat._transport.read(opened.envelope);
    check('the HTTP transport produced a reply', reply.ok === true, reply.detail);

    // ---- a WRONG ack must not reach review ----
    const wrong = await orch.completeFromReply(opened.run_id, 'RUN_ID_ACK: RUN-NOT-MINE\nSOURCE_HASH_ACK: x\nanswer');
    check('a mismatched ack STOPS the run before review',
      wrong.ok === false && wrong.status === P.RUN_STATUS.STALE_OR_UNCORRELATED_REPLY,
      `${wrong.status}/${wrong.disposition}`);
    const afterWrong = orch.get(opened.run_id);
    check('the blocked run is not in AWAITING_REVIEW',
      afterWrong.status === P.RUN_STATUS.STALE_OR_UNCORRELATED_REPLY, afterWrong.status);
    const reviewRefused = orch.recordReview(opened.run_id, { verdict: 'PASS' });
    check('recording a review for an uncorrelated run is REFUSED',
      reviewRefused.ok === false, JSON.stringify(reviewRefused).slice(0, 160));

    // ---- the correct ack proceeds ----
    const ok = await orch.completeFromReply(opened.run_id, reply.text);
    check('a matching ack advances the run to AWAITING_REVIEW',
      ok.ok === true && ok.status === P.RUN_STATUS.AWAITING_REVIEW, JSON.stringify(ok).slice(0, 200));
    check('the reply acks the exact run id', ok.correlation === 'CORRELATED', ok.correlation);

    // ---- independence is CHECKED, not assumed ----
    const rev = orch.recordReview(opened.run_id, { verdict: 'PASS', summary: 'looks right', reviewerSeatId: 'seat:t/reviewer' });
    check('independence between two different providers IS satisfied',
      rev.independence.satisfied === true, JSON.stringify(rev.independence));

    const approval = orch.recordApproval(opened.run_id, { decision: 'APPROVED' });
    check('approval is recorded as data', approval.ok === true && approval.approval.decision === 'APPROVED');

    const fin = orch.finalize(opened.run_id, {
      changedFiles: [], diffSummary: 'read-only task, nothing changed',
      diffScopeOk: true, validationResults: [{ name: 'the reply parses', ok: true }],
      runtimeValidation: 'not applicable - read-only task', commit: null,
    });
    check('an Evidence Record is produced', fin.ok === true, JSON.stringify(fin).slice(0, 160));
    check('the record reaches VERIFIED for a fully evidenced run',
      fin.record.final_status === E.EVIDENCE_STATUS.VERIFIED, fin.record.final_status);
    check('the record carries both ack values',
      fin.record.run_id_ack === opened.envelope.run_id && !!fin.record.source_hash_ack,
      `${fin.record.run_id_ack} / ${fin.record.source_hash_ack}`);
    check('JSON is written and the Markdown view is generated',
      fs.existsSync(fin.json) && fs.existsSync(fin.json.replace(/\.json$/, '.md')), fin.json);

    // ---- the SAME provider on both seats must NOT pass independence ----
    // Both seats sit on the SAME HTTP transport, which is the same provider by construction.
    //
    // NOTE: the worker seat must be a FRESH seat, not the one used above. A seat refuses a second
    // dispatch while a run is in flight - that guard is the anti-duplicate rule, and reusing the seat
    // here made the orchestrator (correctly) refuse to open the run at all. Sharing the TRANSPORT is
    // fine because replies are keyed by run_id; sharing the SEAT is not, and by design.
    const coderSeat2 = seatOver(httpTransport, { seatId: 'seat:s/w2', role: 'coder' });
    const reviewerSameProv = seatOver(httpTransport, { seatId: 'seat:s/r', role: 'reviewer' });
    const sameReg = {
      byId: (id) => ({ 'seat:s/w2': coderSeat2, 'seat:s/r': reviewerSameProv }[id] ?? null),
      byRole: (role) => (role === 'reviewer' ? reviewerSameProv : (role === 'coder' ? coderSeat2 : null)),
    };
    const orch2 = RUNS.newOrchestrator({ registry: sameReg, projectRootOf: () => GAME });
    const o2 = await orch2.open({
      taskId: 'T-SAMEPROV', projectId: 'demo', workspaceId: 'default', workerSeatId: 'seat:s/w2',
      sourceRelPaths: [], reviewRequirements: { required: true, independent_provider: true },
    });
    check('a second run can be opened on a FRESH seat of the same transport', o2.ok === true, JSON.stringify(o2).slice(0, 160));
    const reply2 = await coderSeat2._transport.read(o2.envelope);
    check('the shared transport still serves the second run (replies keyed by run_id)', reply2.ok === true, reply2.detail);
    const c2 = await orch2.completeFromReply(o2.run_id, reply2.text);
    check('the same-provider run reaches review', c2.ok === true, JSON.stringify(c2).slice(0, 160));
    const rev2 = orch2.recordReview(o2.run_id, { verdict: 'PASS', reviewerSeatId: 'seat:s/r' });
    check('the review was recorded', rev2.ok === true, JSON.stringify(rev2).slice(0, 200));
    check('the SAME provider on worker and reviewer is NOT independent',
      rev2.independence?.satisfied === false, JSON.stringify(rev2.independence));
    check('the same-provider refusal says INDEPENDENCE NOT SATISFIED',
      /INDEPENDENCE NOT SATISFIED/.test(rev2.independence?.detail ?? ''), rev2.independence?.detail);
    const fin2 = orch2.finalize(o2.run_id, {
      changedFiles: [], diffScopeOk: true, validationResults: [{ name: 'x', ok: true }],
    });
    check('a record with unsatisfied independence cannot be VERIFIED',
      fin2.record.final_status !== E.EVIDENCE_STATUS.VERIFIED, fin2.record.final_status);
    const card2 = CARD.buildCard(fin2.record);
    check('the card shows INDEPENDENCE NOT SATISFIED as a warning',
      card2.warnings.some((w) => /INDEPENDENCE NOT SATISFIED/.test(w.text)),
      JSON.stringify(card2.warnings.map((w) => w.text.slice(0, 60))));

    stub.close();
  }

  // ======================================================================
  section('K. The legacy record tells the truth about what it does not know');
  {
    const rec = E.loadRecord('EV-demo-GAME-BATTLEUI-002-legacy');
    if (!rec) {
      /**
       * PUBLIC RELEASE CHANGE: this section asserts the shape of a LEGACY record - one backfilled from
       * history that predates the protocol. That fixture is produced by a maintainer script against a
       * private repository, so a fresh clone simply does not have it. Failing here would report a missing
       * fixture as a broken product, and a first-time reader would have no way to tell the difference. The
       * checks are skipped, loudly, and the suite still exits zero because nothing shipped is in question.
       */
      console.log('  SKIP  no legacy record in this checkout: it is produced by a maintainer backfill script');
    } else {
      check('the legacy record is stamped LEGACY_RUN', rec.record_origin === 'LEGACY_RUN', rec.record_origin);
      check('run_id is null, not fabricated', rec.run_id === null, String(rec.run_id));
      check('run_id_ack is null, not fabricated', rec.run_id_ack === null, String(rec.run_id_ack));
      check('source_hash_ack is null, not fabricated', rec.source_hash_ack === null, String(rec.source_hash_ack));
      check('the un-recorded fields are listed as missing',
        rec.missing_evidence.includes('run_id') && rec.missing_evidence.includes('run_id_ack'),
        rec.missing_evidence.join(','));
      check('a real source hash WAS recovered',
        rec.source_hashes?.[0]?.sha256?.length === 64, JSON.stringify(rec.source_hashes?.[0] ?? null));
      check('the commit was recovered from git', /^84f68c9/.test(rec.commit ?? ''), rec.commit);
      check('the legacy record is NOT VERIFIED (it cannot claim correlation)',
        rec.final_status !== E.EVIDENCE_STATUS.VERIFIED, rec.final_status);

      const card = CARD.buildCard(rec);
      const legacyNote = card.warnings.some((w) => /LEGACY_RUN/.test(w.text));
      check('the card surfaces the legacy caveat to the reader', legacyNote, JSON.stringify(card.warnings));
      check('the card never renders a tick for a fabricated ack',
        card.elements.find((e) => e.key === 'run_correlation').symbol !== '\u2713',
        card.elements.find((e) => e.key === 'run_correlation').symbol);
    }
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    console.log('  failures:');
    for (const f of failures) console.log(`   - ${f}`);
    console.log('');
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`\nV0.2 protocol suite crashed: ${e && e.stack ? e.stack : e}\n`);
  process.exit(2);
});
