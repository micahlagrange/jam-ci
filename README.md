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

An issue is optional. A pull request with no `Refs #N` is an ordinary change:
approving it merges it and the merge push publishes it, and the epic reporting
(announcement, issue comment) is skipped, so nothing goes red.

1. Micah approves a pull request. The stub's
   `merge` job calls `epic-merge.yml` with the approved commit. It merges with
   the Jam Hub github app's token when the head is still that commit, there is no
   conflict and every check is green; otherwise it comments the refusal on the
   epic issue and leaves the pull request open. A pull request that conflicts
   before the approval gets no run (GitHub starts none without a merge
   commit): the conflict shows on the pull request and in the tick's
   `needs.conflict`.
2. The merge push on the default branch runs the game's own `publish.yml`.
   (A merge made with `GITHUB_TOKEN` would start no push run; the app token does.)
3. The pull request closes as merged. The stub's `finish` job calls
   `epic-finish.yml`, which waits for that publish run, checks the itch page,
   comments the outcome on the issue,
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
| `publish-love.yml` | `itch_user`, `itch_game`, `game_name`, `test`, `makelove` (default `makelove==0.0.13`), `pre_build` (after the tests, before makelove; the checkout has the full history, so it can stamp a build number from `git rev-list --count HEAD`), `post_build` | makelove builds love/web/linux/win64/macos, uploads each; on the default branch only, butler pushes the targets listed in makelove.toml (html, linux, windows, osx). |
| `publish-unity.yml` | `build_script` (`webgl.ps1`), `build_dir` (`Builds/WebGL`), `live_url` (the :10000 Funnel link) | Runs on the self-hosted runner `boogie`: builds WebGL with Unity in the runner's own workspace, stamps `build-info.txt` with the commit, uploads the build; on the default branch only, promotes it with `publish.ps1` from the homeserver repo and checks the live site serves that commit. No tests: a clean build is the gate. |
| `publish-godot.yml` | `project_dir` (folder with `project.godot`, default `.`), `godot_version` (`4.7.2`), `web_preset` (`Web`), `android` (`true`), `live_url` (the :10000 Funnel link) | Runs on the self-hosted runner `boogie`: installs the official Godot release and its Web and Android templates once (cached in `~/godot-ci`), imports and exports the Web preset (WebGL 2, no threads, so it plays on phones and in Firefox), stamps `build-info.txt`, uploads the build; builds a debug APK as a non-blocking artifact when the project has an `Android` preset; on the default branch only, promotes the web build with `publish.ps1` and checks the live site serves that commit. No tests: a clean export is the gate. |
| `epic-merge.yml` | `pr`, `sha` | `epicpr.mjs merge`: the head is still `sha`, no conflict, checks green, then merge with the app token. A refusal is commented on the epic issue as `conflict`, `stale`, `checks-failed` or `ship-failed`. |
| `epic-finish.yml` | `pr`, `sha`, `itch_url`, `play_url` | `issue-of`, `wait-publish` (the publish run of the merge commit), `verify-itch`, `finish`: comment the outcome (`deployed`, `ship-failed`, `deploy-unverified`) and close the issue when deployed. |

Publishing happens only when `github.ref` is the caller's default branch; every
other push builds and tests. Nothing here calls an AI service.

## Secrets and variables (per game repo)

- `BUTLER_CREDENTIALS`: itch API key. Missing: the publish step warns and skips.
- `DISCORD_WEBHOOK_URL`: no longer used by the epic flow (nothing is announced on Discord).
- Variable `ITCH_PAGE_PASSWORD`: page token of a not-yet-public itch page, for the itch check (default `yourmum`).

- Secret `JAM_HUB_APP_KEY`: the private key of the Jam Hub GitHub App
  (`micahlagrange-jam-hub`), which `epic-merge` merges with. Missing: the merge job fails.

`secrets: inherit` in the stubs passes them through.

## Unity games (Cryptid Corral)

