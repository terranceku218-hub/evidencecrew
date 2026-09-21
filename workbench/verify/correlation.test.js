'use strict';
/**
 * correlation.test.js - synthetic tests for the immutable correlation snapshot.
 *
 * Per the brief, these are targeted fixtures: no ChatGPT call, no Codex call, no browser, no network.
 * They prove the matching rule is strict and that the expected value cannot move.
 *
 * Required cases:
 *   matching id           -> CORRELATED
 *   wrong run id          -> rejected
 *   wrong thread          -> rejected
 *   wrong turn            -> rejected
 *   stale reply           -> rejected
 * Plus: the snapshot is frozen, the trace is attributable, and no secrets appear in it.
 */

const path = require('node:path');
const WB = path.resolve(__dirname, '..', '..', 'workbench');
const P = require(path.join(WB, 'protocol', 'protocol.js'));
const CORR = require(path.join(WB, 'protocol', 'correlation.js'));
const R = require(path.join(WB, 'protocol', 'renderers.js'));

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name} :: ${detail}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const GAME = (process.env.AWB_PROJECT_ROOT || path.resolve(__dirname, '..', '..', 'examples', 'demo-project'));

function fixture() {
  const built = P.buildEnvelope({
    taskId: 'CORR-001', projectId: 'demo', workspaceId: 'default', seatId: 'seat:t/reviewer',
    projectRoot: GAME, sourceRelPaths: ['src/hud-pulse.js'],
  });
  const env = built.envelope;
  const snap = CORR.captureRunSnapshot({ envelope: env });
  const ids = CORR.captureTransportIds('THREAD-AAA', 'TURN-BBB');
  const exp = CORR.effectiveExpectation(snap, ids);
  const ack = (over = {}) => {
    const runId = 'run_id' in over ? over.run_id : exp.run_id;
    const src = 'source_hash' in over ? over.source_hash : exp.source_hash;
    return `RUN_ID_ACK: ${runId}\nSOURCE_HASH_ACK: ${src}\nverdict here`;
  };
  return { env, snap, ids, exp, ack };
}

