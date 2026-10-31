# jam-ci

The GitHub Actions that build, test, publish and deploy Micah's jam games. Every
game repo commits two small workflow stubs that call the reusable workflows here;
the steps live in one place and a game edits only its inputs.

This repo is a mirror. Its source is `game-jam/ci/` in `micahlagrange/skills`,
copied here by that repo's `mirror-jam-ci` Action on every push to main. Do not
edit here: change the skills repo and let the mirror land.

## What a game commits

`.github/workflows/publish.yml`, the build, on every push and by hand:

```yaml
on: [push, workflow_dispatch]
jobs:
  publish:
    uses: micahlagrange/jam-ci/.github/workflows/publish-html.yml@main   # or publish-love.yml
    with:
      itch_game: 'nightfall-survivor'
    secrets: inherit
```

`.github/workflows/epic.yml`, the git-only epic flow. The approval and the merge
happen on GitHub, not on the Jam Hub board:

1. Micah approves an epic pull request (one that says `Refs #N`). The stub's
   `merge` job calls `epic-merge.yml` with the approved commit. It merges with
   the Jam Hub app's token when the head is still that commit, there is no
   conflict and every check is green; otherwise it comments the refusal on the
   epic issue and leaves the pull request open.
2. The merge push on the default branch runs the game's own `publish.yml`.
   (A merge made with `GITHUB_TOKEN` would start no push run; the app token does.)
3. The pull request closes as merged. The stub's `finish` job calls
   `epic-finish.yml`, which waits for that publish run, checks the itch page,
   posts the announcement to Discord and comments the outcome on the issue,
   closing it when deployed. A pull request Micah merges by hand gets the same.

A `.jam/` line in `.gitignore`. The local test harness (`smoke.mjs`, `core.mjs`)
is copied there, never committed; the workflows fetch the same files from this
repo's `scripts/`.

Both stubs are rendered by `game-jam/scripts/jamci.mjs vend` in the skills repo
(`itchci.mjs` for a new game, `rollout-ci.mjs` for existing ones). Re-vending
keeps the inputs it finds in the existing stub.

## Workflows

| Workflow | Inputs | Does |
|---|---|---|
| `publish-html.yml` | `itch_user` (default `multivoxmuse`), `itch_game` | `npm ci`, Playwright Chromium, `npm test`, upload `index.html` as an artifact; on the default branch only, `butler push --if-changed` to `<user>/<game>:html`. |
| `publish-love.yml` | `itch_user`, `itch_game`, `game_name`, `test`, `makelove` (default `makelove==0.0.13`), `post_build` | makelove builds love/web/linux/win64/macos, uploads each; on the default branch only, butler pushes the html/linux/windows/osx channels. |
| `epic-merge.yml` | `pr`, `sha` | `epicpr.mjs merge`: the head is still `sha`, no conflict, checks green, then merge with the app token. A refusal is commented on the epic issue as `conflict`, `stale`, `checks-failed` or `ship-failed`. |
| `epic-finish.yml` | `pr`, `sha`, `itch_url` | `issue-of`, `wait-publish` (the publish run of the merge commit), `verify-itch`, `announce` on Discord, `finish`: comment the outcome (`deployed`, `ship-failed`, `deploy-unverified`) and close the issue when deployed. |

Publishing happens only when `github.ref` is the caller's default branch; every
other push builds and tests. Nothing here calls an AI service.

## Secrets and variables (per game repo)

- `BUTLER_CREDENTIALS`: itch API key. Missing: the publish step warns and skips.
- `DISCORD_WEBHOOK_URL`: the announce webhook. Missing: announce logs and skips.
- Variable `ITCH_PAGE_PASSWORD`: page token of a not-yet-public itch page, for the itch check (default `yourmum`).

- Secret `JAM_HUB_APP_KEY` and variable `JAM_HUB_APP_ID`: the Jam Hub GitHub App
  (`micahlagrange-jam-hub`), which `epic-merge` merges with. Missing: the merge job fails.

`secrets: inherit` in the stubs passes them through.

## Mirroring

`micahlagrange/skills/.github/workflows/mirror-jam-ci.yml` mints a token for the
Jam Hub app (the same secret and variable, set on the skills repo), checks this
repo out with it, runs `node game-jam/scripts/jamci.mjs mirror jam-ci` and
pushes. `game-jam/ci/github-app.md` in the skills repo describes the app.
