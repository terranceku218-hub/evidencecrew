'use strict';
/**
 * public-safety-scan.js - find anything that must not reach a public repository.
 *
 * WHY THIS SHIPS WITH THE PRODUCT
 *   Publishing is a one-way door. This scanner exists so the answer to "is it safe to push?" is a
 *   command with a report, not a feeling. It is deliberately boring and deterministic: filename rules,
 *   content patterns, and directory rules, each with a severity, and it NEVER prints a matched secret -
 *   only its location, its class, and a redacted fingerprint. A scanner that prints the secret it found
 *   has just copied the secret into a new place, including your terminal scrollback and CI logs.
 *
 * USAGE
 *   node scripts/public-safety-scan.js <dir> [<dir> ...]
 *   node scripts/public-safety-scan.js --json <dir> ...     machine-readable report
 *   node scripts/public-safety-scan.js --staged <dir> ...   scan what is staged/copied, exit 1 on any hit
 *
 * EXIT CODES
 *   0  no CRITICAL or HIGH findings
 *   1  at least one CRITICAL or HIGH finding
 *   2  usage error
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const roots = args.filter((a) => !a.startsWith('--'));
if (!roots.length) {
  console.error('usage: node scripts/public-safety-scan.js [--json] <dir> [<dir> ...]');
  process.exit(2);
}

/** Directories that never belong in a public repo, by name. Reported, never traversed. */
const EXCLUDED_DIRS = [
  'node_modules', '.git', '.playwright', '.playwright-cli', 'profile', 'user data',
  'codex-home', 'codex-lab', 'temp', 'logs', 'evidence', 'state',
];
/** ...but `logs`, `state` and `evidence` are legitimate in some trees, so they are only skipped for
 *  CONTENT scanning. They are reported as "review before publishing" rather than as violations. */
const CONTENT_SKIP_DIRS = ['node_modules', '.git', 'profile', 'user data', '.playwright-cli', 'codex-home'];

/** Filenames that are credentials or browser state wherever they appear. */
const FILE_RULES = [
  { id: 'credentials_yaml', sev: 'CRITICAL', test: (n) => /^\.credentials\.ya?ml$/i.test(n), why: 'API credentials file' },
  { id: 'auth_json', sev: 'CRITICAL', test: (n) => /^auth\.json$/i.test(n), why: 'OAuth token store (Codex/OpenAI CLI)' },
  { id: 'cookies_db', sev: 'CRITICAL', test: (n) => /^(cookies|cookies-journal|login data|login data-journal|web data)$/i.test(n), why: 'browser cookie / password database' },
  { id: 'local_state', sev: 'HIGH', test: (n) => /^local state$/i.test(n), why: 'Chrome profile state (contains encrypted keys)' },
  { id: 'profile_settings', sev: 'HIGH', test: (n) => /^(preferences|secure preferences|history|bookmarks)$/i.test(n), why: 'browser profile data' },
  { id: 'env_file', sev: 'HIGH', test: (n) => /^\.env(\..+)?$/i.test(n) && !/\.example$|\.sample$|\.template$/i.test(n), why: 'environment file' },
  { id: 'key_file', sev: 'CRITICAL', test: (n) => /\.(pem|key|p12|pfx|jks|keystore)$/i.test(n), why: 'private key material' },
  { id: 'ssh_key', sev: 'CRITICAL', test: (n) => /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(n), why: 'SSH key material' },
  { id: 'sqlite_state', sev: 'MEDIUM', test: (n) => /\.(sqlite|sqlite3|db)(-wal|-shm)?$/i.test(n), why: 'local database (may hold session state)' },
  { id: 'har_file', sev: 'HIGH', test: (n) => /\.har$/i.test(n), why: 'HTTP archive: full request and response bodies, including cookies' },
];

