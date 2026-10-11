//! Handlers for conflict resolution, discarding, stashes, merge/rebase and ref management.

use crate::api::{ApiError, ApiResult, Shared, bad, net_result, ok, repo, valid_path, valid_ref, valid_sha};
use crate::git::{self, GitOutput, LOCAL_TIMEOUT, NETWORK_TIMEOUT};
use crate::net::{JobQuery, remote_cmd};
use axum::{
    Json,
    extract::{Path as UrlPath, Query, State},
};
use serde::Deserialize;
use serde_json::json;
use std::path::Path;

/// Largest file the conflict editor will load.
const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;

async fn local(dir: &Path, args: &[&str]) -> Result<GitOutput, ApiError> {
    Ok(git::run(dir, args, LOCAL_TIMEOUT).await?)
}

/// Runs several commands, stopping at the first failure; returns the last output.
async fn sequence(dir: &Path, steps: &[Vec<&str>]) -> ApiResult {
    let mut last = None;
    for args in steps {
        let out = git::run(dir, args, NETWORK_TIMEOUT).await?;
        if !out.ok {
            return net_result(out);
        }
        last = Some(out);
    }
    net_result(last.expect("at least one step"))
}

async fn remote_or_err(dir: &Path) -> Result<String, ApiError> {
    git::default_remote(dir).await?.ok_or_else(|| bad("this repository has no remote"))
}

async fn conflicted(dir: &Path, path: &str) -> Result<bool, ApiError> {
    Ok(git::status(dir).await?.files.iter().any(|f| f.conflicted && f.path == path))
}

// ---------------------------------------------------------------- paused operations

/// Continue, skip or abort the merge/rebase/cherry-pick/revert that is in progress.
pub async fn operation(State(s): Shared, UrlPath((id, action)): UrlPath<(String, String)>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let st = git::status(&r.path).await?;
    let op = st.operation.ok_or_else(|| bad("no merge, rebase, cherry-pick or revert is in progress"))?;
    if action == "continue" && st.files.iter().any(|f| f.conflicted) {
        return Err(bad("resolve all conflicted files before continuing"));
    }
    let args: Vec<&str> = match (op.kind, action.as_str()) {
        ("merge", "continue") => vec!["commit", "--no-edit"],
        ("merge", "abort") => vec!["merge", "--abort"],
        (_, "skip") if !op.can_skip() => return Err(bad("a merge cannot be skipped")),
        (kind, "continue" | "abort" | "skip") => vec![
            kind,
            if action == "continue" {
                "--continue"
            } else if action == "abort" {
                "--abort"
            } else {
                "--skip"
            },
        ],
        _ => return Err(bad(format!("unknown action {action}"))),
    };
    net_result(git::run(&r.path, &args, NETWORK_TIMEOUT).await?)
}

#[derive(Deserialize)]
pub struct ResolveBody {
    path: String,
    /// "ours" (current / HEAD side) or "theirs" (incoming side).
    side: String,
}

/// Resolve a whole file by taking one side, then mark it resolved.
pub async fn resolve(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<ResolveBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let path = valid_path(&b.path)?;
    let flag = match b.side.as_str() {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => return Err(bad("side must be ours or theirs")),
    };
    let out = local(&r.path, &["checkout", flag, "--", path]).await?;
    if out.ok {
        return net_result(local(&r.path, &["add", "--", path]).await?);
    }
    // The chosen side deleted the file (modify/delete conflict): resolve as a deletion.
    if out.stderr.contains("does not have") {
        return net_result(local(&r.path, &["rm", "-q", "--", path]).await?);
    }
    net_result(out)
}

#[derive(Deserialize)]
pub struct FileQuery {
    path: String,
}

/// Working-tree contents of a file, for the conflict editor.
pub async fn read_file(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<FileQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let full = r.path.join(valid_path(&q.path)?);
    let meta = std::fs::metadata(&full).map_err(|e| bad(format!("{}: {e}", q.path)))?;
    if meta.len() > MAX_EDIT_BYTES {
        return ok(json!({ "content": null, "binary": false, "too_large": true }));
    }
    let bytes = std::fs::read(&full).map_err(|e| bad(format!("{}: {e}", q.path)))?;
    let binary = bytes.iter().take(8000).any(|&b| b == 0);
    let content = (!binary).then(|| String::from_utf8_lossy(&bytes).into_owned());
    ok(json!({ "content": content, "binary": binary, "too_large": false }))
}

