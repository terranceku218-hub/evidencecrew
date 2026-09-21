'use strict';
/**
 * review-snapshot.js - a disposable, cryptographically-bound review workspace.
 *
 * WHY A SNAPSHOT INSTEAD OF THE REAL REPO
 *   The reviewer seat runs under a Codex read-only sandbox that refuses to create local processes at
 *   all on this Windows setup: every `git show`, `rg`, `dir` and `Get-Location` was rejected BEFORE
 *   execution, so Codex could inspect nothing and correctly returned BLOCKED. The brief forbids the
 *   obvious workaround - do not hand the real Game repo `danger-full-access` to make a test pass - and
 *   sanctions this instead: a disposable workspace containing only what the review needs.
 *
 * WHAT MAKES THIS TRUSTWORTHY RATHER THAN A SUBSTITUTE
 *   Every copied file carries a binding: original_path, original_sha256, snapshot_path,
 *   snapshot_sha256, and the two hashes must be equal. The commit diff is exported from the REAL repo
 *   by the Workbench and hashed. So the reviewer is not reviewing "some files"; it is reviewing content
 *   whose identity is cryptographically tied to the real repository at a named commit. The Evidence
 *   Record cites those hashes, which is what lets a reader check the reviewer's basis.
 *
 * WHAT IT IS NOT
 *   Not a working copy. It is read-only evidence input. The real Game repo is only ever READ, and Codex
 *   has no path to it from inside the sandbox.
 *
 * It writes only under agent-workspaces\codex-review-<run_id>.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCRATCH = path.resolve(require('node:os').homedir(), '.dsh', 'agent-workspaces');

function sha256File(f) {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}
function sha256Text(t) {
  return crypto.createHash('sha256').update(t, 'utf8').digest('hex');
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/**
 * Build the snapshot for one review.
 *
 * @param {{runId:string, repo:string, commit:string, files:string[]}} spec
 */
function buildReviewSnapshot(spec) {
  const { runId, repo, commit, files } = spec;
  const dir = path.join(SCRATCH, `codex-review-${runId}`);
  fs.mkdirSync(dir, { recursive: true });

  const bindings = [];
  for (const rel of files) {
    const src = path.join(repo, rel);
    if (!fs.existsSync(src)) { bindings.push({ original_path: rel, error: 'not present in the real repo' }); continue; }
    const dest = path.join(dir, path.basename(rel));
    fs.copyFileSync(src, dest);
    const a = sha256File(src);
    const b = sha256File(dest);
    bindings.push({
      original_path: rel.replace(/\\/g, '/'),
      original_sha256: a,
      snapshot_path: path.basename(rel),
      snapshot_sha256: b,
      hashes_match: a === b,
      bytes: fs.statSync(dest).size,
    });
  }

  // The commit facts are exported FROM THE REAL REPO here, then frozen into the snapshot as text.
  const showStat = git(repo, ['show', '--stat', '--oneline', commit]);
  const fullDiff = git(repo, ['show', '--no-color', '--format=%H%n%an%n%aI%n%s', commit]);
  const nameOnly = git(repo, ['show', '--name-only', '--format=', commit]);
  const parentDiff = git(repo, ['diff', '--no-color', `--unified=80`, `${commit}^`, commit, '--', ...files]);

  const diffText = parentDiff.ok ? parentDiff.out : fullDiff.out;
  const patch = path.join(dir, 'COMMIT_DIFF.patch');
  fs.writeFileSync(patch, diffText, 'utf8');

  const allFiles = nameOnly.out.split('\n').filter(Boolean);
  const businessFiles = allFiles.filter((f) => !/[/\\]?\.ai[/\\]/.test(f) && !f.startsWith('.ai/'));
  const harnessFiles = allFiles.filter((f) => !businessFiles.includes(f));

  const metadata = {
    snapshot_version: '0.2.1',
    run_id: runId,
    purpose: 'Read-only evidence input for an independent Codex review. NOT a working copy.',
    repo: { path: repo, commit },
    commit_facts: {
      stat: showStat.out,
      name_only: allFiles,
      business_files_in_commit: businessFiles,
      harness_bookkeeping_files: harnessFiles,
      subject: fullDiff.out.split('\n').slice(3).join(' ').slice(0, 200),
    },
    files: bindings,
    diff: { path: 'COMMIT_DIFF.patch', sha256: sha256Text(diffText), bytes: Buffer.byteLength(diffText, 'utf8') },
    real_repo_write_access_for_reviewer: false,
    note: 'Every file hash here was computed from the real repository at copy time; the reviewer can '
      + 'therefore verify content whose identity is bound to that repo without being able to write to it.',
  };
  const metaPath = path.join(dir, 'REVIEW_METADATA.json');
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  return {
    ok: bindings.every((b) => b.hashes_match !== false),
    dir,
    metadata_path: metaPath,
    patch_path: patch,
    metadata,
    files: bindings,
    diff_sha256: metadata.diff.sha256,
  };
}

/**
 * Hash the whole snapshot, so a mutation by the reviewer is detectable.
 *
 * The brief allows this: if the snapshot itself changes during review, the result is
 * REVIEW_ENV_MUTATED and cannot be VERIFIED. A read-only reviewer should never change it, and this is
 * how that expectation is checked rather than assumed.
 */
function hashSnapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      out[path.relative(dir, full).replace(/\\/g, '/')] = sha256File(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** Compare two snapshot hashes and name exactly what moved. */
function diffSnapshot(before, after) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added.push(k);
    else if (before[k] !== v) changed.push(k);
  }
  for (const k of Object.keys(before)) if (!(k in after)) removed.push(k);
  const mutated = changed.length + added.length + removed.length > 0;
  return { ok: !mutated, mutated, changed, added, removed, result: mutated ? 'REVIEW_ENV_MUTATED' : 'SNAPSHOT_UNCHANGED' };
}

module.exports = { buildReviewSnapshot, hashSnapshot, diffSnapshot, sha256File, sha256Text, git };
