#!/usr/bin/env node
/**
 * smoke.mjs -- the whole QA pass for a jam game in a few seconds.
 *
 *   node smoke.mjs build/game.html              # local file (auto-served)
 *   node smoke.mjs https://claude.site/...       # a published artifact
 *   node smoke.mjs game.html --seconds 60 --shots shots/
 *
 * It drives the window.__JAM harness that jamkit installs, so a full
 * minute of play is simulated in milliseconds with no wall-clock waiting --
 * which is why this is fast enough to run after every edit.
 *
 * Checks, in order (first hard failure stops the run):
 *   boot        page loads, no console/page errors, __JAM present
 *   paint       canvas is actually drawn, not a blank rectangle
 *   lifecycle   start -> simulate play -> a timed game ends; an untimed one
 *               is still running (or ended cleanly) with no errors
 *   scoring     the bot scored points (warn-only: not every game has a score)
 *   audio       sounds were triggered
 *   determin.   same seed + same inputs => identical score
 *   realtime    live rAF frame rate over ~1.5s (catches a 10fps game)
 *   mobile      renders at 390x844 with no horizontal overflow
 */
import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { extname, resolve, dirname, basename } from 'node:path';
import { loadPlaywright, needPlaywright } from './core.mjs';

const pw = await loadPlaywright();
if (!pw) { needPlaywright(); process.exit(3); }
const { chromium } = pw;

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const has = (n) => argv.includes(n);
const VALUE_FLAGS = new Set(['--seconds', '--seed', '--shots', '--bot', '--timeout']);
const target = argv.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));

if (!target || has('--help')) {
  console.log('usage: node smoke.mjs <file.html|url> [--seconds 60] [--seed 1] [--shots dir]');
  console.log('       [--bot bot.js] [--no-determinism] [--no-realtime] [--no-mobile] [--headed] [--json]');
  process.exit(target ? 0 : 2);
}

// A published Claude artifact cannot be driven from here: it is private (so a
// headless browser gets a 403), the wrapper page's CSP forbids evaluating
// script, and the game itself runs in a nested cross-origin iframe. Say so
// plainly rather than surfacing a CSP stack trace.
if (/claude\.(ai|site)\/artifact/.test(target)) {
  console.log(`
  Can't test a published artifact URL from here.
    - it is private: a headless browser gets a 403
    - the page CSP blocks the harness from evaluating script
    - the game runs inside a nested cross-origin iframe

  Test the local build instead -- it is byte-identical to what was published:
    node smoke.mjs $JAM_HOME/<name>/index.html

  Then open the artifact on your own device for the one thing automation
  cannot do: hear it and feel it.
`);
  process.exit(2);
}

const SECONDS = +flag('--seconds', 60);
const SEED = +flag('--seed', 1);
const SHOTS = flag('--shots', null);
const TIMEOUT = +flag('--timeout', 15000);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