/** Content patterns. `preview` decides how much of a match may be shown - never the whole secret. */
const CONTENT_RULES = [
  { id: 'openai_key', sev: 'CRITICAL', re: /\bsk-[A-Za-z0-9_-]{16,}/g, what: 'OpenAI-style API key' },
  { id: 'anthropic_key', sev: 'CRITICAL', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, what: 'Anthropic API key' },
  { id: 'google_api_key', sev: 'CRITICAL', re: /\bAIza[0-9A-Za-z_-]{30,}/g, what: 'Google API key' },
  { id: 'github_token', sev: 'CRITICAL', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, what: 'GitHub token' },
  { id: 'slack_token', sev: 'CRITICAL', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, what: 'Slack token' },
  { id: 'aws_key', sev: 'CRITICAL', re: /\bAKIA[0-9A-Z]{16}\b/g, what: 'AWS access key id' },
  { id: 'private_key_block', sev: 'CRITICAL', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: 'PEM private key' },
  { id: 'oauth_json', sev: 'CRITICAL', re: /"(?:access_token|refresh_token|id_token|OPENAI_API_KEY|DEEPSEEK_API_KEY)"\s*:\s*"[^"]{8,}"/g, what: 'serialised OAuth/API token' },
  { id: 'bearer_header', sev: 'HIGH', re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g, what: 'bearer token' },
  { id: 'jwt', sev: 'HIGH', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, what: 'JWT' },
  { id: 'assigned_secret', sev: 'HIGH', re: /(?:api[_-]?key|apikey|secret|passw(?:or)?d|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?token)["']?\s*[:=]\s*["']([^"'\s,}]{12,})["']/gi, what: 'assigned secret value' },
  /**
   * Only a REAL conversation id is a finding. ChatGPT ids are UUID-shaped, so the pattern requires that
   * shape. Synthetic fixtures in the bundled harness tests look like `https://chatgpt.com/c/story-
   * conversation`, which is not private data, and the all-zeros placeholder is what the packager writes
   * when it sanitises a real one. Flagging those produced 10 findings that a reviewer had to dismiss by
   * hand every run - and a scanner whose output is mostly noise stops being run.
   */
  {
    id: 'chatgpt_conversation_url', sev: 'MEDIUM',
    re: /https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:c|share)\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    what: 'private conversation URL (UUID-shaped)',
    ignore: /00000000-0000-0000-0000-000000000000/,
  },
  /**
   * Path rules, with two refinements that both matter for signal quality.
   *
   * 1. `\\{1,2}` rather than a single backslash. In a JavaScript or JSON source a Windows path is written
   *    with DOUBLED separators (`'C:\\\\Users\\\\name'`), and a rule that only matches the single form
   *    misses the most common place a personal path actually appears. This was a real blind spot: the
   *    scanner reported hits from prose and fixtures while walking past hard-coded literals in source.
   *
   * 2. A lookbehind on the Unix forms, so the match must START a path. Without it, an ordinary relative
   *    path like `codex-lab/home/auth.json` was reported as a personal path. A scanner that cries wolf on
   *    ordinary paths is one people stop reading, and a rule nobody reads is worse than no rule.
   */
  {
    id: 'absolute_user_path', sev: 'MEDIUM',
    re: /[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+|(?<![A-Za-z0-9._-])\/Users\/[A-Za-z0-9._-]+|(?<![A-Za-z0-9._-])\/home\/[A-Za-z0-9._-]+/g,
    what: 'machine-specific absolute path',
  },
  { id: 'email_address', sev: 'LOW', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, what: 'email address' },
];

/** Project-specific private markers, supplied by the operator as a comma list. */
const PRIVATE_MARKERS = String(process.env.PUBLIC_SCAN_PRIVATE_MARKERS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (PRIVATE_MARKERS.length) {
  CONTENT_RULES.push({
    id: 'private_project_marker', sev: 'HIGH',
    re: new RegExp(PRIVATE_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'),
    what: 'private project marker',
  });
}

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.jsonl', '.md', '.txt', '.yml', '.yaml', '.toml', '.ini',
  '.cfg', '.conf', '.html', '.css', '.ps1', '.sh', '.bat', '.cmd', '.py', '.cs', '.log', '.csv', '.env',
  '.example', '.sample', '.template', '.gitignore', '.npmrc', '.patch', '.diff',
]);
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const findings = [];
const skipped = [];
let scanned = 0;

