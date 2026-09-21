'use strict';
/**
 * config.js - load the workbench configuration and resolve its paths.
 *
 * PUBLIC RELEASE ADDITION. The maintainer instance stores absolute paths in config.json, which is correct
 * on exactly one machine: `require(path.join('runtime/harness', 'lib', 'registry.js'))` is not a relative
 * require, it is a package lookup, and it fails. This module resolves every configured path against the
 * repository root once, so the five modules that consume CONFIG.paths.* did not have to change at all.
 *
 * An absolute configured value is honoured unchanged, and each path can be overridden by an environment
 * variable, which is what makes the same tree usable from a CI runner or a different checkout location.
 */

const fs = require('node:fs');
const path = require('node:path');

const WORKBENCH_ROOT = __dirname;
const REPO_ROOT = path.resolve(WORKBENCH_ROOT, '..');
const CONFIG_PATH = path.join(WORKBENCH_ROOT, 'config.json');

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));

const PATH_ENV = {
  workbenchRoot: 'AWB_WORKBENCH_ROOT',
  publicDir: 'AWB_PUBLIC_DIR',
  logsDir: 'AWB_LOGS_DIR',
  stateFile: 'AWB_STATE_FILE',
  harnessRoot: 'AWB_HARNESS_ROOT',
  harnessCli: 'AWB_HARNESS_CLI',
};

for (const [key, envName] of Object.entries(PATH_ENV)) {
  const value = process.env[envName] ?? CONFIG.paths[key];
  if (typeof value !== 'string' || value === '') continue;
  CONFIG.paths[key] = path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

module.exports = { CONFIG, CONFIG_PATH, WORKBENCH_ROOT, REPO_ROOT };