// Serve over http even for local files: file:// blocks ES modules and fetch,
// so a game that works under a real server would fail here for the wrong reason.
async function serve(path) {
  const st = await stat(path).catch(() => null);
  if (!st) throw new Error('no such file: ' + path);
  const root = st.isDirectory() ? resolve(path) : dirname(resolve(path));
  const entry = st.isDirectory() ? 'index.html' : basename(path);
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || entry;
    try {
      const body = await readFile(resolve(root, rel));
      res.writeHead(200, { 'content-type': MIME[extname(rel).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/${entry}`, close: () => server.close() };
}

const results = [];
let hardFail = false;
function record(name, ok, detail, soft = false) {
  results.push({ name, ok, detail, soft });
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : soft ? '\x1b[33mWARN\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${name.padEnd(12)} ${detail}`);
  if (!ok && !soft) hardFail = true;
  return ok;
}

// Default bot: sweeps side to side and mashes action. Deterministic, and
// enough to score in any "move and collect" game. Override with --bot.
const DEFAULT_BOT = `(g, tick) => {
  const phase = Math.floor(tick / 28) % 2;
  __JAM.release(phase ? 'left' : 'right');
  __JAM.press(phase ? 'right' : 'left');
  // tap, don't hold: g.hit('action') only fires on the press edge
  if (tick % 15 === 0) __JAM.press('action');
  if (tick % 15 === 6) __JAM.release('action');
}`;

async function runRound(page, url, { seed, seconds, bot, shots }) {
  // Inject before any page script runs, so this works on URLs that drop query
  // strings (published artifacts, itch embeds) as well as local builds.
  await page.addInitScript(([t, s]) => { window.__JAM_TEST = t; window.__JAM_SEED = s; }, [1, seed]);
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}test=1&seed=${seed}`, {
    waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForFunction('window.__JAM && window.__JAM.ready', null, { timeout: TIMEOUT });
  if (shots) await page.screenshot({ path: `${shots}/1-title.png` });

  await page.evaluate('__JAM.start()');
  // Quarter-way first, so the mid-action screenshot catches the game being
  // played rather than a death screen. play() stops at round end, so a bot
  // that dies early may already have finished the round here.
  const mid = await page.evaluate(`__JAM.play(${seconds / 4}, ${bot})`);
  if (shots) await page.screenshot({ path: `${shots}/2-midgame.png` });
  const end = mid.state === 'over'
    ? mid
    : await page.evaluate(`__JAM.play(${seconds * 0.75 + 1}, ${bot})`);
  // Let the death flash and particles settle before the final frame, or the
  // screenshot is a full-screen red wash instead of the game-over screen.
  await page.evaluate('__JAM.step(24)');
  if (shots) await page.screenshot({ path: `${shots}/3-over.png` });
  return { mid, end };
}

const src = /^https?:\/\//.test(target) ? { url: target, close: () => {} } : await serve(target);
const browser = await chromium.launch({ headless: !has('--headed') });
const ctx = await browser.newContext({ viewport: { width: 480, height: 760 } });
const page = await ctx.newPage();

const errors = [];
const requests = [];   // everything the page fetches: must be nothing but itself
page.on('request', (r) => requests.push(r.url()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('requestfailed', (r) => errors.push(`request failed: ${r.url().slice(0, 90)}`));

if (SHOTS) await mkdir(SHOTS, { recursive: true });
const bot = flag('--bot') ? await readFile(flag('--bot'), 'utf8') : DEFAULT_BOT;
const t0 = Date.now();
console.log(`\n\x1b[1mjam smoke\x1b[0m  ${src.url}\n`);

try {
  // ---- boot -------------------------------------------------------------
  const boot = Date.now();
  const { mid, end } = await runRound(page, src.url, { seed: SEED, seconds: SECONDS, bot, shots: SHOTS });
  // Snapshot now: later checks reload the page, and those navigations would
  // otherwise look like subresources of the first one.
  const firstLoad = requests.slice();
  record('boot', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : `clean, ${Date.now() - boot}ms`);

  // ---- paint: count distinct pixels, a blank canvas has 1 ---------------
  const paint = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { colors: 0, err: 'no <canvas>' };
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add(`${d[i]},${d[i+1]},${d[i+2]}`);
    return { colors: seen.size, w: c.width, h: c.height };
  });
  record('paint', paint.colors >= 3, paint.err || `${paint.colors} distinct colors @ ${paint.w}x${paint.h}`);

  // ---- lifecycle --------------------------------------------------------
  // A timed game must reach 'over'. An untimed one has no obligation to end:
  // it passes if it is still playing after the simulated minute, or ended
  // through its own g.over(). What fails is a timed game that never ends.
  let lifeOk, why;
  if (end.timed) {
    lifeOk = end.state === 'over';
    why = end.clock <= 0 ? `timed, ran the full ${SECONDS}s`
        : lifeOk ? `timed, ended early at ${end.clock.toFixed(1)}s left (bot lost -- fine)`
        : `timed but never ended -- g.over() unreachable?`;
  } else {
    lifeOk = end.state === 'play' || end.state === 'over';
    why = end.state === 'over' ? `untimed, ended by game logic (${end.won ? 'won' : 'lost'})`
        : `untimed, still running after ${SECONDS}s simulated`;
  }
  record('lifecycle', lifeOk, `state=${end.state} frames=${end.frame}, ${why}`);

  // ---- scoring (soft: a puzzle or a toy may have no score at all) ---------
  record('scoring', end.score > 0, `mid=${mid.score} end=${end.score} best=${end.best}` +
    (mid.entities ? ` entities=${JSON.stringify(mid.entities)}` : '') +
    (end.score > 0 ? '' : ' -- fine if this game has no score; otherwise the bot cannot reach the mechanic'), true);

  // ---- audio ------------------------------------------------------------
  const kinds = [...new Set(end.sounds)];
  record('audio', kinds.length > 0, kinds.length ? `${end.sounds.length} plays, voices: ${kinds.join(',')}` : 'no sfx triggered', true);

  // ---- runtime errors during play ---------------------------------------
  record('no-errors', errors.length === 0 && end.errors.length === 0,
    [...errors, ...end.errors].slice(0, 3).join(' | ') || 'none');

  // ---- determinism ------------------------------------------------------
  if (!has('--no-determinism')) {
    const again = await runRound(page, src.url, { seed: SEED, seconds: SECONDS, bot, shots: null });
    record('determinism', again.end.score === end.score,
      `${end.score} vs ${again.end.score}` + (again.end.score === end.score ? '' : ' -- unseeded Math.random() in game logic?'), true);
  }

  // ---- realtime frame rate (no ?test=1, so rAF actually drives) ---------
  if (!has('--no-realtime')) {
    await page.goto(src.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction('window.__JAM && window.__JAM.ready', null, { timeout: TIMEOUT });
    const fps = await page.evaluate(() => new Promise((res) => {
      __JAM.g.start();
      let n = 0; const t = performance.now();
      const tick = () => { n++; performance.now() - t < 1500 ? requestAnimationFrame(tick) : res(n / ((performance.now() - t) / 1000)); };
      requestAnimationFrame(tick);
    }));
    record('realtime', fps >= 30, `${fps.toFixed(1)} fps live` + (fps < 30 ? ' -- too slow, cut work per frame' : ''), fps >= 20);
  }

  // ---- artifact-safe: the build must fetch nothing but itself -----------
  // A Claude artifact is one page on its own origin. Any subresource is a
  // thing that can 404 behind a CSP and leave the player a blank rectangle.
  const docUrl = firstLoad[0];
  const subresources = firstLoad.slice(1)
    .filter((u) => !u.startsWith('data:') && !/\/favicon\.ico$/.test(u));
  const crossOrigin = subresources.filter((u) => {
    try { return new URL(u).origin !== new URL(docUrl).origin; } catch { return true; }
  });
  record('artifact', crossOrigin.length === 0 && subresources.length === 0,
    subresources.length === 0 ? 'self-contained, 0 subresources'
      : `${subresources.length} subresource(s)` +
        (crossOrigin.length ? ` incl. ${crossOrigin.length} cross-origin: ${crossOrigin[0].slice(0, 60)}`
                            : ' -- inline them, or publish them as artifact files'),
    crossOrigin.length === 0);

  // ---- mobile: a real touch device, not just a narrow window ------------
  if (!has('--no-mobile')) {
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const mp = await mctx.newPage();
    const mErrors = [];
    mp.on('pageerror', (e) => mErrors.push(e.message));
    await mp.goto(src.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await mp.waitForFunction('window.__JAM && window.__JAM.ready', null, { timeout: TIMEOUT });

    // Tap to start: if this does not work, the game is unplayable on a phone
    // no matter how well it reads.
    await mp.locator('canvas').tap();
    await mp.waitForTimeout(250);
    const m = await mp.evaluate(() => {
      const c = document.querySelector('canvas').getBoundingClientRect();
      return {
        state: window.__JAM.g.state,
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        overflowY: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        canvasW: Math.round(c.width), canvasH: Math.round(c.height),
      };
    });
    if (SHOTS) await mp.screenshot({ path: `${SHOTS}/4-mobile.png` });
    await mctx.close();

    record('touch', m.state === 'play' && mErrors.length === 0,
      m.state === 'play' ? `tap starts the game on a touch device`
        : `tap did not start the game (state=${m.state}) -- unplayable on a phone`);
    record('mobile', m.overflowX <= 1,
      m.overflowX > 1 ? `${m.overflowX}px horizontal overflow at 390px`
        : `fits 390x844, canvas ${m.canvasW}x${m.canvasH}` +
          (m.overflowY > 1 ? ` (page scrolls ${m.overflowY}px -- players will have to scroll)` : ', no scrolling'));
  }

  const summary = { url: src.url, seed: SEED, seconds: SECONDS, score: end.score,
    frames: end.frame, ms: Date.now() - t0, results };
  if (has('--json')) console.log('\n' + JSON.stringify(summary, null, 2));
  console.log(`\n${hardFail ? '\x1b[31mFAILED\x1b[0m' : '\x1b[32mALL GREEN\x1b[0m'}  ${Date.now() - t0}ms` +
    (SHOTS ? `  shots: ${SHOTS}/` : '') + '\n');
} catch (e) {
  console.log(`  \x1b[31mFAIL\x1b[0m  harness      ${e.message.split('\n')[0]}`);
  if (errors.length) console.log('        page errors: ' + errors.slice(0, 5).join(' | '));
  hardFail = true;
} finally {
  await browser.close();
  src.close();
}
process.exit(hardFail ? 1 : 0);
