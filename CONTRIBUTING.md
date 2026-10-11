# Contributing to DevTree

Thanks for helping! Bug reports, ideas, docs fixes and code are all welcome.

The full developer guide (architecture, API, testing) is at
[devtree-4594d.web.app/docs/contributing](https://devtree-4594d.web.app/docs/contributing). This file covers how changes get in.

## How changes reach `main`

`main` is protected. Every change, including the maintainer's, goes through a pull request and is merged only when:

- the CI checks pass on Linux, macOS and Windows (formatting, clippy, unit tests, end-to-end tests, docs links), and
- a code owner (see [`.github/CODEOWNERS`](.github/CODEOWNERS)) has reviewed and approved it.

Nobody can push to `main` directly. Workflows from first-time contributors' pull requests run after a maintainer approves them.

## Making a change

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the approach before you spend time on it.
2. **Fork** the repository and create a branch from `main`.
3. **Build and test** locally:
   ```sh
   cargo build
   cargo fmt --check
   cargo clippy --all-targets -- -D warnings
   cargo test
   cd tests/e2e && npm install && npx playwright install chromium && npm test
   ```
   On Linux, install the WebKitGTK and GTK development packages first, or build the browser-only version with `--no-default-features` (see the [install guide](https://devtree-4594d.web.app/docs/install#linux)).
4. **Open a pull request** against `main` and fill in the template. Keep it focused: one change per pull request.
5. **Address review comments** by pushing more commits to the same branch.

## Code style

- `cargo fmt` (with `max_width = 160`) and `cargo clippy --all-targets -- -D warnings` must pass.
- Shell out to git rather than adding git libraries. Never build commands through a shell, and validate anything that becomes a git argument (see `src/api.rs`).
- No runtime dependencies in the frontend. Keep it plain JavaScript.
- Comments explain why, not what.
- New behaviour comes with a test, end-to-end where it touches the UI.

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

DevTree is [MIT licensed](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
