#!/usr/bin/env node
/**
 * epicpr.mjs -- the deploy half of an epic, run by a game's "epic" GitHub
 * Actions workflow: its epic-merge job when Micah approves an epic pull request
 * on GitHub, its epic-finish job when the pull request closes as merged. It
 * runs from .jam-ci/scripts/, a checkout of the public mirror
 * micahlagrange/jam-ci (jamci.mjs mirror), together with core.mjs, bodies.mjs
 * and itchcheck.mjs, so it imports nothing else from this repo.
 *
 * No network call here goes to any AI service, and nothing here reads or
 * writes the Jam Hub dashboard or the project board (the default Actions token
 * cannot reach a user-owned project; the board only shows state). Only gh
 * (issues, pull requests, workflow runs), an itch page GET and one Discord
 * webhook POST.
 *
 *   merge         merge the approved pull request (head still the approved commit, no conflict, checks green)
 *   issue-of      the epic issue a pull request says "Refs #N" to, and when it merged
 *   wait-publish  wait for the publish workflow run of a commit to finish
 *   verify-itch   wait until the itch page shows an update newer than --since
 *   finish        comment the outcome on the issue (and close it when deployed)
 *
 * Every step is safe to run again after a failure: a merged PR is skipped and a
 * closed issue is not closed twice.
 * Exit codes: 0 ok, 1 failed, 2 usage, 3 merge conflict, 4 head moved since review, 5 checks not green.
 * Details of the whole flow: references/epic-workflow.md.
 */
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argv, flag, gh, ghJson, sleep } from './core.mjs';
import { checkUrl } from './itchcheck.mjs';
import { EPIC_PREFIX, markerOf, setMarker } from './bodies.mjs';

export { EPIC_PREFIX };
const now = () => new Date().toISOString();
const log = (s) => console.error(s);

export const RESULT_MARKER = 'epic-result';
export const ISSUE_DEPLOY_FIELDS = 'number,title,state,body,comments';
export const PR_DEPLOY_FIELDS = 'number,title,state,body,headRefName,baseRefName,headRefOid,mergeable,mergedAt,mergeCommit';
/** The outcomes that leave the epic issue open (the pull request stays open or is re-approved). */
export const FAILED_OUTCOMES = ['ship-failed', 'conflict', 'stale', 'checks-failed', 'deploy-unverified'];

export class ShipError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

