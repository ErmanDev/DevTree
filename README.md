# DevTree 🌳

A fast, lightweight desktop git client written in Rust. See your history as a colorful commit graph, stage single lines, resolve conflicts side by side and rewrite history with an interactive rebase, all in a retro CRT-terminal look.

It runs as one small desktop program (~3 MB release build). The UI is drawn by your system's own web engine (WebView2, WKWebView or WebKitGTK), so there's no Electron and no bundled browser. It can also run in your web browser.

## Features

- **Commit graph**: colored lanes with curved merge and branch edges, author-initial nodes, a ring around HEAD, and branch/remote/tag badges.
  - Only the rows on screen are drawn, so a 30,000-commit history scrolls smoothly. Older commits load as you scroll down.
  - Hovering a commit highlights its line of history (its first-parent path).
- **WIP row**: uncommitted changes appear at the top of the graph, so you always see what you're about to commit.
- **Author chips**: every commit shows its author's picture and name, both in the graph node and in the AUTHOR column. The commit details show author and committer.
  - **Where pictures come from:** GitHub `noreply` emails use the GitHub avatar; other emails use Gravatar, looked up by a SHA-256 hash of the email.
  - **When there's no picture,** or you're offline, colored initials are shown instead.
  - **↻ marks commits where someone else committed** (for example rebased, cherry-picked, or merged on GitHub). Git doesn't record who *pushed*.
  - **The ☺ button in the AUTHOR header turns pictures off.** Then nothing is fetched.
- **Pull / Push / Fetch** buttons. Pull has a mode menu (fast-forward if possible, ff-only, rebase) and auto-stashes local changes. Push sets the upstream automatically for new branches.
- **Live progress with Cancel** for fetch, pull, push, clone and tag/remote-branch pushes. A retro progress bar shows git's own progress ("Receiving objects: 45%"). Cancel stops git immediately, and a cancelled clone leaves no half-written folder. Network commands on one repository run one at a time, so a background fetch never collides with your pull.
- **Sign in to HTTPS remotes**: when a server asks for credentials, DevTree asks for a username and password/token, then retries. Credentials are kept in memory only (for one operation, or until DevTree closes). If you have a git credential manager, it saves them as usual. SSH failures get a short guide instead (load your key with `ssh-add`, accept the host key). ssh is run in batch mode, so it fails instead of hanging on a prompt nobody can see.
- **Auto-fetch** every 1, 5 (default), 15 or 30 minutes from the Fetch ▾ menu, or off. The header shows when the repo was last fetched. Background fetches never pop up dialogs: if one needs a sign-in, the header says so and a click fetches with a prompt.
- **Merge conflicts**:
  - A banner shows any merge, rebase, cherry-pick or revert in progress (with rebase step x/y), with **Continue / Commit merge**, **Skip** and **Abort** buttons.
  - A **conflict editor** shows each conflict side by side (current vs incoming). Pick current, incoming or both, or edit the file by hand, then save and mark it resolved.
  - Or keep one side of a whole file in one click. This also handles binary files and files deleted on one side.
- **Discard** changes to one file, or everything (with confirmation).
- **Stash**: stash (optionally including new files), pop, apply and drop from the toolbar, the sidebar or the stash's detail view. If local changes block a checkout, DevTree offers to stash them and switch.
- **Merge and rebase between branches**: drag a branch onto another, or right-click a branch or commit. Merge offers fast-forward if possible, always create a merge commit, or fast-forward only.
- **Branch and tag management**: rename, delete (with a force option for unmerged branches), delete remote branches, set or unset upstream, create lightweight or annotated tags, push one or all tags, delete tags locally and on the remote.
- **Stage, unstage and commit**, with amend and a 72-character subject hint. `Ctrl/⌘+Enter` commits.
- **Partial staging**: click lines in a diff (shift-click for a range) to stage, unstage or discard just those lines, or use the per-hunk buttons.
- **Diff viewer**:
  - unified or side-by-side
  - syntax colors for common languages (a tiny built-in highlighter, no libraries)
  - word-level highlighting of what changed within a line
  - an "ignore whitespace" toggle
  - before/after previews for images