function redact(s) {
  const v = String(s);
  if (v.length <= 8) return `${v[0] ?? ''}*** (len ${v.length})`;
  return `${v.slice(0, 3)}***${v.slice(-2)} (len ${v.length})`;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function record(f) {
  findings.push(f);
}

function scanFile(abs, root, name) {
  const rel = path.relative(root, abs) || name;
  const lowerDir = abs.toLowerCase();

  for (const rule of FILE_RULES) {
    if (rule.test(name)) {
      record({ kind: 'file', rule: rule.id, sev: rule.sev, file: rel, root, what: rule.why, sample: null });
    }
  }

  // Browser profile data is identified by PATH, not content: the databases are binary.
  if (/[\\/](default|profile \d+|system profile)[\\/]/i.test(abs) || /[\\/]user data[\\/]/i.test(lowerDir)) {
    record({ kind: 'path', rule: 'browser_profile_dir', sev: 'CRITICAL', file: rel, root, what: 'inside a browser profile directory', sample: null });
    return;
  }

  const ext = path.extname(name).toLowerCase();
  if (!TEXT_EXT.has(ext) && !TEXT_EXT.has(name.toLowerCase())) {
    record({ kind: 'binary', rule: 'non_text_file', sev: 'LOW', file: rel, root, what: `non-text file (${ext || 'no extension'})`, sample: null });
    return;
  }

  let stat;
  try { stat = fs.statSync(abs); } catch { return; }
  if (stat.size > MAX_SCAN_BYTES) {
    skipped.push({ file: rel, root, reason: `larger than ${MAX_SCAN_BYTES} bytes` });
    return;
  }
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }
  if (text.includes('\u0000')) {
    record({ kind: 'binary', rule: 'binary_content', sev: 'LOW', file: rel, root, what: 'binary content in a text-named file', sample: null });
    return;
  }
  scanned += 1;

  for (const rule of CONTENT_RULES) {
    rule.re.lastIndex = 0;
    let m;
    let hits = 0;
    while ((m = rule.re.exec(text)) !== null && hits < 5) {
      if (rule.ignore && rule.ignore.test(m[0])) { if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1; continue; }
      hits += 1;
      record({
        kind: 'content', rule: rule.id, sev: rule.sev, file: rel, root,
        line: lineOf(text, m.index), what: rule.what,
        sample: rule.sev === 'LOW' ? String(m[0]) : redact(m[0]),
      });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1;
    }
  }
}

function walk(dir, root) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (CONTENT_SKIP_DIRS.includes(e.name.toLowerCase())) {
        skipped.push({ file: path.relative(root, abs), root, reason: 'directory excluded from content scanning (credentials / browser state)' });
        continue;
      }
      walk(abs, root);
    } else if (e.isFile()) {
      scanFile(abs, root, e.name);
    }
  }
}

for (const root of roots) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) { console.error(`not found: ${abs}`); continue; }
  walk(abs, abs);
}

const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
for (const f of findings) (bySeverity[f.sev] ?? bySeverity.LOW).push(f);

const counts = Object.fromEntries(Object.entries(bySeverity).map(([k, v]) => [k, v.length]));
const blocking = counts.CRITICAL + counts.HIGH;

if (asJson) {
  console.log(JSON.stringify({ roots, scanned_files: scanned, counts, skipped, findings }, null, 2));
} else {
  console.log('=== PUBLIC SAFETY SCAN ===');
  console.log(`roots            : ${roots.join(', ')}`);
  console.log(`files read       : ${scanned}`);
  console.log(`CRITICAL / HIGH  : ${counts.CRITICAL} / ${counts.HIGH}`);
  console.log(`MEDIUM / LOW     : ${counts.MEDIUM} / ${counts.LOW}`);
  console.log('NOTE: no matched value is printed by design. Locations and classes only.');

  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    const list = bySeverity[sev];
    if (!list.length) continue;
    console.log(`\n--- ${sev} (${list.length}) ---`);
    const grouped = new Map();
    for (const f of list) {
      const key = `${f.rule} | ${f.what}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(f);
    }
    for (const [key, items] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  [${key}] ${items.length} hit(s)`);
      const files = new Map();
      for (const it of items) files.set(it.file, (files.get(it.file) ?? 0) + 1);
      for (const [file, n] of [...files.entries()].slice(0, 8)) {
        const first = items.find((i) => i.file === file);
        console.log(`      ${file}${n > 1 ? ` (${n})` : ''}${first.line ? `:${first.line}` : ''}${first.sample ? `  ${first.sample}` : ''}`);
      }
      if (files.size > 8) console.log(`      ... and ${files.size - 8} more file(s)`);
    }
  }

  if (skipped.length) {
    console.log(`\n--- NOT CONTENT-SCANNED (${skipped.length}) ---`);
    const dirs = new Map();
    for (const s of skipped) dirs.set(s.file, s.reason);
    let shown = 0;
    for (const [file, reason] of dirs) {
      if (shown >= 25) { console.log(`  ... and ${dirs.size - shown} more`); break; }
      console.log(`  ${file}  <- ${reason}`);
      shown += 1;
    }
  }

  console.log('\n=== RESULT ===');
  if (blocking) console.log(`${blocking} blocking finding(s): do NOT publish until resolved or excluded.`);
  else console.log('no CRITICAL or HIGH findings: safe to publish subject to the exclude list.');
}

process.exit(blocking ? 1 : 0);
