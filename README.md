# DevTree 🌳

A lightweight, local, GitKraken-style git client written in Rust, with a retro terminal UI in Claude's warm palette.

It runs as one small binary (~1.6 MB release build) that serves a web UI on `http://localhost:7878`.

## Features

- **Commit graph**: colored lanes with curved merge and branch edges, author-initial nodes, a ring around HEAD, and branch/remote/tag badges.
- **WIP row**: uncommitted changes appear at the top of the graph, like GitKraken.
- **Pull / Push / Fetch** buttons. Pull has a mode menu (fast-forward if possible, ff-only, rebase). Push sets the upstream automatically for new branches.
- **Stage, unstage and commit**, with amend and a 72-character subject hint. `Ctrl/⌘+Enter` commits.
- **Diff viewer** for commit files and working-tree changes.
- **Branches**: double-click a branch (sidebar or graph badge) to check it out. Right-click a commit to check it out, branch from it or copy its SHA.
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
  - `git.rs`: runs git and parses porcelain output.
  - `graph.rs`: lays out the lanes server-side, so the browser only draws them.
  - `store.rs`: the imported-repo list (`repos.json`).
- **Frontend** (`web/`): plain HTML, CSS and JS that draw the graph in SVG. The files are compiled into the binary with `include_str!`.

## Security

DevTree can run git commands on your machine, so it:

- listens on `127.0.0.1` only,
- rejects requests whose `Host` isn't localhost, which blocks DNS rebinding,
- requires an `X-DevTree` header on every API call, so other websites can't call it cross-origin,
- never passes user input through a shell, and rejects branch names that look like options.

Git never prompts interactively (`GIT_TERMINAL_PROMPT=0`). For private remotes, use SSH keys or a credential helper.
