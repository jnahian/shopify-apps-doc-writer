'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'shopify-apps-doc-writer');

/**
 * @typedef {Record<string, string|true>} Args
 * @typedef {{
 *   appKey: string, store: string, appHandle: string, storageState: string,
 *   viewport: {width: number, height: number}, locale: string,
 *   capture: {mode: string, outputDir: string, browser: string, headless: boolean},
 *   publish: {target: string},
 *   deploy?: {pagesProject?: string},
 * }} AppConfig
 */

const DEFAULTS = {
  viewport: { width: 1440, height: 900 },
  locale: 'en',
  capture: {
    mode: 'full-admin',
    outputDir: 'docs',
    browser: 'chrome',
    headless: true,
  },
  publish: {
    target: 'local',
  },
};

/** @param {string} p */
function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** @param {string} appKey */
function configPath(appKey) {
  return path.join(CONFIG_DIR, `${appKey}.json`);
}

/** @param {string} appKey */
function authPath(appKey) {
  return path.join(CONFIG_DIR, `${appKey}.auth.json`);
}

/** App keys that have a config file (excludes *.auth.json). */
function listAppKeys() {
  if (!fs.existsSync(CONFIG_DIR)) return [];
  return fs
    .readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.auth.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

/**
 * Resolve which app config to use. Explicit key wins; otherwise the single
 * existing config; otherwise fail with guidance.
 * @param {string} [explicit]
 * @returns {string}
 */
function resolveAppKey(explicit) {
  if (explicit) return explicit;
  const keys = listAppKeys();
  if (keys.length === 1) return keys[0];
  if (keys.length === 0) {
    throw new Error(
      `No config found in ${CONFIG_DIR}. Run /docs-setup first.`
    );
  }
  throw new Error(
    `Multiple app configs found (${keys.join(', ')}). Pass --app <key>.`
  );
}

/**
 * @param {Record<string, any>} base
 * @param {Record<string, any>} [patch]
 * @returns {Record<string, any>}
 */
function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * @param {string} appKey
 * @returns {AppConfig}
 */
function loadConfig(appKey) {
  const file = configPath(appKey);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Config not found: ${file}. Run /docs-setup (or /docs-setup auth --app ${appKey}).`
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Config ${file} is not valid JSON: ${err.message}`);
  }
  const config = deepMerge(deepMerge(DEFAULTS, raw), { appKey });
  for (const field of ['store', 'appHandle']) {
    if (!config[field]) {
      throw new Error(`Config ${file} is missing required field "${field}".`);
    }
  }
  if (!config.storageState) config.storageState = authPath(appKey);
  config.storageState = expandHome(config.storageState);
  return /** @type {AppConfig} */ (config);
}

/**
 * Merge a patch into the config file, creating it if needed.
 * @param {string} appKey
 * @param {Record<string, any>} patch
 */
function saveConfig(appKey, patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const file = configPath(appKey);
  let existing = {};
  if (fs.existsSync(file)) {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const merged = deepMerge(existing, patch);
  merged.appKey = appKey;
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

/**
 * Minimal argv parser: --flag value / --flag (boolean).
 * @param {string[]} argv
 * @returns {Args}
 */
function parseArgs(argv) {
  /** @type {Args} */
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

module.exports = {
  CONFIG_DIR,
  DEFAULTS,
  expandHome,
  configPath,
  authPath,
  listAppKeys,
  resolveAppKey,
  loadConfig,
  saveConfig,
  parseArgs,
};
