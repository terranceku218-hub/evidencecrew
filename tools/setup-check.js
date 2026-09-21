'use strict';
/**
 * setup-check.js - report whether this machine can run EvidenceCrew, and say exactly what is missing.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A WIZARD
 *   The first five minutes decide whether a project gets used, and what goes wrong in those minutes is
 *   almost never the code: it is a missing API key, a browser that is not logged in, or an old Node. None
 *   of that needs a setup UI. It needs to be NAMED, with the one command that fixes it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   It does not ask for credentials and it does not write them anywhere. It does not open a browser, log
 *   in for you, solve a CAPTCHA, or touch your everyday Chrome profile. It reads and reports; every fix it
 *   suggests is a command you run yourself. It also never prints a credential value - only whether one is
 *   present.
 *
 * USAGE
 *   node tools/setup-check.js            human-readable report
 *   node tools/setup-check.js --json     machine-readable report
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');

const checks = [];
const check = (id, label, status, detail, fix) => checks.push({ id, label, status, detail, fix: fix ?? null });

// ---------------------------------------------------------------- Node version
const major = Number(process.versions.node.split('.')[0]);
check('node_version', 'Node.js version', major >= 18 ? 'OK' : 'FAIL',
  `v${process.versions.node} on ${process.platform}`,
  major >= 18 ? null : 'Install Node.js 18 or later from https://nodejs.org and re-run this check.');

// ---------------------------------------------------------------- dependencies
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const depCount = Object.keys(pkg.dependencies ?? {}).length;
check('dependencies', 'npm dependencies', depCount === 0 ? 'OK' : 'WARN',
  depCount === 0 ? 'none: Node built-ins only, so there is nothing to install' : `${depCount} declared (the project intends to have none)`,
  depCount === 0 ? null : 'Run npm install, and treat an unexpected dependency as a decision to review.');

// ---------------------------------------------------------------- repository layout
const layout = [
  ['workbench/server/entry.js', 'workbench server'],
  ['workbench/config.js', 'config resolver'],
  ['workbench/protocol/protocol.js', 'verified task protocol'],
  ['workbench/protocol/evidence.js', 'evidence records'],
  ['workbench/seats/registry.js', 'agent seats'],
  ['runtime/harness/cli.js', 'bundled harness'],
  ['worker/adapter/cw.js', 'ChatGPT browser worker adapter'],
  ['examples/demo-project/src/hud-pulse.js', 'demo project'],
];
const missing = layout.filter(([rel]) => !fs.existsSync(path.join(REPO_ROOT, rel))).map(([rel]) => rel);
check('layout', 'repository layout', missing.length === 0 ? 'OK' : 'FAIL',
  missing.length === 0 ? `${layout.length} expected components present` : `missing: ${missing.join(', ')}`,
  missing.length === 0 ? null : 'Re-clone the repository: a partial checkout cannot run.');

// ---------------------------------------------------------------- DeepSeek credential
const credentialsFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
let deepseek;
if (process.env.DEEPSEEK_API_KEY) {
  deepseek = { status: 'OK', detail: 'DEEPSEEK_API_KEY is set in the environment', fix: null };
} else if (fs.existsSync(credentialsFile)) {
  // The value is never read, printed or logged. Only whether the key is present.
  const present = /DEEPSEEK_API_KEY\s*:/.test(fs.readFileSync(credentialsFile, 'utf8'));
  deepseek = present
    ? { status: 'OK', detail: `a DEEPSEEK_API_KEY entry exists in ${credentialsFile}`, fix: null }
    : { status: 'MISSING', detail: `${credentialsFile} exists but has no DEEPSEEK_API_KEY entry`,
      fix: 'Add a line "DEEPSEEK_API_KEY: <your key>", or set the DEEPSEEK_API_KEY environment variable.' };
} else {
  deepseek = { status: 'MISSING', detail: `no credential file at ${credentialsFile}`,
    fix: `Create ${credentialsFile} containing one line "DEEPSEEK_API_KEY: <your key>", or set the DEEPSEEK_API_KEY environment variable. The file is git-ignored; never commit it.` };
}
check('deepseek_credential', 'DeepSeek supervisor credential', deepseek.status, deepseek.detail, deepseek.fix);

// ---------------------------------------------------------------- ChatGPT browser session
/**
 * The worker probe is OPT-IN, and that is a deliberate design decision rather than laziness.
 *
 * Answering "is the worker ready?" truthfully means opening a real browser window, which is a visible,
 * slow, stateful action: it creates a profile directory on first run and it can land on a login wall. A
 * setup check that opens Chrome in order to answer a question is a setup check people stop running. So the
 * default reports UNKNOWN - an honest "not probed" - and `--probe-worker` performs the real check and
 * reports READY or LOGIN_REQUIRED.
 */
