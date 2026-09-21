'use strict';
/**
 * Regenerate every Evidence Markdown view from its JSON record.
 *
 * WHY THIS EXISTS
 *   The JSON record is the source of truth and the Markdown view is generated from it - so when the
 *   renderer changes, the views on disk are stale by definition. A reader who opens the .md instead of
 *   the .json would see the OLD table, which is precisely the failure the two-view design is meant to
 *   avoid: after V0.3 added `review_level`, `independent_review_status` and `codex_review_mode` to the
 *   record, every existing view still omitted them, so the Markdown quietly understated what the JSON
 *   knew. Regenerating is safe because it is a pure function of the record: this script never edits a
 *   record, only its view.
 *
 * Usage:  node scripts/regenerate-evidence-views.js [--dry]
 */

const path = require('node:path');
const fs = require('node:fs');

const WB = path.resolve(__dirname, '..', '..', 'workbench');
const evidence = require(path.join(WB, 'protocol', 'evidence.js'));

const dry = process.argv.includes('--dry');
const dir = evidence.recordsDir();
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

let changed = 0;
let unchanged = 0;
let failed = 0;
const added = [];

for (const f of files) {
  const recordId = f.replace(/\.json$/, '');
  const jsonPath = path.join(dir, f);
  const mdPath = path.join(dir, `${recordId}.md`);
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    console.error(`  SKIP ${recordId}: unreadable JSON (${e.message})`);
    failed += 1;
    continue;
  }
  const next = evidence.toMarkdown(rec);
  const prev = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : null;
  if (prev === next) { unchanged += 1; continue; }
  if (!dry) fs.writeFileSync(mdPath, next, 'utf8');
  changed += 1;
  // Report which rows the view was missing, so the drift is visible rather than merely repaired.
  const missing = ['review_level', 'independent_review_status', 'codex_review_mode']
    .filter((k) => rec[k] && !(prev ?? '').includes(String(rec[k])));
  if (missing.length) added.push(`${recordId}: ${missing.join(', ')}`);
  console.log(`  ${dry ? 'WOULD REWRITE' : 'rewrote'} ${recordId}`);
}

console.log(`\nrecords: ${files.length}  rewritten: ${changed}  already current: ${unchanged}  unreadable: ${failed}`);
if (added.length) {
  console.log('\nviews that were missing a field their JSON already carried:');
  for (const a of added) console.log(`  - ${a}`);
}
