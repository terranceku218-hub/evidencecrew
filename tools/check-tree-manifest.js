'use strict';
/**
 * check-tree-manifest.js - verify this tree against tools/TREE_MANIFEST.json.
 *
 * WHY A SHIPPED CHECKER
 *   `TREE_MANIFEST.json` claims to be a byte-for-byte inventory of the release. A claim nobody can test is
 *   just a file, so this is the test. Run it before opening an issue about a downloaded copy, and after any
 *   local edit to see exactly which files differ from the published inventory.
 *
 * WHAT IT ANSWERS
 *   - which files are ADDED, CHANGED or REMOVED relative to the manifest
 *   - whether the manifest's own counts still describe reality
 *
 * It does not need a network, an API key or a browser, and it writes nothing.
 *
 * USAGE
 *   node tools/check-tree-manifest.js            summary
 *   node tools/check-tree-manifest.js --list     every differing file
 *
 * EXIT CODE
 *   0 the tree matches, 1 it does not, 2 the manifest is missing or unreadable.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(__dirname, 'TREE_MANIFEST.json');
const LIST = process.argv.includes('--list');

/** Anything that is generated at run time is not part of the inventory. Keep this in step with the freeze tool. */
const EXCLUDED = [
  'tools/TREE_MANIFEST.json',
  /**
   * `.gitattributes` is not in the inventory either: it DECLARES how the other files are stored, so listing it
   * would make the inventory depend on the one file that governs how everything else round-trips through git.
   * It ships in the repository - it just is not part of the byte-for-byte record.
   */
  '.gitattributes',
  /(^|\/)\.git\//,
  /(^|\/)\.ai\//,
  /(^|\/)logs\//,
  /(^|\/)registry\//,
  /**
   * Evidence Records are RUN OUTPUT - project paths, prompts, model replies - and this project's own test
   * suites write them here when you run `tools/run-tests.js`. They are matched by the `evidence/EV-` filename
   * pattern rather than by the word "evidence", so that the Evidence Card's SOURCE, its tests and its docs
   * still count as part of the tree. Without this line, running the tests made this checker report four newly
   * "added" files and fail on a tree that had not actually changed.
   */
  /(^|\/)evidence\/EV-/,
  /(^|\/)node_modules\//,
  /(^|\/)\.playwright-cli\//,
  /(^|\/)\.state\//,
];

if (!fs.existsSync(MANIFEST)) {
  console.error(`no manifest at ${path.relative(REPO_ROOT, MANIFEST)}`);
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (e) {
  console.error(`the manifest is not valid JSON: ${e.message}`);
  process.exit(2);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (EXCLUDED.some((x) => (typeof x === 'string' ? x === rel : x.test(rel)))) continue;
    if (e.isDirectory()) walk(abs, out);
    else out.push(rel);
  }
  return out;
}

const actual = new Map();
for (const rel of walk(REPO_ROOT).sort()) {
  const buf = fs.readFileSync(path.join(REPO_ROOT, rel));
  actual.set(rel, { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
}

const expected = new Map((manifest.files ?? []).map((f) => [f.file, f]));

const added = [];
const changed = [];
const removed = [];
for (const [rel, a] of actual) {
  const e = expected.get(rel);
  if (!e) added.push(rel);
  else if (e.sha256 !== a.sha256) changed.push(`${rel} (${e.bytes} -> ${a.bytes} bytes)`);
}
for (const rel of expected.keys()) if (!actual.has(rel)) removed.push(rel);

console.log('=== TREE MANIFEST CHECK ===');
console.log(`repository : ${REPO_ROOT}`);
console.log(`manifest   : ${manifest.frozen_for ?? manifest.generated_at}  (${manifest.product} ${manifest.version})`);
console.log(`inventory  : ${expected.size} file(s), ${manifest.bytes_total ?? '?'} bytes`);
console.log(`actual     : ${actual.size} file(s)`);
console.log(`added      : ${added.length}`);
console.log(`changed    : ${changed.length}`);
console.log(`removed    : ${removed.length}`);

const diffs = [
  ...added.map((f) => `+ ${f}`),
  ...changed.map((f) => `~ ${f}`),
  ...removed.map((f) => `- ${f}`),
];
if (diffs.length && LIST) { console.log('\n--- differences ---'); for (const d of diffs) console.log(`  ${d}`); }
else if (diffs.length) console.log('\nrun again with --list to see every differing file');

const clean = diffs.length === 0;
console.log(`\n=== ${clean ? 'the tree matches the published inventory' : 'the tree DIFFERS from the published inventory'} ===`);
if (!clean) {
  console.log('An ADDED or CHANGED file is not automatically a problem: if you edited the source yourself, this is');
  console.log('expected. What it does mean is that this copy is no longer the published release, so an issue about');
  console.log('behaviour should say so.');
}
process.exit(clean ? 0 : 1);
