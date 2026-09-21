'use strict';
/**
 * yamltest.js - regression test for the YAML serializer/parser pair.
 *
 * WHY THIS EXISTS AS A FILE
 *   The first version of the serializer did not escape backslashes when it quoted a
 *   string. A Windows registry path ending in `\novel-demo` was written into PROJECT.yaml
 *   as `"...\novel-demo"`, and on read-back `\n` became a newline - so the project root
 *   came back with a line break in it. The root-mismatch guard caught the corruption, but
 *   only because that guard exists.
 *
 *   The failure is invisible in ASCII-only test data, so the cases below deliberately
 *   include the exact escape sequences that Windows paths generate.
 *
 * Usage: node yamltest.js
 */

const yaml = require('./lib/mini-yaml.js');

// PUBLIC RELEASE ADDITION: the Windows-path fixture below used to be a hard-coded personal path. It is
// now derived from the home directory, which needs the path module this file previously did not import.
const path = require('node:path');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: String(detail ?? '') }); }

// ---- round-trip of hostile scalars --------------------------------------
const HOSTILE = [
  ['windows path with \\n', path.resolve(require('node:os').homedir(), 'Temp', 'novel-demo')],
  ['windows path with \\t', 'C:\\a\\b\\tc\\x'],
  ['windows path with \\r', 'C:\\a\\b\\rc'],
  ['windows UNC path', '\\\\server\\share\\dir'],
  ['trailing backslash', 'C:\\temp\\'],
  ['the literal token \\n', '\\n'],
  ['backslash-n as escape text', 'a\\nb'],
  ['plain ascii', 'plain-value'],
  ['colon inside', 'has: colon'],
  ['double quote inside', 'quote"inside'],
  ['single quote inside', "it's here"],
  ['hash inside', 'value # not a comment?'],
  ['leading space', ' leading'],
  ['trailing space', 'trailing '],
  ['empty string', ''],
  ['looks like bool', 'true'],
  ['looks like number', '8080'],
  ['brackets', '[a, b]'],
];

for (const [name, value] of HOSTILE) {
  const text = yaml.stringify({ p: value });
  let back;
  let err = null;
  try { back = yaml.parse(text).p; } catch (e) { err = e.message; }
  check(`roundtrip: ${name}`, err === null && back === value,
    err ? `parse error: ${err}` : `in=${JSON.stringify(value)} out=${JSON.stringify(back)}`);
}

// ---- nested structure round-trip ----------------------------------------
const NESTED = {
  name: 'Example',
  project_id: 'example-project',
  type: 'coding',
  root: path.resolve(require('node:os').homedir(), 'Projects', 'example'),
  state_files: { project_state: 'PROJECT_STATE.md', tasks: 'TASKS.md' },
  worker: { backend: 'chatgpt-web', role: 'coding', max_rounds: 8, reuse_conversation: true },
  git: { enabled: true },
  permissions: { file_read: true, file_write: true, shell: true, web: false },
  empty_list: [],
  list: ['a', 'b'],
};

{
  const once = yaml.stringify(NESTED);
  const obj1 = yaml.parse(once);
  const twice = yaml.stringify(obj1);
  const obj2 = yaml.parse(twice);
  check('nested structure identical through two round-trips',
    JSON.stringify(obj1) === JSON.stringify(obj2), 'stable');
  check('nested root path preserved',
    obj1.root === NESTED.root, `${obj1.root}`);
  check('nested booleans preserved',
    obj1.permissions.web === false && obj1.git.enabled === true, 'booleans');
  check('nested numbers preserved', obj1.worker.max_rounds === 8, `${obj1.worker.max_rounds}`);
  check('empty list preserved', Array.isArray(obj1.empty_list) && obj1.empty_list.length === 0, 'empty array');
}

// ---- rejection of unsupported features ----------------------------------
{
  let threw = false;
  try { yaml.parse('a: &anchor value'); } catch { threw = true; }
  check('rejects anchors rather than mis-parsing', threw, 'anchor rejected');

  let threw2 = false;
  try { yaml.parse('a: 1\nb: 2\n---\nc: 3'); } catch { threw2 = true; }
  check('rejects multi-document streams', threw2, 'document marker rejected');
}

// ---- the anchor guard must not reject ordinary values --------------------
// An over-broad guard is its own bug: refusing a config that is perfectly valid would
// block a project for no reason. These are values a real PROJECT.yaml could contain.
{
  const OK_VALUES = [
    ['wildcard in a value', 'path: src/*.cs'],
    ['multiply-style text', 'note: a * b'],
    ['c++ style text', 'note: C++ & more'],
    ['ampersand word', 'note: R&D notes'],
    ['star in prose', 'note: important * point'],
    ['at-sign', 'contact: user@example.com'],
    ['percent in value', 'note: 50% done'],
    ['dash-dash in value', 'note: a -- b'],
  ];
  for (const [name, text] of OK_VALUES) {
    let parsed = null;
    let err = null;
    try { parsed = yaml.parse(text); } catch (e) { err = e.message; }
    check(`accepts: ${name}`, err === null && parsed !== null, err ?? JSON.stringify(parsed));
  }
}

// ---- report --------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
process.stdout.write(JSON.stringify({
  ok: failed.length === 0,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}, null, 2) + '\n');
process.exit(failed.length === 0 ? 0 : 1);