#[derive(Deserialize)]
pub struct WriteBody {
    path: String,
    content: String,
    /// Also `git add` the file, marking the conflict resolved.
    #[serde(default)]
    stage: bool,
}

/// Saves the result of the conflict editor. Only conflicted files may be written.
pub async fn write_file(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<WriteBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let path = valid_path(&b.path)?;
    if !conflicted(&r.path, path).await? {
        return Err(bad(format!("{path} is not a conflicted file")));
    }
    std::fs::write(r.path.join(path), b.content.as_bytes()).map_err(|e| bad(format!("cannot write {path}: {e}")))?;
    if b.stage {
        return net_result(local(&r.path, &["add", "--", path]).await?);
    }
    ok(json!({ "written": path }))
}

// ---------------------------------------------------------------- discard

#[derive(Deserialize)]
pub struct DiscardBody {
    #[serde(default)]
    paths: Vec<String>,
    /// Throw away every change: staged, unstaged and untracked files.
    #[serde(default)]
    all: bool,
}

pub async fn discard(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<DiscardBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    if b.all {
        return sequence(&r.path, &[vec!["reset", "--hard", "-q", "HEAD"], vec!["clean", "-fd", "-q"]]).await;
    }
    if b.paths.is_empty() {
        return Err(bad("no files to discard"));
    }
    let st = git::status(&r.path).await?;
    let mut untracked = vec!["clean", "-f", "-q", "--"];
    let mut tracked = vec!["restore", "--worktree", "--"];
    for p in &b.paths {
        let p = valid_path(p)?;
        match st.files.iter().find(|f| f.path == p) {
            Some(f) if f.untracked => untracked.push(p),
            Some(f) if f.conflicted => return Err(bad(format!("{p} is conflicted – resolve it instead"))),
            Some(_) => tracked.push(p),
            None => return Err(bad(format!("{p} has no changes"))),
        }
    }
    let mut steps = Vec::new();
    if tracked.len() > 3 {
        steps.push(tracked);
    }
    if untracked.len() > 4 {
        steps.push(untracked);
    }
    sequence(&r.path, &steps).await
}

// ---------------------------------------------------------------- stash

#[derive(Deserialize)]
pub struct StashBody {
    message: Option<String>,
    #[serde(default = "yes")]
    untracked: bool,
}

fn yes() -> bool {
    true
}

pub async fn stash_save(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<StashBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let mut args = vec!["stash", "push"];
    if b.untracked {
        args.push("--include-untracked");
    }
    let msg = b.message.as_deref().map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = msg {
        args.extend(["-m", m]);
    }
    net_result(local(&r.path, &args).await?)
}

/// `apply`, `pop` or `drop` stash number `n`.
pub async fn stash_action(State(s): Shared, UrlPath((id, n, action)): UrlPath<(String, u32, String)>) -> ApiResult {
    let r = repo(&s, &id).await?;
    if !matches!(action.as_str(), "apply" | "pop" | "drop") {
        return Err(bad(format!("unknown stash action {action}")));
    }
    let name = format!("stash@{{{n}}}");
    net_result(local(&r.path, &["stash", &action, &name]).await?)
}

// ---------------------------------------------------------------- merge & rebase

#[derive(Deserialize)]
pub struct MergeBody {
    name: String,
    /// "auto" (default) | "no-ff" | "ff-only"
    mode: Option<String>,
}

/// Merge a branch or commit into the current branch.
pub async fn merge(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<MergeBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let mut args = vec!["merge", "--no-edit", "--autostash"];
    match b.mode.as_deref().unwrap_or("auto") {
        "auto" => {}
        "no-ff" => args.push("--no-ff"),
        "ff-only" => args.push("--ff-only"),
        other => return Err(bad(format!("unknown merge mode {other}"))),
    }
    args.push(valid_ref(&b.name)?);
    net_result(git::run(&r.path, &args, NETWORK_TIMEOUT).await?)
}

