/** Standalone helpers. Node-only, no shell, so every script runs on Windows,
 *  macOS, Linux and in a cloud session without a bash or python dependency.
 *  Imports nothing from this repo: jamci.mjs copies this file into game repos
 *  (.jam/core.mjs) and to micahlagrange/jam-ci, where ../../paths does not exist.
 *  Anything that needs the machine-specific folders belongs in lib.mjs instead. */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const argv = process.argv.slice(2);
export const flag = (n, d = null) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
export const has = (n) => argv.includes(n);
export const positional = (valueFlags = []) =>
  argv.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(argv[i - 1]));

/** Run a program without a shell. Never throws: {code, out (stdout+stderr), stdout}. */
export const sh = (cmd, args, cwd, timeout = 300000, env = undefined) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, shell: false, env });
  return { code: r.status ?? -1, out: ((r.stdout || '') + (r.stderr || '')).trim(), stdout: (r.stdout || '').trim() };
};
export const git = (cwd, ...a) => sh('git', a, cwd);

/** The GitHub CLI. GH_BIN (+ GH_BIN_ARGS, a JSON array) lets a test stand in a fake.
 *  `env` replaces the child's environment (default: inherit), for a call under another token. */
export const gh = (args, cwd, timeout = 60000, env = undefined) =>
  sh(process.env.GH_BIN || 'gh', [...JSON.parse(process.env.GH_BIN_ARGS || '[]'), ...args], cwd, timeout, env ?? ghEnvFor(args));

/** Optional hook: given gh's args, an env to run them under (e.g. the Jam Hub github app's token) or undefined for the
 *  normal login. Unset in workflows, where GH_TOKEN is already the right token; hub.mjs installs appauth's. */
let ghEnvFor = () => undefined;
export const setGhEnvProvider = (fn) => { ghEnvFor = fn || (() => undefined); };
/** gh whose stdout is JSON; null when it fails or is not JSON. */
export const ghJson = (args, cwd, timeout, env = undefined) => {
  const r = gh(args, cwd, timeout, env);
  if (r.code) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
};

/** Block the thread for ms (scripts here are sequential, so no async needed). */
export const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** Inline the engine into a template's <script id="jamkit"> placeholder, so
 *  the result is one file with zero external requests. */
export function inlineKit(templatePath, outPath) {
  const html = readFileSync(templatePath, 'utf8');
  const js = readFileSync(join(SKILL, 'assets', 'jamkit.js'), 'utf8');
  if (!html.includes('/*JAMKIT*/')) throw new Error(`${basename(templatePath)} lost its /*JAMKIT*/ marker`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html.replace('/*JAMKIT*/', '\n' + js + '\n'));
  return outPath;
}

export function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

export function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(p.slice(base.length + 1).split('\\').join('/'));
  }
  return out;
}

export const human = (n) => n < 1024 ? `${n}B`
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)}K` : `${(n / 1024 ** 2).toFixed(1)}M`;

/** Resolve Playwright from the skill, then anywhere node can see it.
 *  Returns null rather than throwing, so callers can degrade with advice. */
export async function loadPlaywright() {
  const local = pathToFileURL(join(SKILL, 'node_modules', 'playwright', 'index.js')).href;
  for (const spec of [local, 'playwright', 'playwright-core']) {
    try {
      const mod = await import(spec);
      // playwright is CJS: the namespace exposes it under .default when
      // imported from ESM, but a real ESM build would not. Accept either.
      const pw = mod?.chromium ? mod : mod?.default;
      if (pw?.chromium) return pw;
    } catch { /* try next */ }
  }
  return null;
}

export function needPlaywright() {
  console.error(`
  This step needs Playwright, which isn't installed for this skill.

    node ${join(SKILL, 'scripts', 'setup.mjs')}

  (installs playwright + a headless Chromium into the skill, ~150MB, once.)

  Everything else -- scaffolding, building and publishing a game -- works
  without it. Only the headless test pass and the page-recon tool need it.
`);
}