A Unity game cannot build on GitHub's runners (the editor and its licence are on `boogie`) and is not on itch; it is played from the WebGL live server. Vend it with `node game-jam/scripts/jamci.mjs vend <project> --kind unity`: the `publish.yml` stub calls `publish-unity.yml` and the `epic.yml` stub passes `play_url` instead of `itch_url`, so `epic-finish` skips the itch check and puts the live link in the announcement. Everything else in the epic flow is unchanged.

One-time setup on `boogie`:

- Register a GitHub Actions runner for the game repo (Settings > Actions > Runners) with the label `boogie`, installed as a service that runs as Micah's Windows user (Unity is activated there). Set `HOMESERVER_DIR` in the runner's `.env` if the homeserver checkout is not `~\Documents\github\homeserver`.
- The repo must be private. A self-hosted runner runs the code of every pull request against it.
- The repo commits `webgl.ps1` and `Assets/Editor/PlaytestBuild.cs` (the build scripts for a Unity project; for a new Unity game copy them from the Unity project still kept in `micahlagrange/cryptid-corral`).
- Secret `JAM_HUB_APP_KEY` as for any game; `BUTLER_CREDENTIALS` is not used.

The runner (install, verify, restart, remove, debug, Unity licence, `HOMESERVER_DIR`) is documented and scripted in the game repo: `docs/ci-runner.md` and `ci/runner/install-runner.ps1` in `micahlagrange/cryptid-corral`. It is a Windows service running as `sixst`, labelled `boogie`.

Approving the pull request is the decision to publish to the public Funnel link. If the runner is offline, the build check never completes and `epic-merge` refuses to merge; start the runner service and re-run the workflow.

## Godot games (Cryptid Corral)

Cryptid Corral moved from Unity to Godot (Summer Engine is a Godot fork, and the project opens in either). Vend it with `node game-jam/scripts/jamci.mjs vend <repo> --kind godot --project-dir godot`: the `publish.yml` stub calls `publish-godot.yml` with `project_dir: 'godot'`, and the `epic.yml` stub is the same as for a Unity game (`play_url`, no itch check). The runner, the private repo, the secrets and the live link are exactly as in the Unity section above, with these differences: the front door has no bare `/<game>/` path (and redirects the root), so vend with `--play-url https://boogie.junco-diatonic.ts.net:10000/<game>/latest/`, the build of the main branch (the verify step fetches `<play-url>build-info.txt`). Every build, on any branch, is also published to `/<game>/test/` (`publish.ps1 -Dev`, the dev server), so a branch build never replaces `/latest/`.

What differs: the build needs no licence, only the Godot editor and export templates, which the workflow downloads once into `~/godot-ci/<version>` (about 1.2 GB the first time). That Godot runs in self-contained mode (a `_sc_` file beside it), so its settings and templates live in `~/godot-ci/<version>/editor_data` and a Godot or Summer editor open on `boogie`, which rewrites `%APPDATA%\Godot`, cannot break the build. The web export uses stock Godot's `web_nothreads` template, so it needs no cross-origin-isolation headers and runs on WebGL 2 in any modern browser, phones included (Summer's own web template needs WebGPU and fails in Firefox). The game's `export_presets.cfg` must hold a preset named `Web`; an `Android` preset adds a debug APK artifact, which needs the Android SDK (`%LOCALAPPDATA%\Android\Sdk`, build-tools 34.0.0, platform android-34), JDK 17 and `~/.android/debug.keystore` on `boogie`; the workflow writes their paths into the self-contained editor settings.

## Mirroring

`micahlagrange/skills/.github/workflows/mirror-jam-ci.yml` mints a token for the
Jam Hub github app (the same secret and variable, set on the skills repo), checks this
repo out with it, runs `node game-jam/scripts/jamci.mjs mirror jam-ci` and
pushes. `game-jam/ci/github-app.md` in the skills repo describes the app.