function main() {
  section('A. the snapshot is immutable');
  {
    const { snap, exp } = fixture();
    check('run snapshot is frozen', Object.isFrozen(snap));
    check('effective expectation is frozen', Object.isFrozen(exp));
    let threw = false;
    try { snap.run_id = 'TAMPERED'; } catch { threw = true; }
    check('writing to the snapshot throws (or is rejected) in strict mode', threw || snap.run_id !== 'TAMPERED',
      `run_id=${snap.run_id}`);
    check('the recorded expectation is unchanged after an attempted write',
      snap.run_id === exp.run_id, `${snap.run_id} vs ${exp.run_id}`);
    check('the snapshot records where the expectation came from', typeof snap.source === 'string' && snap.source.length > 0, snap.source);
  }

  section('B. correlation outcomes (strict, no normalisation)');
  {
    const f = fixture();

    const okRes = P.correlateWithSnapshot(f.env, f.exp, f.ack());
    check('matching run_id + source hash -> CORRELATED', okRes.disposition === 'CORRELATED', JSON.stringify(okRes.mismatched_fields));

    const wrongRun = P.correlateWithSnapshot(f.env, f.exp, f.ack({ run_id: 'RUN-00000000000000-totally-different' }));
    check('wrong run id -> rejected', wrongRun.ok === false && wrongRun.mismatched_fields.includes('run_id'),
      JSON.stringify(wrongRun.mismatched_fields));
    check('wrong run id is labelled CORRELATION_MISMATCH', wrongRun.disposition === 'CORRELATION_MISMATCH', wrongRun.disposition);

    // Case difference must now FAIL: no case-insensitive tolerance is permitted.
    const caseDiff = P.correlateWithSnapshot(f.env, f.exp, f.ack({ run_id: f.exp.run_id.toUpperCase() }));
    check('a case-different run id is REJECTED (no case-insensitive tolerance)', caseDiff.ok === false,
      `disposition=${caseDiff.disposition}`);

    // An extra token must fail too: no substring matching.
    const extra = P.correlateWithSnapshot(f.env, f.exp, f.ack({ run_id: `${f.exp.run_id}-EXTRA` }));
    check('a run id with an extra token is REJECTED (no substring matching)', extra.ok === false, extra.disposition);

    const wrongThread = P.correlateWithSnapshot(f.env, f.exp, f.ack(), { receivedThreadId: 'THREAD-ZZZ' });
    check('wrong thread id -> rejected', wrongThread.ok === false && wrongThread.mismatched_fields.includes('thread_id'),
      JSON.stringify(wrongThread.mismatched_fields));

    const wrongTurn = P.correlateWithSnapshot(f.env, f.exp, f.ack(), { receivedThreadId: 'THREAD-AAA', receivedTurnId: 'TURN-ZZZ' });
    check('wrong turn id -> rejected', wrongTurn.ok === false && wrongTurn.mismatched_fields.includes('turn_id'),
      JSON.stringify(wrongTurn.mismatched_fields));

    const staleReply = P.correlateWithSnapshot(f.env, f.exp, 'I finished the task, all good.');
    check('stale/ack-less reply -> rejected', staleReply.ok === false, staleReply.disposition);
    check('an ack-less reply is MISSING_ACK, never silently accepted',
      staleReply.mismatched_fields.some((m) => m.startsWith('run_id_ack')), JSON.stringify(staleReply.mismatched_fields));

    const wrongSource = P.correlateWithSnapshot(f.env, f.exp, f.ack({ source_hash: 'deadbeef'.repeat(8) }));
    check('wrong source hash -> rejected', wrongSource.ok === false && wrongSource.mismatched_fields.includes('source_hash_ack'),
      JSON.stringify(wrongSource.mismatched_fields));
  }

  section('C. the trace is attributable, and carries no secrets');
  {
    const f = fixture();
    const bad = P.correlateWithSnapshot(f.env, f.exp, f.ack({ run_id: 'RUN-WRONG-0000000000' }));
    const t = bad.trace;
    for (const k of ['expected_run_id', 'received_run_id_ack', 'expected_thread_id', 'received_thread_id',
      'expected_turn_id', 'received_turn_id', 'expected_source_hash', 'received_source_hash_ack', 'expected_source']) {
      check(`trace carries ${k}`, k in t, Object.keys(t).join(','));
    }
    check('the trace names the mismatching field', bad.mismatched_fields.length > 0, JSON.stringify(bad.mismatched_fields));
    const traceJson = JSON.stringify(t);
    check('the trace contains no credential-ish or prompt-ish payload',
      !/token|secret|password|api[_-]?key|BEGIN |SOURCECONTENT/i.test(traceJson), traceJson.slice(0, 200));

    // Every renderer still emits an ack the snapshot can verify.
    for (const id of Object.keys(R.RENDERERS)) {
      const text = R.render(f.env, { renderer: id }).text;
      const res = P.correlateWithSnapshot(f.env, f.exp, `${text}\nRUN_ID_ACK: ${f.exp.run_id}\nSOURCE_HASH_ACK: ${f.exp.source_hash}`);
      check(`renderer "${id}" produces a packet whose ack correlates`, res.ok === true, res.disposition);
    }
  }

  section('D. the expectation cannot be re-derived from a mutable envelope');
  {
    const f = fixture();
    // Simulate the stale-value bug: mutate the envelope AFTER the snapshot was taken.
    f.env.run_id = 'RUN-MUTATED-AFTER-DISPATCH';
    const res = P.correlateWithSnapshot(f.env, f.exp, f.ack());
    check('correlation still uses the FROZEN expectation, not the mutated envelope',
      res.ok === true, `disposition=${res.disposition} mismatched=${JSON.stringify(res.mismatched_fields)}`);
    check('the frozen expectation still holds the original id',
      f.exp.run_id.startsWith('RUN-') && f.exp.run_id !== 'RUN-MUTATED-AFTER-DISPATCH', f.exp.run_id);
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  if (failures.length) { console.log('  failures:'); for (const f of failures) console.log(`   - ${f}`); console.log(''); }
  process.exit(failures.length ? 1 : 0);
}

main();