if (!process.argv.includes('--probe-worker')) {
  check('chatgpt_session', 'ChatGPT browser worker', 'UNKNOWN',
    'not probed. Re-run with --probe-worker to open a browser and find out, or run npm start and use the '
    + 'worker health probe there.',
    'Run: node tools/setup-check.js --probe-worker   (it opens a browser window; you log in yourself)');
} else {
  const { spawnSync } = require('node:child_process');
  const cw = path.join(REPO_ROOT, 'worker', 'adapter', 'cw.js');
  let worker = { status: 'FAIL', detail: `worker adapter not found at ${cw}`, fix: 'Re-clone the repository.' };
  if (fs.existsSync(cw)) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [cw, 'health_check'], {
      cwd: path.dirname(cw), encoding: 'utf8', timeout: 180000,
    });
    const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    let parsed = null;
    try { parsed = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { parsed = null; }
    if (parsed && parsed.ok === true && !/login|sign in|unauthor/i.test(JSON.stringify(parsed))) {
      worker = { status: 'OK', detail: `READY: the browser worker responded (${took})`, fix: null };
    } else {
      const detail = parsed?.error ?? parsed?.detail ?? String(r.stderr ?? '').split('\n')[0] ?? 'no output';
      worker = { status: 'MISSING', detail: `not ready: ${String(detail).slice(0, 120)}`,
        fix: 'Log in to chatgpt.com yourself in the browser window the workbench opens, and complete any '
          + 'CAPTCHA or 2FA challenge by hand. Nothing here automates a login.' };
    }
  }
  check('chatgpt_session', 'ChatGPT browser worker', worker.status, worker.detail, worker.fix);
}

// ---------------------------------------------------------------- Codex (optional)
check('codex', 'Codex independent reviewer', 'OPTIONAL',
  'codex_review_mode is OFF by default and the workbench runs fully without it: the supervisor reviews its '
  + 'own work, and every Evidence Record states review_level=SUPERVISOR_REVIEW and DISABLED_BY_POLICY.',
  'Nothing to do. Switch it on in the workbench header if you have Codex available. It is never required for a goal to complete.');

// ---------------------------------------------------------------- workspace directory
const stateDir = path.join(REPO_ROOT, '.state');
let writable = false;
try {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.accessSync(stateDir, fs.constants.W_OK);
  writable = true;
} catch { writable = false; }
check('workspace', 'Workspace directory', writable ? 'OK' : 'FAIL',
  writable ? `${stateDir} is writable` : `${stateDir} is not writable`,
  writable ? null : `Fix permissions on ${REPO_ROOT}, or set AWB_STATE_FILE to a writable path.`);

// ---------------------------------------------------------------- port
const port = Number(process.env.PORT ?? 3099);
check('port', `Port ${port}`, 'UNKNOWN',
  'not probed here: the server binds loopback only and reports a clear error if the port is taken.',
  `If ${port} is busy, start with PORT=${port + 1} npm start.`);

// ---------------------------------------------------------------- report
const SYMBOL = { OK: '[ok]  ', WARN: '[warn]', FAIL: '[FAIL]', UNKNOWN: '[?]   ', OPTIONAL: '[opt] ', MISSING: '[FAIL]' };

if (JSON_OUT) {
  console.log(JSON.stringify({ repo_root: REPO_ROOT, platform: process.platform, node: process.versions.node, checks }, null, 2));
} else {
  console.log('=== EVIDENCECREW SETUP CHECK ===\n');
  for (const c of checks) console.log(`${SYMBOL[c.status] ?? '[?]   '} ${c.label.padEnd(34)} ${c.detail}`);
  const fixes = checks.filter((c) => c.fix && c.status !== 'OK');
  if (fixes.length) {
    console.log('\n--- what to do next ---');
    for (const c of fixes) console.log(`  * ${c.label}: ${c.fix}`);
  }
  const blockers = checks.filter((c) => c.status === 'FAIL' || c.status === 'MISSING');
  console.log('\n--- ready to start? ---');
  console.log(blockers.length === 0
    ? '  Yes: the required pieces are present.\n  Start it with:  npm start\n  Then open:      http://127.0.0.1:3099'
    : `  Not yet: ${blockers.length} blocking item(s) above.`);
  console.log('\nNo credential value appears in this report, and no credential was written.');
}

process.exit(checks.some((c) => c.status === 'FAIL' || c.status === 'MISSING') ? 1 : 0);
