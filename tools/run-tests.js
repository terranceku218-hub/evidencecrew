'use strict';
/**
 * run-tests.js - the public test entry point: what `npm test` runs.
 *
 * WHY THIS IS NOT THE TIER RUNNER
 *   The maintainer instance has a three-tier runner (DAILY / CORE_CHANGE / RELEASE) whose RELEASE tier
 *   posts real messages to ChatGPT and whose suites assume a registered project and a logged-in browser.
 *   None of that can run in a fresh clone, and a test command that fails on a fresh clone teaches the
 *   reader that the project is broken. This runs the suites that work with NO configuration, NO browser
 *   and NO network, and it skips the rest by name rather than pretending they passed.
 *
 * WHAT IT RUNS
 *   1. the demo project's own suite, which is EXPECTED to fail: the demo ships a real bug on purpose
 *   2. the demo project's fixed reference, which must pass every check
 *   3. the verified task protocol suite: envelope, correlation, evidence, card rendering
 *   4. the correlation suite: immutable snapshots, strict equality, no case-insensitive matching
 *   5. the optional-reviewer suite: review levels, stop conditions, truncation, turn settling
 *   6. the bundled harness YAML parser suite
 *
 * USAGE
 *   node tools/run-tests.js            run everything
 *   node tools/run-tests.js --list     list the suites without running them
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Suites are declared with the file they live in, not with a shell command. A missing file is reported as
 * SKIPPED with the reason rather than crashing the runner: a missing optional suite must not look like a
 * failing one.
 */
const SUITES = [
  {
    id: 'demo-buggy',
    name: 'Demo project, as shipped',
    file: 'examples/demo-project/test/pulse.test.js',
    cwd: 'examples/demo-project',
    expectsFailure: true,
    why: 'the demo ships a real bug on purpose: this suite is EXPECTED to fail until the bug is fixed',
  },
  {
    id: 'demo-fixed',
    name: 'Demo project, corrected reference',
    file: 'examples/demo-project/test/pulse.fixed.test.js',
    cwd: 'examples/demo-project',
    why: 'the corrected reference must pass every check',
  },
  { id: 'protocol', name: 'Verified task protocol', file: 'workbench/verify/protocol.test.js', why: 'envelope, correlation, evidence and card rendering' },
  { id: 'correlation', name: 'Correlation and frozen run snapshots', file: 'workbench/verify/correlation.test.js', why: 'a reply is accepted only when it matches the frozen dispatch snapshot' },
  { id: 'codex-optional', name: 'Optional reviewer policy', file: 'workbench/verify/v03-codex-optional.test.js', why: 'OFF never blocks a goal, and a disabled reviewer is not missing evidence' },
  {
    id: 'i18n',
    name: 'Localisation: key completeness and Evidence semantics',
    file: 'workbench/verify/i18n.test.js',
    why: 'four locales with no missing keys, and NOT RECORDED never translated as unknown or failed',
  },
  {
    id: 'guided-goals',
    name: 'Guided goals: a beginner choice becomes real policy',
    file: 'workbench/verify/guided-goals.test.js',
    why: 'read-only resolves to an EMPTY write scope, ask-before-write resolves approval_required to the permitted paths, and an unknown choice is refused rather than silently defaulted',
  },
  { id: 'harness-yaml', name: 'Bundled harness YAML parser', file: 'runtime/harness/yamltest.js', why: 'project metadata is YAML, and the parser is small and strictly tested' },
];

console.log('=== EVIDENCECREW TEST RUN ===');
console.log(`repository : ${REPO_ROOT}`);
console.log(`node       : ${process.versions.node}`);
console.log('note       : these suites need no API key, no browser and no network\n');

if (process.argv.includes('--list')) {
  for (const s of SUITES) {
    const present = fs.existsSync(path.join(REPO_ROOT, s.file));
    console.log(`  ${present ? 'present' : 'ABSENT '}  ${s.id.padEnd(14)} ${s.file}`);
  }
  process.exit(0);
}

const results = [];
for (const suite of SUITES) {
  const abs = path.join(REPO_ROOT, suite.file);
  if (!fs.existsSync(abs)) {
    results.push({ ...suite, status: 'SKIPPED', detail: 'file not present in this checkout', ms: 0 });
    console.log(`--- ${suite.id} ---\n  SKIPPED (file not present: ${suite.file})\n`);
    continue;
  }
  const cwd = suite.cwd ? path.join(REPO_ROOT, suite.cwd) : REPO_ROOT;
  console.log(`--- ${suite.id} ---`);
  const started = Date.now();
  /**
   * `spawnSync` with inherited stdio rather than captured pipes.
   *
   * Capturing a child's stdout through a pipe has bitten this project before: a grandchild that inherits
   * the pipe keeps it open and the parent waits forever. Inheriting the streams shows output live, which
   * is also what a reader wants from a test runner.
   */
  const r = spawnSync(process.execPath, [abs], { cwd, stdio: 'inherit' });
  const ms = Date.now() - started;
  const ok = suite.expectsFailure ? r.status !== 0 : r.status === 0;
  const status = ok ? 'PASS' : 'FAIL';
  const detail = suite.expectsFailure
    ? (r.status !== 0 ? 'failed as designed: the demo bug is present' : 'unexpectedly passed: the demo bug looks fixed already')
    : (r.status === 0 ? 'all checks passed' : `exit code ${r.status}`);
  results.push({ ...suite, status, detail, ms });
  console.log(`  ${status}: ${detail} (${ms}ms)\n`);
}

const passed = results.filter((x) => x.status === 'PASS').length;
const failed = results.filter((x) => x.status === 'FAIL').length;
const skipped = results.filter((x) => x.status === 'SKIPPED').length;

console.log('================ TEST RESULT ================');
for (const r of results) console.log(`  ${r.status.padEnd(8)} ${r.id.padEnd(14)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed === 0) {
  console.log('\n  Nothing above needed a key, a browser or a network connection.');
  console.log('  The suites that DO need a live session are described in CONTRIBUTING.md.');
}

process.exit(failed ? 1 : 0);
