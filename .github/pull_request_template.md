## What this changes

<!-- What does this pull request do, and why? Link the issue it addresses (e.g. "Fixes #12"). -->

## How it was tested

<!-- Which tests did you run or add? For UI changes, add a screenshot or a short recording. -->

## Checklist

- [ ] `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` pass
- [ ] `cargo test` passes
- [ ] End-to-end tests pass (`cd tests/e2e && npm test`), and new behaviour has a test
- [ ] Docs in `site/` and the README are updated if behaviour or options changed
- [ ] User input that reaches git is validated, and nothing runs through a shell