#[derive(Deserialize)]
pub struct RebaseBody {
    onto: String,
}

/// Rebase the current branch onto another branch or commit.
pub async fn rebase(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<RebaseBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let onto = valid_ref(&b.onto)?;
    net_result(git::run(&r.path, &["rebase", "--autostash", onto], NETWORK_TIMEOUT).await?)
}

// ---------------------------------------------------------------- branches

#[derive(Deserialize)]
pub struct DeleteBranchBody {
    name: String,
    /// `name` is a remote-tracking branch such as `origin/feature`: delete it on the remote.
    #[serde(default)]
    remote: bool,
    /// Delete even if not merged (`-D`).
    #[serde(default)]
    force: bool,
}

pub async fn delete_branch(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<JobQuery>, Json(b): Json<DeleteBranchBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let name = valid_ref(&b.name)?;
    if !b.remote {
        return net_result(local(&r.path, &["branch", if b.force { "-D" } else { "-d" }, name]).await?);
    }
    // Split `origin/feature/x` into the remote and the branch, honouring remotes with slashes.
    let remotes = git::remotes(&r.path).await?;
    let (remote, branch) = remotes
        .iter()
        .filter_map(|rm| name.strip_prefix(rm.as_str()).and_then(|rest| rest.strip_prefix('/')).map(|b| (rm.as_str(), b)))
        .max_by_key(|(rm, _)| rm.len())
        .ok_or_else(|| bad(format!("{name} does not belong to a known remote")))?;
    remote_cmd(&s, &r, &["push", "--progress", remote, "--delete", valid_ref(branch)?], q.job.as_deref()).await
}

#[derive(Deserialize)]
pub struct RenameBody {
    old: String,
    new: String,
}

pub async fn rename_branch(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<RenameBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    net_result(local(&r.path, &["branch", "-m", valid_ref(&b.old)?, valid_ref(&b.new)?]).await?)
}

#[derive(Deserialize)]
pub struct UpstreamBody {
    name: String,
    /// e.g. `origin/main`; `null` removes the upstream.
    upstream: Option<String>,
}

pub async fn set_upstream(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<UpstreamBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let name = valid_ref(&b.name)?;
    let out = match b.upstream.as_deref() {
        Some(up) => local(&r.path, &["branch", &format!("--set-upstream-to={}", valid_ref(up)?), name]).await?,
        None => local(&r.path, &["branch", "--unset-upstream", name]).await?,
    };
    net_result(out)
}

// ---------------------------------------------------------------- tags

#[derive(Deserialize)]
pub struct TagBody {
    name: String,
    /// Commit to tag (defaults to HEAD).
    start: Option<String>,
    /// Non-empty message makes an annotated tag.
    message: Option<String>,
}

pub async fn create_tag(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<TagBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let mut args = vec!["tag"];
    let msg = b.message.as_deref().map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = msg {
        args.extend(["-a", "-m", m]);
    }
    args.push(valid_ref(&b.name)?);
    if let Some(start) = b.start.as_deref() {
        args.push(valid_ref(start)?);
    }
    net_result(local(&r.path, &args).await?)
}

#[derive(Deserialize)]
pub struct TagRefBody {
    /// Tag name; omitted on push means "push all tags".
    name: Option<String>,
    /// For delete: also delete the tag on the remote.
    #[serde(default)]
    remote: bool,
}

pub async fn delete_tag(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<JobQuery>, Json(b): Json<TagRefBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let name = valid_ref(b.name.as_deref().unwrap_or_default())?;
    let local_out = local(&r.path, &["tag", "-d", name]).await?;
    if !local_out.ok || !b.remote {
        return net_result(local_out);
    }
    let remote = remote_or_err(&r.path).await?;
    remote_cmd(
        &s,
        &r,
        &["push", "--progress", &remote, "--delete", &format!("refs/tags/{name}")],
        q.job.as_deref(),
    )
    .await
}