// ------------------------------------------------------------------ issue helpers
/** Rewrite one hidden marker in an issue body, reading the body fresh so no other edit is lost. */
export function markIssue(repo, number, name, value) {
  const issue = ghJson(['issue', 'view', String(number), '--repo', repo, '--json', 'body']);
  if (!issue) throw new Error(`cannot read ${repo}#${number}`);
  const dir = mkdtempSync(join(tmpdir(), 'mark-'));
  try {
    const file = join(dir, 'body.md');
    writeFileSync(file, setMarker(issue.body, name, value));
    const r = gh(['issue', 'edit', String(number), '--repo', repo, '--body-file', file]);
    if (r.code) throw new Error(`gh issue edit #${number} failed: ${r.out.slice(0, 300)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The epic issue a PR refers to: `<!-- epic-issue N -->` or `Refs #N` in its body. */
export const issueOf = (body = '') => {
  const m = String(body).match(/(?:epic-issue\s+|Refs\s+#)(\d+)/i);
  return m ? Number(m[1]) : null;
};

/** Who may write the sections and markers the automation acts on: the repo owner, the Jam Hub app, and the workflows'
 *  own GITHUB_TOKEN (epic-finish comments the epic-result as github-actions). Anyone else can comment on a public repo. */
export const TRUSTED_BOTS = ['micahlagrange-jam-hub', 'github-actions'];
const loginOf = (c) => String(c?.author?.login || '').replace(/^app\//, '').replace(/\[bot\]$/, '').toLowerCase();

/** The comments written by the repo owner or a trusted bot; a comment with no author is dropped. */
export function trustedComments(comments = [], repo = '') {
  const owner = String(repo).split('/')[0].toLowerCase();
  return (comments || []).filter((c) => { const login = loginOf(c); return login && (login === owner || TRUSTED_BOTS.includes(login)); });
}

/** The newest `epic-result` comment of an issue as {outcome, at, ...}, or null. */
export function lastResult(comments = []) {
  const re = new RegExp(`<!--\\s*${RESULT_MARKER}\\s+(\\{.*?\\})\\s*-->`);
  const results = comments.flatMap((c) => {
    try { return [JSON.parse((String(c.body || '').match(re) || [])[1])]; } catch { return []; }
  });
  return results.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).pop() || null;
}

// ------------------------------------------------------------------ checks + merge
/** Pure: fold check runs + legacy statuses into pass | fail | pending | none. */
export function judge(runs = [], statuses = [], ignore = []) {
  const relevant = runs.filter((r) => !ignore.includes(r.name));
  const bad = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'];
  if (relevant.some((r) => r.status === 'completed' && bad.includes(r.conclusion))) return 'fail';
  if (statuses.some((s) => ['failure', 'error'].includes(s.state))) return 'fail';
  if (!relevant.length && !statuses.length) return 'none';
  if (relevant.some((r) => r.status !== 'completed') || statuses.some((s) => s.state === 'pending')) return 'pending';
  return 'pass';
}

/** Pure: drop the check runs of workflow run `runId`. The merge job runs inside the run it waits on, so
 *  counting its own check run (always in progress) would make it wait for itself until the timeout. */
export const withoutRun = (runs = [], runId = '') =>
  runId ? runs.filter((r) => !String(r.details_url || '').includes(`/actions/runs/${runId}/`)) : runs;

/** Wait until every check on the commit passed. Throws ShipError 5 on a failure, no checks, or a timeout. */
export function waitChecks(repo, sha, { ignore = [], timeout = 1800000, grace = 180000 } = {}) {
  const start = Date.now();
  for (;;) {
    const runs = withoutRun(ghJson(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '-q', '.check_runs']) || [], process.env.GITHUB_RUN_ID);
    const statuses = ghJson(['api', `repos/${repo}/commits/${sha}/status`, '-q', '.statuses']) || [];
    const verdict = judge(runs, statuses, ignore);
    log(`checks on ${sha.slice(0, 7)}: ${verdict} (${runs.length} runs)`);
    if (verdict === 'pass') return;
    if (verdict === 'fail') throw new ShipError(`a check failed on ${sha.slice(0, 7)}`, 5);
    if (verdict === 'none' && Date.now() - start > grace) throw new ShipError(`no checks ran on ${sha.slice(0, 7)}; refusing to merge untested work`, 5);
    if (Date.now() - start > timeout) throw new ShipError(`checks still pending after ${timeout / 1000}s`, 5);
    sleep(20000);
  }
}

const viewPr = (repo, number) => {
  const pr = ghJson(['pr', 'view', String(number), '--repo', repo, '--json', PR_DEPLOY_FIELDS]);
  if (!pr) throw new ShipError(`cannot read PR #${number}`, 1);
  return pr;
};

/** Merge one reviewed PR: the head must still be the reviewed commit, it must not conflict and its checks must be green.
 *  An already merged PR is skipped. Returns {merged, note}. `wait`, `settle` and `rebaseable` are injectable for tests. */
export function mergePr(repo, { number, sha }, { wait = waitChecks, settle = () => sleep(3000), rebaseable = canRebase } = {}) {
  let pr = viewPr(repo, number);
  if (pr.state === 'MERGED') return { merged: false, note: `PR #${number} is already merged` };
  if (pr.state !== 'OPEN') throw new ShipError(`PR #${number} is ${pr.state.toLowerCase()}, not open`, 1);
  if (pr.headRefOid !== sha) throw new ShipError(`PR #${number} moved after review: reviewed ${sha.slice(0, 7)}, now ${pr.headRefOid.slice(0, 7)}`, 4);
  for (let i = 0; i < 5 && pr.mergeable === 'UNKNOWN'; i++) { settle(); pr = viewPr(repo, number); }
  if (pr.mergeable === 'CONFLICTING') throw new ShipError(`PR #${number} conflicts with the main line`, 3);
  wait(repo, sha, { ignore: [] });
  // Only the merge itself runs under GH_MERGE_TOKEN (the Jam Hub github app's token): its push starts
  // the publish workflow, which a push with the default Actions token would not. The reads above
  // stay on GH_TOKEN because the app lacks checks/statuses read.
  const env = process.env.GH_MERGE_TOKEN ? { ...process.env, GH_TOKEN: process.env.GH_MERGE_TOKEN } : undefined;
  const method = mergeMethodOf(rebaseable(repo, number));
  const m = gh(['pr', 'merge', String(number), '--repo', repo, `--${method}`, '--match-head-commit', sha], undefined, 60000, env);
  if (m.code) throw new ShipError(`gh pr merge #${number} failed: ${m.out.slice(0, 300)}`, /head (branch|commit)|match/i.test(m.out) ? 4 : 1);
  return { merged: true, note: `merged PR #${number} (${method})` };
}

/** Pure: how an epic is merged. Rebase keeps main a straight line of the branch's commits. When GitHub will not rebase it
 *  safely (the worker brought main in with a merge commit to settle a conflict: a rebase would replay the old commits
 *  and drop that resolution), squash: still one straight commit on main, and it keeps the resolution. */
export const mergeMethodOf = (canBeRebased) => (canBeRebased ? 'rebase' : 'squash');

/** GitHub's own answer to "can this pull request be rebased onto its base without changing the result". False when it
 *  cannot tell. */
function canRebase(repo, number) {
  const [owner, name] = repo.split('/');
  const r = ghJson(['api', 'graphql', '-f', `query=query{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${Number(number)}){canBeRebased}}}`]);
  return Boolean(r?.data?.repository?.pullRequest?.canBeRebased);
}

function cmdMerge() {
  const repo = need('--repo', process.env.GITHUB_REPOSITORY);
  const specs = need('--prs').split(',').filter(Boolean).map((p) => { const [number, sha] = p.split('='); return { number: Number(number), sha }; });
  for (const spec of specs) log(mergePr(repo, spec).note);
}

// ------------------------------------------------------------------ issue-of + wait-publish
function cmdIssueOf() {
  const repo = need('--repo', process.env.GITHUB_REPOSITORY), number = need('--pr');
  const pr = ghJson(['pr', 'view', String(number), '--repo', repo, '--json', 'body,mergedAt']);
  if (!pr) fail(`cannot read PR #${number}`);
  // An issue is optional: a pull request that does not say "Refs #N" is an ordinary change, and the workflows skip the epic reporting.
  const issue = issueOf(pr.body) || '';
  setOutput('issue', issue);
  setOutput('merged_at', pr.mergedAt || '');
  console.log(issue ? JSON.stringify({ issue, mergedAt: pr.mergedAt || null }) : `PR #${number} has no epic issue ("Refs #N"): nothing to report`);
}

/** Wait for the publish workflow run of --sha: the merge push starts it, so it may not exist yet. */
function cmdWaitPublish() {
  const repo = need('--repo', process.env.GITHUB_REPOSITORY), sha = need('--sha');
  const workflow = flag('--workflow') || 'publish.yml';
  const timeout = +(flag('--timeout') || 1800) * 1000, grace = 180000, start = Date.now();
  for (;;) {
    const runs = ghJson(['run', 'list', '--repo', repo, '--commit', sha, '--workflow', workflow, '--json', 'databaseId,status,conclusion']) || [];
    const run = runs[0];
    if (run) {
      log(`publish run ${run.databaseId} on ${sha.slice(0, 7)}: ${run.status}`);
      const w = gh(['run', 'watch', String(run.databaseId), '--repo', repo, '--exit-status'], undefined, timeout);
      setOutput('result', w.code ? 'failure' : 'success');
      if (w.code) fail(`the publish run ${run.databaseId} failed`);
      return;
    }
    if (Date.now() - start > grace) fail(`no ${workflow} run started for ${sha.slice(0, 7)}`);
    log(`no ${workflow} run for ${sha.slice(0, 7)} yet`);
    sleep(15000);
  }
}

// ------------------------------------------------------------------ verify
function cmdVerifyItch() {
  const url = need('--url'), since = Date.parse(need('--since')) - 60000;
  const password = flag('--password') || process.env.ITCH_PAGE_PASSWORD || null;
  const timeout = +(flag('--timeout') || 600) * 1000, start = Date.now();
  return (async () => {
    for (;;) {
      const page = await checkUrl(url, password).catch((e) => ({ unlocked: false, note: e.message }));
      const fresh = page.unlocked && page.updated && Date.parse(page.updated) >= since;
      log(`itch: unlocked=${page.unlocked} updated=${page.updated} fresh=${!!fresh}`);
      if (fresh) { console.log(JSON.stringify(page)); return; }
      if (Date.now() - start > timeout) fail(page.unlocked ? 'the itch page has not updated yet (it may still be processing)' : `the itch page did not unlock: ${page.note || page.status}`);
      sleep(15000);
    }
  })();
}

/** One Discord webhook POST, mentions off. The review notice (epics.mjs) goes out this way. */
export async function postDiscord(webhook, content) {
  const res = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
  if (!res.ok) throw new Error(`Discord webhook answered ${res.status}`);
}

// ------------------------------------------------------------------ finish
const HEADLINES = {
  'deployed': 'Published and verified on itch. Closing this issue.',
  'deploy-unverified': 'Published, but the itch page is not confirmed. Re-run the epic workflow to retry.',
  'ship-failed': 'Not deployed; see the run.',
  'conflict': 'MERGE_ERROR_CONFLICT: not merged, the pull request conflicts with the main line. The card goes back to backlog and Claude brings main into the branch; approve the pull request again afterwards.',
  'stale': 'Not merged: the pull request changed after the approval. Review and approve the new commits.',
  'checks-failed': 'Not merged: the checks did not pass.',
};

/** Comment the outcome on the epic issue; when deployed, close it (once). A failed outcome leaves it open. */
export function finishIssue({ repo, issue, outcome, sha = null, url = null, detail = null }) {
  if (!HEADLINES[outcome]) throw new Error(`unknown outcome ${outcome}`);
  const result = { outcome, sha, runUrl: url, at: now() };
  const body = [`**${HEADLINES[outcome]}**`, detail ? `\n${detail}` : '', url ? `\n[Run](${url})` : '', `\n<!-- ${RESULT_MARKER} ${JSON.stringify(result)} -->`].join('\n');
  const c = gh(['issue', 'comment', String(issue), '--repo', repo, '--body', body]);
  if (c.code) throw new Error(`gh issue comment #${issue} failed: ${c.out.slice(0, 300)}`);
  if (outcome !== 'deployed') return;
  const state = ghJson(['issue', 'view', String(issue), '--repo', repo, '--json', 'state']);
  if (state?.state === 'OPEN') {
    const closed = gh(['issue', 'close', String(issue), '--repo', repo, '--reason', 'completed']);
    if (closed.code) throw new Error(`gh issue close #${issue} failed: ${closed.out.slice(0, 300)}`);
  }
}

function cmdFinish() {
  finishIssue({ repo: need('--repo', process.env.GITHUB_REPOSITORY), issue: need('--issue'), outcome: need('--outcome'), sha: flag('--sha'), url: flag('--url'), detail: flag('--detail') });
}

// ------------------------------------------------------------------ plumbing
function need(name, fallback = null) {
  const v = flag(name) || fallback;
  if (!v) { console.error(`missing ${name}`); process.exit(2); }
  return v;
}
function fail(message, code = 1) { throw new ShipError(message, code); }
function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${String(v ?? '').replace(/\r?\n/g, ' ')}\n`);
}

const COMMANDS = { merge: cmdMerge, 'issue-of': cmdIssueOf, 'wait-publish': cmdWaitPublish, 'verify-itch': cmdVerifyItch, finish: cmdFinish };

async function main() {
  const fn = COMMANDS[argv[0]];
  if (!fn) { console.error(`usage: epicpr.mjs ${Object.keys(COMMANDS).join('|')} [flags]  (see the header)`); process.exit(2); }
  try { await fn(); }
  catch (e) { console.error(`epicpr ${argv[0]}: ${e.message}`); process.exit(e instanceof ShipError ? e.code : 1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
