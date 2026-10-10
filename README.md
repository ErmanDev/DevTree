# DevTree 🌳

A lightweight, local, GitKraken-style git client written in Rust, with a retro terminal UI in Claude's warm palette.

It runs as one small binary (~1.6 MB release build) that serves a web UI on `http://localhost:7878`.

## Features

- **Commit graph**: colored lanes with curved merge and branch edges, author-initial nodes, a ring around HEAD, and branch/remote/tag badges.
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
- **Diff viewer** for commit files and working-tree changes.
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

## How it works

- **Backend** (`src/`): [axum](https://github.com/tokio-rs/axum) runs the real `git` CLI, so pull and push use your existing SSH agent, credential helper and git config. No libgit2, no Electron.
  - `git.rs`: runs git, parses porcelain output, and detects in-progress merges and rebases.
  - `actions.rs`: conflicts, discard, stash, merge/rebase, branch and tag endpoints.
  - `api.rs`: shared handler plumbing and input validation.
  - `net.rs`: progress jobs, cancel, the per-repo network lock, credentials and sign-in failure detection.
  - `graph.rs`: lays out the lanes server-side, so the browser only draws them.
  - `store.rs`: the imported-repo list (`repos.json`).
- **Frontend** (`web/`): plain HTML, CSS and JS that draw the graph in SVG. The files are compiled into the binary with `include_str!`.

## Security

DevTree can run git commands on your machine, so it:

- listens on `127.0.0.1` only,
- rejects requests whose `Host` isn't localhost, which blocks DNS rebinding,
- requires an `X-DevTree` header on every API call, so other websites can't call it cross-origin,
- never passes user input through a shell, and rejects branch names that look like options,
- only accepts file paths inside the repository, and only lets the conflict editor write to files that are currently conflicted.

Git never prompts in a terminal (`GIT_TERMINAL_PROMPT=0`). Credentials typed into DevTree reach git through DevTree acting as a git credential helper (`devtree credential-helper get`). The secret travels in that one child process's environment, never on a command line or disk.
