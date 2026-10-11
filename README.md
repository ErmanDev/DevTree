# DevTree 🌳

A lightweight, local, GitKraken-style git client written in Rust, with a retro terminal UI in Claude's warm palette.

It runs as one small binary (~1.6 MB release build) that serves a web UI on `http://localhost:7878`.

## Features

- **Commit graph**: colored lanes with curved merge and branch edges, author-initial nodes, a ring around HEAD, and branch/remote/tag badges.
  - Only the rows on screen are drawn, so a 30,000-commit history scrolls smoothly. Older commits load as you scroll down.
  - Hovering a commit highlights its line of history (its first-parent path).
- **WIP row**: uncommitted changes appear at the top of the graph, like GitKraken.
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
- Commit filter (`/`), keyboard navigation (`↑/↓` or `j/k`), `r` to refresh, light and dark retro themes.
- A console that shows every git command run and its output.

## Run it

Requires Rust and `git` on your `PATH`.

```sh
cargo run --release
# or build once and run the binary directly
cargo build --release && ./target/release/devtree
```

Options:

| flag | default | |
|---|---|---|
| `--port <n>` | `7878` | port to listen on (always `127.0.0.1`) |
| `--data-dir <path>` | `~/.devtree` (or `$DEVTREE_HOME`) | where the list of imported repos is stored |
| `--clone-dir <path>` | `~/devtree-repos` | default folder for clones |
| `--no-open` | | don't open the browser on start |

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

GitHub Actions (`.github/workflows/ci.yml`) runs formatting, clippy, the unit tests and the end-to-end tests on Linux, macOS and Windows for every push and pull request.

## How it works

- **Backend** (`src/`): [axum](https://github.com/tokio-rs/axum) runs the real `git` CLI, so pull and push use your existing SSH agent, credential helper and git config. No libgit2, no Electron.
  - `git.rs`: runs git, parses porcelain output, and detects in-progress merges and rebases.
  - `actions.rs`: conflicts, discard, stash, merge/rebase, branch and tag endpoints.
  - `api.rs`: shared handler plumbing and input validation.
  - `net.rs`: progress jobs, cancel, the per-repo network lock, credentials and sign-in failure detection.
  - `explore.rs`: file history, blame, search and compare.
  - `rebase.rs`: interactive rebase. DevTree acts as git's plan and message editor.
  - `graph.rs`: lays out the lanes server-side, so the browser only draws them.
  - `store.rs`: the imported-repo list (`repos.json`).
- **Frontend** (`web/`): plain HTML, CSS and JS with no dependencies. The graph is drawn in SVG. `diff.js` holds the diff parser and renderer, the syntax highlighter and the partial-staging patch builder. The files are compiled into the binary with `include_str!`.

## Security

DevTree can run git commands on your machine, so it:

- listens on `127.0.0.1` only,
- rejects requests whose `Host` isn't localhost, which blocks DNS rebinding,
- requires an `X-DevTree` header on every API call, so other websites can't call it cross-origin,
- never passes user input through a shell, and rejects branch names that look like options,
- only accepts file paths inside the repository, and only lets the conflict editor write to files that are currently conflicted.

Git never prompts in a terminal (`GIT_TERMINAL_PROMPT=0`). Credentials typed into DevTree reach git through DevTree acting as a git credential helper (`devtree credential-helper get`). The secret travels in that one child process's environment, never on a command line or disk.
