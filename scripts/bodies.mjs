/** Pure text helpers for epic issues and their pull requests: hidden markers,
 *  "### Section" blocks and the closing keywords. Imports nothing, because
 *  jamci.mjs mirrors this file to micahlagrange/jam-ci next to epicpr.mjs,
 *  which needs it to read the reviewed commits. */

export const EPIC_PREFIX = 'epic/';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------ hidden markers: <!-- name value -->
const markerRe = (name) => new RegExp(`[ \\t]*<!--\\s*${escapeRe(name)}(?:\\s+(.*?))?\\s*-->`);

/** The value of a marker (a string, '' when it has none), or null when the text has no such marker. */
export function markerOf(text, name) {
  const m = String(text || '').match(markerRe(name));
  return m ? (m[1] ?? '') : null;
}

/** The text with the marker set to value (null removes it). Keeps everything else, line endings included. */
export function setMarker(text, name, value) {
  const base = String(text || '');
  const nl = base.includes('\r\n') ? '\r\n' : '\n';
  const without = base.replace(new RegExp(`(?:\\r?\\n)*${markerRe(name).source}`), '');
  if (value === null) return without;
  return `${without}${without ? nl + nl : ''}<!-- ${name}${value === '' ? '' : ` ${value}`} -->`;
}

/** reviewed marker: the head commit of each pull request when the card went to review. {7: 'abc'} <-> '7=abc'. */
export const formatReviewed = (map) => Object.entries(map).map(([n, sha]) => `${n}=${sha}`).join(',');
export const parseReviewed = (value) => Object.fromEntries(String(value || '').split(',').filter(Boolean).map((p) => p.split('=')));

// ------------------------------------------------------------------ sections: "### Title" blocks
/** The trimmed, non-empty text of every "### <title>" block in the text (case-insensitive), in order. */
export function sectionTexts(text, title) {
  const re = new RegExp(`^###[ \\t]+${escapeRe(title)}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^###[ \\t]|^<!--|(?![\\s\\S]))`, 'gim');
  return [...String(text || '').matchAll(re)].map((m) => m[1].trim()).filter(Boolean);
}

export const urlsIn = (text) => [...String(text || '').matchAll(/https?:\/\/[^\s)<>\]]+/g)].map((m) => m[0].replace(/[.,;]+$/, ''));

/** The playtest links of an epic issue body ("### Playtest"). */
export const artifactUrls = (body) => urlsIn(sectionTexts(body, 'Playtest').join('\n'));


// ------------------------------------------------------------------ pull request <-> issue links
export const CLOSING_WORDS = 'close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved';
// `#n`, or `owner/repo#n` naming this repo: `Refs micahlagrange/skills#17` is not issue 17 of a game. With no repo
// given, any `owner/repo#` prefix counts.
const issueRef = (n, repo) => `(?:${repo ? escapeRe(String(repo)) :'[\\w.-]+\\/[\\w.-]+'})?#${n}(?!\\d)`;

/** Does this PR body say `Refs #n` (of `repo`, when given)? */
export const refsIssue = (body, n, repo) => new RegExp(`\\bRefs?\\s*:?\\s+${issueRef(n, repo)}`, 'i').test(String(body || ''));
/** Does it use a GitHub closing keyword for #n (merging would close the issue early)? */
export const closesIssue = (body, n, repo) => new RegExp(`\\b(?:${CLOSING_WORDS})\\s*:?\\s+${issueRef(n, repo)}`, 'i').test(String(body || ''));

/** Pull request numbers named in text: `#12` or `.../pull/12`. */
export const prNumbersIn = (text) => [...new Set([...String(text || '').matchAll(/(?:#|\/pull\/)(\d+)/g)].map((m) => Number(m[1])))];

// ------------------------------------------------------------------ the playtest rule
const WIKI = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/wiki(?:[/?#]|$)/i;
export const isWikiUrl = (url) => WIKI.test(url);

/** A GitHub page about the work (pull request, Actions run, issue, commit), not a build anyone can play. */
const isReviewPage = (u) => /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(pull|pulls|actions|issues|commit|commits)(\/|$)/i.test(u);

/** Pure: is the playtest part of an epic present? Either a direct link, or a GitHub wiki page
 *  plus an "### Artifact parameters" block of `key: value` lines (build, commit, artifact, platform, steps...). */
export function playtestProblem(text) {
  const urls = urlsIn(sectionTexts(text, 'Playtest').join('\n'));
  if (!urls.length) return 'no playtest link: add a "### Playtest" section with a link (or a GitHub wiki page plus "### Artifact parameters")';
  if (urls.some((u) => !isWikiUrl(u) && !isReviewPage(u))) return null;
  if (urls.some(isReviewPage)) return 'the playtest link is a pull request, CI run, issue or commit page, which cannot be played: link a playable build of the PR version (a Claude artifact, a tailnet-hosted build or an html file) that Micah plays himself';
  const params = sectionTexts(text, 'Artifact parameters').join('\n');
  return /^[ \t]*[-*]?[ \t]*[\w .\/-]+:[ \t]*\S/m.test(params) ? null
    : 'the playtest link is a wiki page, so add an "### Artifact parameters" block of `key: value` lines (build number, commit sha, artifact name or run URL, platform, launch steps)';
}