pub async fn push_tag(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<JobQuery>, Json(b): Json<TagRefBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let remote = remote_or_err(&r.path).await?;
    match b.name.as_deref() {
        Some(name) => {
            remote_cmd(
                &s,
                &r,
                &["push", "--progress", &remote, &format!("refs/tags/{}", valid_ref(name)?)],
                q.job.as_deref(),
            )
            .await
        }
        None => remote_cmd(&s, &r, &["push", "--progress", &remote, "--tags"], q.job.as_deref()).await,
    }
}

// ---------------------------------------------------------------- blobs & partial staging

/// Largest file served for previews.
const MAX_BLOB_BYTES: usize = 20 * 1024 * 1024;

#[derive(Deserialize)]
pub struct BlobQuery {
    path: String,
    /// "worktree", "index", "HEAD", a commit id, or a commit id followed by `^` (its first parent).
    rev: String,
}

/// Raw file contents at a revision, for image previews. Served with a sandboxing CSP so an
/// SVG can never run script in DevTree's origin.
pub async fn blob(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<BlobQuery>) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    let r = repo(&s, &id).await?;
    let path = valid_path(&q.path)?;
    let bytes = match q.rev.as_str() {
        "worktree" => std::fs::read(r.path.join(path)).ok(),
        "index" => git::blob(&r.path, &format!(":{path}")).await?,
        rev => {
            let base = rev.strip_suffix('^');
            let commit = if rev == "HEAD" { rev } else { valid_sha(base.unwrap_or(rev))? };
            let spec = if base.is_some() {
                format!("{commit}^1:{path}")
            } else {
                format!("{commit}:{path}")
            };
            git::blob(&r.path, &spec).await?
        }
    };
    let bytes = bytes.ok_or_else(|| ApiError::new(axum::http::StatusCode::NOT_FOUND, "no such file at that revision"))?;
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(bad("file too large to preview"));
    }
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let ty = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, ty),
            (
                axum::http::header::CONTENT_SECURITY_POLICY,
                "sandbox; default-src 'none'; style-src 'unsafe-inline'",
            ),
            (axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct ApplyBody {
    patch: String,
    /// Apply in reverse (unstage / discard).
    #[serde(default)]
    reverse: bool,
    /// "index" (stage / unstage) or "worktree" (discard).
    target: String,
}

/// Applies a patch built in the UI from selected hunks or lines.
pub async fn apply_patch(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<ApplyBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    match b.target.as_str() {
        "index" => args.push("--cached"),
        "worktree" => {}
        other => return Err(bad(format!("unknown apply target {other}"))),
    }
    if b.reverse {
        args.push("--reverse");
    }
    args.push("-");
    let extra = git::Extra {
        stdin: Some(b.patch.into_bytes()),
        ..Default::default()
    };
    net_result(git::run_with(&r.path, &args, LOCAL_TIMEOUT, &extra).await?)
}

// ---------------------------------------------------------------- cherry-pick, revert, reset

#[derive(Deserialize)]
pub struct CommitRefBody {
    sha: String,
}

/// `-m 1` is required to cherry-pick or revert a merge commit (relative to its first parent).
async fn mainline_args(dir: &Path, sha: &str) -> Result<Vec<&'static str>, ApiError> {
    let parents = git::run_ok(dir, &["rev-list", "--parents", "-n", "1", sha, "--"]).await?;
    Ok(if parents.split_whitespace().count() > 2 { vec!["-m", "1"] } else { vec![] })
}

pub async fn cherry_pick(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<CommitRefBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let sha = valid_sha(&b.sha)?;
    let mut args = vec!["cherry-pick"];
    args.extend(mainline_args(&r.path, sha).await?);
    args.push(sha);
    net_result(git::run(&r.path, &args, NETWORK_TIMEOUT).await?)
}

pub async fn revert(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<CommitRefBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let sha = valid_sha(&b.sha)?;
    let mut args = vec!["revert", "--no-edit"];
    args.extend(mainline_args(&r.path, sha).await?);
    args.push(sha);
    net_result(git::run(&r.path, &args, NETWORK_TIMEOUT).await?)
}

