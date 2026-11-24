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
(issue comment) is skipped, so nothing goes red.

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
| `publish-html.yml` | `itch_user` (default `multivoxmuse`), `itch_game` | `npm ci`, Playwright Chromium, `npm test`; on the default branch only, `butler push --if-changed` to `<user>/<game>:html`. |
| `publish-love.yml` | `itch_user`, `itch_game`, `game_name`, `test`, `makelove` (default `makelove==0.0.13`), `pre_build` (after the tests, before makelove; the checkout has the full history, so it can stamp a build number from `git rev-list --count HEAD`), `post_build` | makelove builds love/web/linux/win64/macos (no artifacts are uploaded); on the default branch only, butler pushes the targets listed in makelove.toml (html, linux, windows, osx). |
| `publish-unity.yml` | `build_script` (`webgl.ps1`), `build_dir` (`Builds/WebGL`), `live_url` (the front door link) | Runs on the self-hosted runner `boogie`: builds WebGL with Unity in the runner's own workspace, stamps `build-info.txt` with the commit; on the default branch only, promotes it with `publish.ps1` from the homeserver repo and checks the live site serves that commit. No tests: a clean build is the gate. |
| `publish-godot.yml` | `project_dir` (folder with `project.godot`, default `.`), `godot_version` (`4.7.2`), `web_preset` (`Web`), `android` (ignored), `live_url` (the game's `/latest/` URL on `base`, ending in `/`) | Runs on GitHub-hosted `ubuntu-24.04`: installs the official Linux Godot release and its templates (cached per version), imports and exports the Web preset (WebGL 2, no threads, so it plays on phones and in Firefox), as a check that the export is clean (nothing is uploaded: no artifacts, no APK); on the default branch only, polls `<live_url>build-info.txt` every 30 s for up to 15 minutes until it shows the built SHA. CI copies nothing to a server: `base` builds the same commit itself. No tests: a clean export is the gate. |
| `publish-netlify.yml` | `project_dir` (site folder, default `.`), `netlify_site_id` (not a secret), `live_url` (ends in `/`) | GitHub-hosted: `npm install` in the folder, `npm test` if the site has one, stamps `build-info.txt` (first line: the commit SHA); on the default branch only, `netlify deploy --prod` with the repo secret `NETLIFY_AUTH_TOKEN` (missing: the job fails), then `epicpr.mjs verify-live` polls `<live_url>build-info.txt` until it shows the built SHA. |
| `epic-merge.yml` | `pr`, `sha` | `epicpr.mjs merge`: the head is still `sha`, no conflict, checks green, then merge with the app token. A refusal is commented on the epic issue as `conflict`, `stale`, `checks-failed` or `ship-failed`. |
| `epic-finish.yml` | `pr`, `sha`, `itch_url`, `play_url` | `issue-of`, `wait-publish` (the publish run of the merge commit, or the run that replaced it when a newer push cancelled it), `verify-itch`, `finish`: comment the outcome (`deployed`, `ship-failed`, `deploy-unverified`) and close the issue when deployed. |

Publishing happens only when `github.ref` is the caller's default branch; every
other push builds and tests. Nothing here calls an AI service.

## Secrets and variables (per game repo)

- `BUTLER_CREDENTIALS`: itch API key. Missing: the publish step warns and skips.
- Variable `ITCH_PAGE_PASSWORD`: page token of a not-yet-public itch page, for the itch check (default `yourmum`).

- Secret `NETLIFY_AUTH_TOKEN`: a Netlify personal access token, for a game with `kind: netlify` (Quadrant). Vend with `--kind netlify --netlify-site-id ID --play-url https://<site>.netlify.app/ [--project-dir folder]`; the epic stub passes `play_url`, so there is no itch check.
- Secret `JAM_HUB_APP_KEY`: the private key of the Jam Hub GitHub App
  (`micahlagrange-jam-hub`), which `epic-merge` merges with. Missing: the merge job fails.

`secrets: inherit` in the stubs passes them through.

## Unity games (Cryptid Corral)

A Unity game cannot build on GitHub's runners (the editor and its licence are on `boogie`) and is not on itch; it is played from the WebGL live server. Vend it with `node game-jam/scripts/jamci.mjs vend <project> --kind unity`: the `publish.yml` stub calls `publish-unity.yml` and the `epic.yml` stub passes `play_url` instead of `itch_url`, so `epic-finish` skips the itch check. Everything else in the epic flow is unchanged.

One-time setup on `boogie`:

- Register a GitHub Actions runner for the game repo (Settings > Actions > Runners) with the label `boogie`, installed as a service that runs as Micah's Windows user (Unity is activated there). Set `HOMESERVER_DIR` in the runner's `.env` if the homeserver checkout is not `~\Documents\github\homeserver`.
- The repo must be private. A self-hosted runner runs the code of every pull request against it.
- The repo commits `webgl.ps1` and `Assets/Editor/PlaytestBuild.cs` (the build scripts for a Unity project; for a new Unity game copy them from the Unity project still kept in `micahlagrange/cryptid-corral`).
- Secret `JAM_HUB_APP_KEY` as for any game; `BUTLER_CREDENTIALS` is not used.

The runner (install, verify, restart, remove, debug, Unity licence, `HOMESERVER_DIR`) is documented and scripted in the game repo: `docs/ci-runner.md` and `ci/runner/install-runner.ps1` in `micahlagrange/cryptid-corral`. It is a Windows service running as `sixst`, labelled `boogie`.

Approving the pull request is the decision to publish to the public Funnel link. If the runner is offline, the build check never completes and `epic-merge` refuses to merge; start the runner service and re-run the workflow.

## Godot games (Cryptid Corral)

Cryptid Corral moved from Unity to Godot (Summer Engine is a Godot fork, and the project opens in either). Vend it with `node game-jam/scripts/jamci.mjs vend <repo> --kind godot --project-dir godot`: the `publish.yml` stub calls `publish-godot.yml` with `project_dir: 'godot'`, and the `epic.yml` stub is the same as for a Unity game (`play_url`, no itch check). Vend with `--play-url https://playtest.mc.toadshaman.com/<game>/latest/`.

Godot builds no longer use the self-hosted runner `boogie` (being retired). The workflow runs on GitHub-hosted `ubuntu-24.04` and publishes nothing itself. Instead:

1. Every push, on any branch, exports the Web preset as a check. Nothing is uploaded: GitHub Actions artifacts are not used anywhere in jam-ci (the storage quota filled and failed builds).
2. The public front door, the Linux box `base`, builds: its scheduler runs every 5 minutes, exports the head of the main branch itself (`webbuild.mjs`) and serves it at `https://playtest.mc.toadshaman.com/<game>/latest/` with a `build-info.txt` whose first line is the full SHA. Epic builds are at `/<game>/test/pr<N>/` on the same host.
3. On the default branch only, the publish job then polls `<live_url>build-info.txt` every 30 s for up to 15 minutes and fails if the first line never equals the built SHA. `epic-finish` waits up to 50 minutes for that run (it was 30), so the pull delay is tolerated.

The web export uses stock Godot's `web_nothreads` template, so it needs no cross-origin-isolation headers and runs on WebGL 2 in any modern browser, phones included (Summer's own web template needs WebGPU and fails in Firefox). The game's `export_presets.cfg` must hold a preset named `Web`. Not ported: `licensed-assets.txt` packs came from a local disk on `boogie` and are unavailable on GitHub runners (the workflow warns if the file exists), and the `/test/` dev-server publish of branch builds is gone; branch builds are the `/test/pr<N>/` links on the front door.