- **File history** (follows renames) and **blame**, which colors each line by age and opens its commit on click. Right-click any file to get these.
- **Search all history** by message, author, commit id, file/folder name, or code that was added or removed. Press Enter in the filter box.
- **Compare** two commits or branches: ctrl/⌘-click a second commit, or use "Compare with …" in the menus. It shows the files that differ, the commits only on each side, and a swap button.
- **Cherry-pick, revert and reset** (soft / mixed / hard, with explanations) from a commit's right-click menu.
- **Interactive rebase**: "Interactive rebase from here…" opens an editor where you can reorder commits by dragging and pick / reword / squash / fixup / drop each one. Rewording works even if the rebase pauses for conflicts.
- **Remotes**: add, rename, change URL, remove, fetch or prune each remote from the sidebar.
- **Import repos** from a built-in folder browser, or **clone from a URL**.
- **Open the repo elsewhere**: buttons next to the repository name open its web page (GitHub, GitLab, … worked out from `origin`) in your browser, and its folder in Explorer / Finder / your file manager.
- **Updates in place**: when a new version is out, DevTree says so when it starts. On Windows, **Update now** downloads it (checking its SHA-256 checksum), swaps it in and restarts, with nothing to reinstall. Set `DEVTREE_NO_UPDATE=1` to turn the check off.
- Commit filter (`/`), keyboard navigation (`↑/↓` or `j/k`), `r` to refresh, light and dark retro themes.
- A console that shows every git command run and its output.

## Download