#[derive(Deserialize)]
pub struct ResetBody {
    target: String,
    /// "soft" | "mixed" | "hard"
    mode: String,
}

/// Move the current branch to `target`.
pub async fn reset(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<ResetBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let mode = match b.mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(bad(format!("unknown reset mode {other}"))),
    };
    net_result(local(&r.path, &["reset", "-q", mode, valid_ref(&b.target)?, "--"]).await?)
}

// ---------------------------------------------------------------- remotes

#[derive(serde::Serialize)]
struct RemoteInfo {
    name: String,
    fetch_url: String,
    push_url: String,
}

pub async fn list_remotes(State(s): Shared, UrlPath(id): UrlPath<String>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let text = git::run_ok(&r.path, &["remote", "-v"]).await?;
    ok(parse_remotes(&text))
}

fn parse_remotes(text: &str) -> Vec<RemoteInfo> {
    let mut out: Vec<RemoteInfo> = Vec::new();
    for line in text.lines() {
        // "origin\thttps://example.com/x.git (fetch)"
        let Some((name, rest)) = line.split_once('\t') else { continue };
        let Some((url, kind)) = rest.rsplit_once(' ') else { continue };
        let idx = match out.iter().position(|r| r.name == name) {
            Some(i) => i,
            None => {
                out.push(RemoteInfo {
                    name: name.to_string(),
                    fetch_url: String::new(),
                    push_url: String::new(),
                });
                out.len() - 1
            }
        };
        if kind == "(push)" {
            out[idx].push_url = url.to_string();
        } else {
            out[idx].fetch_url = url.to_string();
        }
    }
    out
}

/// Refuses URLs git could read as options; whitespace is never valid in a remote URL.
fn valid_url(u: &str) -> Result<&str, ApiError> {
    let u = u.trim();
    if u.is_empty() || u.starts_with('-') || u.chars().any(|c| c.is_whitespace() || c.is_control()) {
        Err(bad("invalid remote URL"))
    } else {
        Ok(u)
    }
}

#[derive(Deserialize)]
pub struct RemoteBody {
    name: String,
    url: Option<String>,
    new_name: Option<String>,
}

/// add | remove | rename | set-url
pub async fn remote_action(State(s): Shared, UrlPath((id, action)): UrlPath<(String, String)>, Json(b): Json<RemoteBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let name = valid_ref(&b.name)?;
    let url = || b.url.as_deref().ok_or_else(|| bad("url is required")).and_then(valid_url);
    let out = match action.as_str() {
        "add" => local(&r.path, &["remote", "add", name, url()?]).await?,
        "remove" => local(&r.path, &["remote", "remove", name]).await?,
        "rename" => local(&r.path, &["remote", "rename", name, valid_ref(b.new_name.as_deref().unwrap_or_default())?]).await?,
        "set-url" => local(&r.path, &["remote", "set-url", name, url()?]).await?,
        other => return Err(bad(format!("unknown remote action {other}"))),
    };
    net_result(out)
}

/// Fetch a single remote, or prune its deleted branches.
pub async fn remote_network(
    State(s): Shared,
    UrlPath((id, action)): UrlPath<(String, String)>,
    Query(q): Query<JobQuery>,
    Json(b): Json<RemoteBody>,
) -> ApiResult {
    let r = repo(&s, &id).await?;
    let name = valid_ref(&b.name)?;
    match action.as_str() {
        "fetch" => remote_cmd(&s, &r, &["fetch", "--prune", "--progress", name], q.job.as_deref()).await,
        "prune" => remote_cmd(&s, &r, &["remote", "prune", name], q.job.as_deref()).await,
        other => Err(bad(format!("unknown remote action {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_list() {
        let r = parse_remotes(
            "origin\thttps://a/x.git (fetch)\norigin\tgit@a:x.git (push)\nup\t/path with space/r.git (fetch)\nup\t/path with space/r.git (push)\n",
        );
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].fetch_url, "https://a/x.git");
        assert_eq!(r[0].push_url, "git@a:x.git");
        assert_eq!(r[1].fetch_url, "/path with space/r.git");
    }
}