## Running on a self-hosted runner (`runs_on`)

By default every job runs on GitHub's hosted `ubuntu-24.04`, which uses the account's free Actions minutes. A love game can run its build and its epic jobs on a runner the game owns instead (for example a repo-scoped runner on `base`, label `base`) by vending with `--runs-on`:

`node game-jam/scripts/jamci.mjs vend <repo> --kind love ... --runs-on self-hosted,base`

This writes `runs_on: '["self-hosted","base"]'` into the love `publish.yml` stub and into both `epic.yml` jobs (`epic-merge`, `epic-finish`). A game that does not pass the flag gets exactly the stubs it had before, so no other game changes.

- Only `publish-love.yml` takes the option for its build; vending `--runs-on` with any other kind is refused.
- A self-hosted runner has no sudo, so `publish-love.yml` does not `apt-get` or `setup-python` there. Its check step fails with a plain message when a tool is missing: Python 3.11 or newer, `makelove` importable by `python3`, `wine` for a win64 build, `libfuse2` for an AppImage. Install them on the runner once.
- The game's own `test` command must also work on that runner (it cannot `sudo` either).
- The repo must be private (see the Unity section): a self-hosted runner runs the code of every pull request against the repo.
- The `BUTLER_CREDENTIALS` and `JAM_HUB_APP_KEY` secrets still come from the game repo's GitHub Actions secrets, passed per job. Nothing secret is stored on the runner.

## Mirroring

`micahlagrange/skills/.github/workflows/mirror-jam-ci.yml` mints a token for the
Jam Hub github app (the same secret and variable, set on the skills repo), checks this
repo out with it, runs `node game-jam/scripts/jamci.mjs mirror jam-ci` and
pushes. `game-jam/ci/github-app.md` in the skills repo describes the app.
