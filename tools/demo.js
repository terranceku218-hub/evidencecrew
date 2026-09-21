'use strict';
/**
 * demo.js - the 30-second walkthrough, honestly labelled.
 *
 * WHAT THIS IS
 *   A local, offline demonstration of the beats the product is built around: a goal, a task with
 *   criteria, a worker result, a request for revision, a passing result, and a receipt. It uses the
 *   demo project's own two test suites as the subject matter, so what it shows is REAL - the shipped
 *   code really does fail its own tests, and the corrected reference really does pass them.
 *
 * WHAT THIS IS NOT, AND SAYS SO ON SCREEN
 *   It does not run agents. There is no API key and no browser involved, so no model is called and no
 *   Evidence Record is produced by this script. Claiming otherwise would be exactly the kind of thing
 *   this project exists to prevent: a green tick for something that never happened. The final screen
 *   states the difference in plain words, and points at `npm start` for the real flow.
 *
 * USAGE
 *   npm run demo        (or: node tools/demo.js)
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEMO = path.join(REPO_ROOT, 'examples', 'demo-project');

const line = (s = '') => console.log(s);
const rule = () => line('-'.repeat(74));
const pause = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore' });

function beat(seconds, title, detail) {
  line(`  [${seconds}] ${title}`);
  if (detail) line(`          ${detail}`);
}

function runSuite(file, label) {
  const abs = path.join(DEMO, file);
  if (!fs.existsSync(abs)) return { ok: false, output: `missing: ${file}` };
  const r = spawnSync(process.execPath, [abs], { cwd: DEMO, encoding: 'utf8' });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const summary = output.split('\n').filter((l) => /passed/.test(l)).pop() ?? '(no summary line)';
  line(`  ${label}`);
  line(`    ${summary.trim()}`);
  return { ok: r.status === 0, output, summary: summary.trim() };
}

line('');
line('='.repeat(74));
line('  EvidenceCrew - 30-second walkthrough (local, offline, no key, no browser)');
line('='.repeat(74));
line('');
line('  The subject is a deliberately tiny project that ships with one real bug:');
line('  examples/demo-project. Its own test suite proves the bug is real.');
line('');
rule();
line('  THE BEATS THE PRODUCT IS BUILT AROUND');
rule();
beat('0-5 s', 'A human enters a Goal', 'not a chat message: a goal with a scope and a deliverable');
beat('5-10 s', 'The supervisor writes a Task', 'with explicit success criteria, before any worker runs');
beat('10-17 s', 'A worker returns a result', 'carrying the run id and source hash it was dispatched with');
beat('17-21 s', 'The supervisor reviews it', 'and answers RETRY, naming the criterion that was not met');
beat('21-26 s', 'The worker revises', 'with that criticism attached to the new instruction');
beat('26-30 s', 'PASS, then Evidence', 'a receipt: what was recorded, what was not, and by whom');
line('');
line('  Retry is the beat that matters. Any tool can show a green tick; only a');
line('  reviewing loop can show a rejection with a reason, and a second attempt');
line('  that passes because the work improved.');
line('');
rule();
line('  THE SAME SHAPE, RUN LOCALLY AGAINST THE DEMO PROJECT');
rule();
line('');

line('  Beat 1-2: the task the supervisor would dispatch is "make the pulse colour');
line('  return to its true baseline, and prove it with the shipped suite".');
line('  Run against the code as shipped:');
line('');
const before = runSuite('test/pulse.test.js', 'node test/pulse.test.js');
line('');
line('  That is the RETRY. Two of the suite checks fail, and the failures are the');
line('  bug itself: an overlapping pulse captures a mid-flash tint as its baseline.');
line('');
pause(400);

line('  Beat 3-5: the worker returns a corrected implementation. The repository');
line('  ships that corrected reference too, so the claim is checkable:');
line('');
const after = runSuite('test/pulse.fixed.test.js', 'node test/pulse.fixed.test.js');
line('');
line('  That is the PASS, and it is earned rather than asserted: the same checks');
line('  that failed a moment ago now pass against the corrected file.');
line('');
pause(400);

rule();
line('  WHAT THIS SCRIPT DID AND DID NOT DO');
rule();
line(`  DID      run the demo project's two suites from ${path.relative(REPO_ROOT, DEMO)}`);
line(`           the shipped suite failed as designed: ${before.ok ? 'NO - it passed, which means the bug is gone' : 'yes'}`);
line(`           the corrected reference passed:    ${after.ok ? 'yes' : 'NO'}`);
line('  DID NOT  call any model, open a browser, spend a subscription turn, or');
line('           write an Evidence Record. There is nothing to notarise here.');
line('');
line('  To see the real thing - a Goal dispatched to a real worker, reviewed, and');
line('  recorded with a receipt - start the workbench:');
line('');
line('      npm run setup      # reports what is missing, if anything');
line('      npm start          # http://127.0.0.1:3099');
line('');
line("  Don't trust Done. Verify it.");
line('');
line('='.repeat(74));
line('');

process.exit(before.ok === false && after.ok === true ? 0 : 1);
