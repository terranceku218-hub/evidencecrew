'use strict';
/**
 * paths.js - global paths, config loading, and small shared helpers.
 *
 * WHY A SINGLE MODULE
 *   Every other module needs the global config, and hard-coding a path in more than one
 *   place is how a harness ends up half-migrated. This is the only file that knows where
 *   things live.
 *
 * ASCII-ONLY source: see the encoding note in ../config.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const HARNESS_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(HARNESS_ROOT, 'config.json');

function readJson(file) {
  // Tolerate a UTF-8 BOM: PowerShell and Notepad on this machine both emit one, and
  // JSON.parse rejects a leading U+FEFF.
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

const CONFIG = readJson(CONFIG_PATH);

/**
 * Resolve a configured path against the harness root.
 *
 * PUBLIC RELEASE ADDITION. The maintainer instance stores absolute paths in config.json, which is fine
 * on one machine and fatal on any other. Rather than rewrite every consumer, the config is normalised
 * once, here: a relative value is resolved against the harness root, an absolute value is left alone,
 * and an environment variable can override either. Nothing downstream changes, because every consumer
 * already reads CONFIG.paths.*.
 */
const PATH_ENV = {
  harnessRoot: 'AWB_HARNESS_ROOT',
  registry: 'AWB_HARNESS_REGISTRY',
  logsDir: 'AWB_HARNESS_LOGS',
  templatesDir: 'AWB_HARNESS_TEMPLATES',
  workerDir: 'AWB_WORKER_DIR',
  workerCli: 'AWB_WORKER_CLI',
  workerAdapterDir: 'AWB_WORKER_ADAPTER_DIR',
};
for (const [key, envName] of Object.entries(PATH_ENV)) {
  const fromEnv = process.env[envName];
  const value = fromEnv ?? CONFIG.paths[key];
  if (typeof value !== 'string') continue;
  CONFIG.paths[key] = (path.isAbsolute(value) || /^[A-Za-z]:/.test(value))
    ? value
    : path.resolve(HARNESS_ROOT, value);
}
if (CONFIG.paths.projectRegistry) {
  CONFIG.paths.projectRegistry = path.isAbsolute(CONFIG.paths.projectRegistry)
    ? CONFIG.paths.projectRegistry
    : path.join(CONFIG.paths.registry, path.basename(CONFIG.paths.projectRegistry));
}
if (CONFIG.paths.workerPool) {
  CONFIG.paths.workerPool = path.isAbsolute(CONFIG.paths.workerPool)
    ? CONFIG.paths.workerPool
    : path.join(CONFIG.paths.registry, path.basename(CONFIG.paths.workerPool));
}
if (CONFIG.paths.workerVerify && !path.isAbsolute(CONFIG.paths.workerVerify)) {
  CONFIG.paths.workerVerify = path.resolve(CONFIG.paths.workerDir, CONFIG.paths.workerVerify);
}


/** Read a JSON file that may legitimately not exist yet. */
function readJsonIfExists(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return readJson(file);
}

/**
 * Write JSON atomically.
 * Writes go to a temp file and are renamed over the target, so an interrupted run can
 * never leave a half-written registry that the next run misreads.
 */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return value;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append one JSON line to a log, tagged with the project it belongs to. */
function logEvent(event, detail, projectId) {
  try {
    ensureDir(CONFIG.paths.logsDir);
    const line = JSON.stringify({
      at: new Date().toISOString(),
      project_id: projectId ?? null,
      event,
      detail: detail ?? null,
    }) + '\n';
    fs.appendFileSync(path.join(CONFIG.paths.logsDir, 'harness.jsonl'), line, 'utf8');
  } catch {
    // Logging must never break the work it is describing.
  }
}

function nowIso() { return new Date().toISOString(); }

/**
 * Run a child process and capture its output.
 *
 * Node's default `stdio: 'pipe'` cannot open named pipes under a confined sandbox. That
 * restriction is a documented environment boundary, not a bug, so callers that need to
 * capture output must run in a context where piping works; the worker CLI is invoked
 * that way deliberately, because parsing its JSON is the whole point.
 */
function run(cmd, args, opts = {}) {
  const { spawnSync } = require('node:child_process');
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? CONFIG.limits.cliTimeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd,
  });
}

module.exports = {
  HARNESS_ROOT,
  CONFIG_PATH,
  CONFIG,
  readJson,
  readJsonIfExists,
  writeJsonAtomic,
  ensureDir,
  logEvent,
  nowIso,
  run,
};
