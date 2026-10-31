/**
 * itchcheck.mjs -- look at an itch page the way a visitor does, getting through
 * its password gate if it has one. Pure HTTP, no browser, no itch key, so it
 * runs on a GitHub Actions runner as well as here. Read-only.
 *
 *   node itchcheck.mjs https://multivoxmuse.itch.io/mygame --password P
 *
 * Prints one JSON line {url, status, gated, unlocked, title, updated, embed}
 * and exits 0 when the page is unlocked, 1 when not.
 *
 * The gate is a form that POSTs game_password to <page>/password with the
 * page's CSRF token and cookie.
 */
import { pathToFileURL } from 'node:url';
import { argv, flag } from './core.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const GATE = /name="game_password"/;

const decode = (s) => s && s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export async function checkUrl(target, password = null) {
  const jar = new Map();
  const store = (res) => { for (const line of res.headers.getSetCookie?.() || []) { const kv = line.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function go(url, init = {}) {
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'user-agent': UA, cookie: cookie(), ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
      store(res);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).href; init = {}; continue; }
      return { res, html: await res.text(), url };
    }
    throw new Error('too many redirects');
  }
  const url = target.replace(/\/+$/, '');
  let { res, html } = await go(url);
  const gated = GATE.test(html);
  let unlocked = !gated && res.status === 200;
  if (gated && password) {
    const csrf = (html.match(/name="csrf_token" value="([^"]+)"/) || [])[1];
    const form = new URLSearchParams({ csrf_token: csrf || '', game_password: password, return_to: url });
    ({ res, html } = await go(`${url}/password`, { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded', referer: url } }));
    if (GATE.test(html)) ({ res, html } = await go(url));   // the POST may land on a bare page; look at the page itself
    unlocked = !GATE.test(html) && res.status === 200;
  }
  const abbr = (html.match(/Updated<\/td>\s*<td>\s*<abbr[^>]*title="([^"]+)"/i) || [])[1];
  const when = abbr ? new Date(abbr.replace(' @ ', ' ')) : null;
  const out = {
    url, status: res.status, gated, unlocked,
    title: unlocked ? (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || null : null,
    updated: unlocked && when && !isNaN(when) ? when.toISOString() : null,
    embed: unlocked ? ((decode((html.match(/data-iframe="([^"]+)"/) || [])[1]) || '').match(/src="([^"]+)"/) || [])[1] || null : null,
  };
  if (gated && !password) out.note = 'page has a password gate and no --password was given';
  if (gated && password && !unlocked) out.note = 'the password was not accepted';
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--password');
  if (!url) { console.error('usage: itchcheck.mjs <page url> [--password P]'); process.exit(2); }
  const out = await checkUrl(url, flag('--password') || process.env.ITCH_PAGE_PASSWORD || null);
  console.log(JSON.stringify(out));
  process.exit(out.unlocked ? 0 : 1);
}