- **Windows 10 / 11 (64-bit):** [devtree-windows-x64.exe](https://github.com/ErmanDev/DevTree/releases/latest/download/devtree-windows-x64.exe). Install [Git for Windows](https://git-scm.com/download/win) first. The file isn't code-signed yet, so SmartScreen may ask you to confirm (More info → Run anyway).
- **macOS and Linux:** build from source (below) for now.

Releases are built by `.github/workflows/release.yml`: push a tag such as `v0.1.0`, or run the Release workflow by hand.

## Run it

Requires Rust and `git` on your `PATH`. On Linux, also install the WebKitGTK and GTK development packages, e.g. `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev` (or build the browser-only version with `--no-default-features`). Step-by-step setup for each system is in the [install guide](site/docs/install.html).

```sh
cargo run --release
# or build once and run the binary directly
cargo build --release && ./target/release/devtree
```

Options:

| flag | default | |
|---|---|---|
| `--port <n>` | `7878` | port to listen on (always `127.0.0.1`) |
| `--data-dir <path>` | `~/.devtree` (or `$DEVTREE_HOME`) | where the list of imported repos and `devtree.log` (startup errors, update steps) are stored |
| `--clone-dir <path>` | `~/devtree-repos` | default folder for clones |
| `--browser` | | open in your web browser instead of DevTree's own window |
| `--no-open` | | open nothing, just serve `http://localhost:7878` |

## Testing

```sh
cargo test                       # Rust unit tests
cargo build                      # the end-to-end tests drive target/debug/devtree
cd tests/e2e && npm install && npx playwright install chromium
npm test                         # end-to-end tests
```

The end-to-end tests (`tests/e2e/specs`) give every test its own DevTree server on a free port, its own temporary git repositories and an isolated git config. They then drive the real UI in Chromium, or call the API directly. They cover:

- the graph (including a 3,000-commit history)
- staging, committing, discarding and stash
- branches, remotes, cherry-pick, revert and reset
- merge and rebase conflicts
- partial staging and the diff viewer
- history, blame, search and compare
- interactive rebase
- sign-in, progress and cancel, against a password-protected git server (`support/gitserver.py`, which needs Python)
- the security guards

GitHub Actions (`.github/workflows/ci.yml`) runs formatting, clippy, the unit tests and the end-to-end tests on Linux, macOS and Windows for every push and pull request. On Linux it also opens the desktop window on a virtual display and checks that it draws (`scripts/desktop-smoke.sh`).

## Documentation site

The docs at `site/` are plain HTML and CSS, with no build step. To preview them locally:

```sh
npx firebase-tools emulators:start --only hosting --project demo-devtree   # http://localhost:5000
node scripts/check-site-links.mjs                                          # check every link and #anchor
```

To regenerate the app screenshots in `site/img/` (needs `cargo build` first):

```sh
cd tests/e2e && npx playwright test -c screenshots.config.js
```

### Deploying the docs

`.github/workflows/docs.yml` deploys `site/` to Firebase Hosting. Pushes to `main` go to the live site, and pull requests from this repository get a 7-day preview link. One-time setup:

1. Create a project in the [Firebase console](https://console.firebase.google.com/) and put its ID in `.firebaserc` (currently `devtree-4594d`).
2. Run `npx firebase-tools init hosting:github` from the repository root, or create a Google Cloud service account with the **Firebase Hosting Admin** role and download its JSON key.
3. Add the JSON key as a repository secret named `FIREBASE_SERVICE_ACCOUNT` (Settings → Secrets and variables → Actions). If `init` offers to overwrite `firebase.json` or the workflow, keep the existing ones.

Until the secret exists, the workflow only checks the links and skips the deploy. To deploy by hand: `npx firebase-tools deploy --only hosting`.

## Promo video

`marketing/` is a [Remotion](https://www.remotion.dev) project that renders DevTree's promo video from code: a narrated, captioned ~50-second tour with a retro music bed, in 16:9 (`DevTreePromo`, 1920×1080) and square (`DevTreeSquare`, 1080×1080). Each feature replays a real interaction with the app: a pointer clicks, drags and hovers, and the app responds.

The interactions are recorded from the real app by `tests/e2e/screenshots/promo.shots.js`. Each step saves a screenshot and the pointer's target in `marketing/public/promo/`. Re-record after UI changes (needs `cargo build` first):

```sh
cd tests/e2e && npx playwright test --config screenshots.config.js promo
```

```sh
cd marketing
npm install
npm run studio    # preview and edit in the browser
npm run render    # out/devtree-promo.mp4 and out/devtree-promo-square.mp4, sound mastered to -16 LUFS
npm run still     # out/devtree-promo-poster.png
```

**Voice-over.** The narration is in `marketing/voiceover/script.json`: one line per scene, with `text` to speak and an optional `caption` to show. Scenes last as long as their line, so you can rewrite it freely. To regenerate the speech (and the music bed), install the [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) text-to-speech model (Apache-2.0, runs offline) and run the generator:

```sh
cd marketing/voiceover
python3 -m venv .venv && .venv/bin/pip install kokoro-onnx soundfile numpy
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
.venv/bin/python generate.py    # writes src/voiceover/*.mp3 and lines.ts
```

Change `"voice"` in `script.json` to try another Kokoro voice (for example `am_michael` or `bf_emma`). To use a recorded voice instead, replace the MP3s in `src/voiceover/` and update the `seconds` in `lines.ts`.

The docs home page plays a compressed copy, `site/video/devtree-promo.mp4`:

```sh
ffmpeg -i marketing/out/devtree-promo.mp4 -c:v libx264 -crf 27 -preset slow -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart site/video/devtree-promo.mp4
```

Or run **Actions → Promo video** to render both videos on GitHub and download them as an artifact. Remotion is free for individuals and companies of up to three people; larger companies need a [Remotion company license](https://www.remotion.pro/license).

## How it works

- **Backend** (`src/`): [axum](https://github.com/tokio-rs/axum) runs the real `git` CLI, so pull and push use your existing SSH agent, credential helper and git config. No libgit2, no Electron.
  - `git.rs`: runs git, parses porcelain output, and detects in-progress merges and rebases.
  - `actions.rs`: conflicts, discard, stash, merge/rebase, branch and tag endpoints.
  - `api.rs`: shared handler plumbing and input validation.
  - `net.rs`: progress jobs, cancel, the per-repo network lock, credentials and sign-in failure detection.
  - `explore.rs`: file history, blame, search and compare.
  - `rebase.rs`: interactive rebase. DevTree acts as git's plan and message editor.
  - `graph.rs`: lays out the lanes server-side, so the UI only draws them.
  - `store.rs`: the imported-repo list (`repos.json`).
  - `desktop.rs`: the native window ([tao](https://github.com/tauri-apps/tao) + [wry](https://github.com/tauri-apps/wry)), behind the default `desktop` feature.
- **Frontend** (`web/`): plain HTML, CSS and JS with no dependencies. The graph is drawn in SVG. `diff.js` holds the diff parser and renderer, the syntax highlighter and the partial-staging patch builder. The files are compiled into the binary with `include_str!`.

## Security

DevTree can run git commands on your machine, so it:

- listens on `127.0.0.1` only,
- rejects requests whose `Host` isn't localhost, which blocks DNS rebinding,
- requires an `X-DevTree` header on every API call, so other websites can't call it cross-origin,
- never passes user input through a shell, and rejects branch names that look like options,
- only accepts file paths inside the repository, and only lets the conflict editor write to files that are currently conflicted.

Git never prompts in a terminal (`GIT_TERMINAL_PROMPT=0`). Credentials typed into DevTree reach git through DevTree acting as a git credential helper (`devtree credential-helper get`). The secret travels in that one child process's environment, never on a command line or disk.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes get reviewed and merged, and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

[MIT](LICENSE). Contributions are accepted under the same license.
