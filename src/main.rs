mod actions;
mod api;
mod explore;
mod git;
mod graph;
mod net;
mod rebase;
mod store;

use axum::{
    Json, Router,
    extract::{Path as UrlPath, Query, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use api::{ApiError, ApiResult, AppState, Shared, bad, net_result, ok, repo, valid_ref, valid_sha};
use net::{JobQuery, remote_cmd};
use store::Store;

const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const DIFF_JS: &str = include_str!("../web/diff.js");
const STYLE_CSS: &str = include_str!("../web/style.css");


// ---------------------------------------------------------------- startup

struct Config {
    port: u16,
    data_dir: PathBuf,
    clone_dir: PathBuf,
    open: bool,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

fn parse_args() -> Config {
    let mut cfg = Config {
        port: 7878,
        data_dir: std::env::var_os("DEVTREE_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".devtree")),
        clone_dir: home().join("devtree-repos"),
        open: true,
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-p" | "--port" => cfg.port = args.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| usage("--port needs a number")),
            "--data-dir" => cfg.data_dir = args.next().map(PathBuf::from).unwrap_or_else(|| usage("--data-dir needs a path")),
            "--clone-dir" => cfg.clone_dir = args.next().map(PathBuf::from).unwrap_or_else(|| usage("--clone-dir needs a path")),
            "--no-open" => cfg.open = false,
            "-h" | "--help" => usage(""),
            other => usage(&format!("unknown argument: {other}")),
        }
    }
    cfg
}

fn usage(err: &str) -> ! {
    if !err.is_empty() {
        eprintln!("error: {err}\n");
    }
    eprintln!(
        "DevTree – a lightweight local git client\n\n\
         USAGE: devtree [--port 7878] [--data-dir ~/.devtree] [--clone-dir ~/devtree-repos] [--no-open]"
    );
    std::process::exit(if err.is_empty() { 0 } else { 2 });
}

fn main() {
    // git runs `devtree credential-helper get` to fetch credentials typed into the UI.
    // git also runs DevTree as its editor during interactive rebases (see rebase.rs).
    let mut args = std::env::args().skip(1);
    let mode = args.next();
    let arg = args.next();
    let helper = match mode.as_deref() {
        Some("credential-helper") => {
            net::credential_helper(arg.as_deref());
            Some(Ok(()))
        }
        Some("write-todo") => Some(rebase::write_todo(arg.as_deref())),
        Some("edit-message") => Some(rebase::edit_message(arg.as_deref())),
        _ => None,
    };
    if let Some(result) = helper {
        if let Err(e) = result {
            eprintln!("devtree: {e}");
            std::process::exit(1);
        }
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        git::set_self_exe(&exe);
    }
    let runtime = tokio::runtime::Runtime::new().expect("failed to start the async runtime");
    runtime.block_on(serve(parse_args()));
}

async fn serve(cfg: Config) {
    let state = Arc::new(AppState { store: Store::load(&cfg.data_dir), clone_dir: cfg.clone_dir, net: net::Net::new() });

    let api = Router::new()
        .route("/repos", get(list_repos).post(import_repo))
        .route("/repos/clone", post(clone_repo))
        .route("/repos/{id}", delete(remove_repo))
        .route("/repos/{id}/graph", get(repo_graph))
        .route("/repos/{id}/status", get(repo_status))
        .route("/repos/{id}/branches", get(repo_branches))
        .route("/repos/{id}/commit/{sha}", get(commit_detail))
        .route("/repos/{id}/commit/{sha}/diff", get(commit_diff))
        .route("/repos/{id}/diff", get(worktree_diff))
        .route("/repos/{id}/fetch", post(fetch))
        .route("/repos/{id}/pull", post(pull))
        .route("/repos/{id}/push", post(push))
        .route("/repos/{id}/checkout", post(checkout))
        .route("/repos/{id}/branch", post(create_branch))
        .route("/repos/{id}/stage", post(stage))
        .route("/repos/{id}/unstage", post(unstage))
        .route("/repos/{id}/commit", post(commit))
        .route("/repos/{id}/operation/{action}", post(actions::operation))
        .route("/repos/{id}/resolve", post(actions::resolve))
        .route("/repos/{id}/file", get(actions::read_file).post(actions::write_file))
        .route("/repos/{id}/discard", post(actions::discard))
        .route("/repos/{id}/stash", post(actions::stash_save))
        .route("/repos/{id}/stash/{n}/{action}", post(actions::stash_action))
        .route("/repos/{id}/merge", post(actions::merge))
        .route("/repos/{id}/rebase", post(actions::rebase))
        .route("/repos/{id}/branch/delete", post(actions::delete_branch))
        .route("/repos/{id}/branch/rename", post(actions::rename_branch))
        .route("/repos/{id}/branch/upstream", post(actions::set_upstream))
        .route("/repos/{id}/tag", post(actions::create_tag))
        .route("/repos/{id}/tag/delete", post(actions::delete_tag))
        .route("/repos/{id}/tag/push", post(actions::push_tag))
        .route("/repos/{id}/file-history", get(explore::file_history))
        .route("/repos/{id}/blame", get(explore::blame))
        .route("/repos/{id}/search", get(explore::search))
        .route("/repos/{id}/compare", get(explore::compare))
        .route("/repos/{id}/compare/diff", get(explore::compare_diff))
        .route("/repos/{id}/blob", get(actions::blob))
        .route("/repos/{id}/apply", post(actions::apply_patch))
        .route("/repos/{id}/rebase/plan", get(rebase::plan))
        .route("/repos/{id}/rebase/interactive", post(rebase::start))
        .route("/repos/{id}/cherry-pick", post(actions::cherry_pick))
        .route("/repos/{id}/revert", post(actions::revert))
        .route("/repos/{id}/reset", post(actions::reset))
        .route("/repos/{id}/remotes", get(actions::list_remotes))
        .route("/repos/{id}/remote/{action}", post(actions::remote_action))
        .route("/repos/{id}/remote-net/{action}", post(actions::remote_network))
        .route("/jobs/{job}", get(net::job_status))
        .route("/jobs/{job}/cancel", post(net::job_cancel))
        .route("/credentials", get(net::list_credentials).post(net::set_credentials).delete(net::forget_credentials))
        .route("/fs", get(browse))
        .layer(middleware::from_fn(require_api_header));

    let app = Router::new()
        .route("/", get(|| async { asset(INDEX_HTML, "text/html; charset=utf-8") }))
        .route("/app.js", get(|| async { asset(APP_JS, "text/javascript; charset=utf-8") }))
        .route("/diff.js", get(|| async { asset(DIFF_JS, "text/javascript; charset=utf-8") }))
        .route("/style.css", get(|| async { asset(STYLE_CSS, "text/css; charset=utf-8") }))
        .nest("/api", api)
        .layer(middleware::from_fn(require_local_host))
        .with_state(state);

    // Loopback only: this server can run git commands on your machine.
    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on {addr}: {e}");
            std::process::exit(1);
        }
    };
    let url = format!("http://localhost:{}", cfg.port);
    println!("🌳 DevTree running at {url}  (Ctrl+C to stop)");
    if cfg.open {
        open_browser(&url);
    }
    axum::serve(listener, app).await.expect("server error");
}

fn asset(body: &'static str, ty: &'static str) -> Response {
    ([(header::CONTENT_TYPE, HeaderValue::from_static(ty)), (header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))], body).into_response()
}

fn open_browser(url: &str) {
    let cmd: &[&str] = if cfg!(target_os = "macos") {
        &["open"]
    } else if cfg!(windows) {
        &["cmd", "/C", "start", ""]
    } else {
        &["xdg-open"]
    };
    let _ = std::process::Command::new(cmd[0])
        .args(&cmd[1..])
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

// ---------------------------------------------------------------- request guards

/// Rejects requests whose Host is not loopback, which defeats DNS-rebinding attacks.
async fn require_local_host(req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let name = if host.starts_with('[') { host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default() } else { host.split(':').next().unwrap_or("").to_string() };
    if matches!(name.as_str(), "localhost" | "127.0.0.1" | "[::1]") {
        next.run(req).await
    } else {
        (StatusCode::FORBIDDEN, "DevTree only answers on localhost").into_response()
    }
}

/// API calls must carry a custom header. Browsers refuse to send it cross-origin without a
/// CORS preflight (which we never approve), so other websites cannot drive your git.
async fn require_api_header(req: Request, next: Next) -> Response {
    if req.headers().get("x-devtree").is_some() {
        next.run(req).await
    } else {
        ApiError::new(StatusCode::FORBIDDEN, "missing X-DevTree header").into_response()
    }
}

// ---------------------------------------------------------------- helpers

fn expand_tilde(p: &str) -> PathBuf {
    match p.strip_prefix("~") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') => home().join(rest.trim_start_matches(['/', '\\'])),
        _ => PathBuf::from(p),
    }
}

// ---------------------------------------------------------------- repos

async fn list_repos(State(s): Shared) -> ApiResult {
    ok(s.store.list().await)
}

#[derive(Deserialize)]
struct ImportBody {
    path: String,
}

async fn import_repo(State(s): Shared, Json(b): Json<ImportBody>) -> ApiResult {
    let path = expand_tilde(b.path.trim());
    if !path.is_dir() {
        return Err(bad(format!("{} is not a folder", path.display())));
    }
    if !git::is_repo(&path).await {
        return Err(bad(format!("{} is not a git repository", path.display())));
    }
    let top = PathBuf::from(git::toplevel(&path).await?);
    ok(s.store.add(top).await?)
}

#[derive(Deserialize)]
struct CloneBody {
    url: String,
    parent: Option<String>,
}

async fn clone_repo(State(s): Shared, Query(q): Query<JobQuery>, Json(b): Json<CloneBody>) -> ApiResult {
    let url = b.url.trim();
    if url.is_empty() || url.starts_with('-') || url.chars().any(char::is_whitespace) {
        return Err(bad("invalid repository URL"));
    }
    let parent = match b.parent.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => expand_tilde(p),
        None => s.clone_dir.clone(),
    };
    std::fs::create_dir_all(&parent).map_err(|e| bad(format!("cannot create {}: {e}", parent.display())))?;
    let name = url.trim_end_matches('/').rsplit(['/', ':']).next().unwrap_or("repo").trim_end_matches(".git");
    if name.is_empty() || name == "." || name == ".." {
        return Err(bad("cannot work out a folder name from that URL"));
    }
    let dest = parent.join(name);
    if dest.exists() {
        return Err(bad(format!("{} already exists – import it instead", dest.display())));
    }
    let dest_s = dest.to_string_lossy().into_owned();
    let args = ["clone", "--progress", "--", url, &dest_s];
    let result = net::run_network(&s.net, &format!("clone:{dest_s}"), &parent, &args, git::CLONE_TIMEOUT, q.job.as_deref()).await;
    let out = match result {
        Ok(out) if out.ok => out,
        other => {
            // A cancelled or failed clone can leave a half-written folder behind; it did not exist before.
            let _ = std::fs::remove_dir_all(&dest);
            return net_result(other?);
        }
    };
    let repo = s.store.add(dest).await?;
    ok(json!({ "repo": repo, "output": out }))
}

async fn remove_repo(State(s): Shared, UrlPath(id): UrlPath<String>) -> ApiResult {
    s.store.remove(&id).await?;
    ok(json!({ "removed": id }))
}

#[derive(Deserialize)]
struct FsQuery {
    path: Option<String>,
}

/// Minimal folder browser so repositories can be picked without typing paths.
async fn browse(Query(q): Query<FsQuery>) -> ApiResult {
    let dir = q.path.as_deref().filter(|p| !p.trim().is_empty()).map(expand_tilde).unwrap_or_else(home);
    let dir = dir.canonicalize().map_err(|e| bad(format!("{}: {e}", dir.display())))?;
    let mut entries: Vec<Value> = std::fs::read_dir(&dir)
        .map_err(|e| bad(format!("{}: {e}", dir.display())))?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            let path = e.path();
            Some(json!({ "name": name, "path": path, "repo": path.join(".git").exists() }))
        })
        .collect();
    entries.sort_by_key(|e| e["name"].as_str().unwrap_or("").to_lowercase());
    ok(json!({
        "path": dir,
        "parent": dir.parent().map(Path::to_path_buf),
        "repo": dir.join(".git").exists(),
        "entries": entries,
    }))
}

// ---------------------------------------------------------------- read-only views

#[derive(Deserialize)]
struct GraphQuery {
    limit: Option<usize>,
}

async fn repo_graph(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<GraphQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let limit = q.limit.unwrap_or(1000).clamp(1, 200_000);
    let commits = git::log(&r.path, limit).await?;
    let truncated = commits.len() >= limit;
    let g = graph::layout(commits);
    ok(json!({ "rows": g.rows, "width": g.width, "truncated": truncated }))
}

async fn repo_status(State(s): Shared, UrlPath(id): UrlPath<String>) -> ApiResult {
    let r = repo(&s, &id).await?;
    ok(git::status(&r.path).await?)
}

async fn repo_branches(State(s): Shared, UrlPath(id): UrlPath<String>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let (branches, remotes, stashes) = tokio::try_join!(git::branches(&r.path), git::remotes(&r.path), git::stashes(&r.path))?;
    ok(json!({ "branches": branches, "remotes": remotes, "stashes": stashes }))
}

async fn commit_detail(State(s): Shared, UrlPath((id, sha)): UrlPath<(String, String)>) -> ApiResult {
    let r = repo(&s, &id).await?;
    ok(git::commit_detail(&r.path, valid_sha(&sha)?).await?)
}

#[derive(Deserialize)]
struct DiffQuery {
    path: String,
    /// Old path of a renamed file (commit diffs).
    orig: Option<String>,
    #[serde(default)]
    staged: bool,
    #[serde(default)]
    untracked: bool,
    /// Ignore whitespace changes (`-w`).
    #[serde(default)]
    ignore_ws: bool,
}

async fn commit_diff(State(s): Shared, UrlPath((id, sha)): UrlPath<(String, String)>, Query(q): Query<DiffQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    ok(json!({ "diff": git::commit_file_diff(&r.path, valid_sha(&sha)?, &q.path, q.orig.as_deref(), q.ignore_ws).await? }))
}

async fn worktree_diff(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<DiffQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    ok(json!({ "diff": git::worktree_diff(&r.path, &q.path, q.staged, q.untracked, q.ignore_ws).await? }))
}

// ---------------------------------------------------------------- remote operations

async fn fetch(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<JobQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    remote_cmd(&s, &r, &["fetch", "--all", "--prune", "--progress"], q.job.as_deref()).await
}

#[derive(Deserialize, Default)]
struct PullBody {
    /// "merge" (default: fast-forward when possible, else merge) | "ff-only" | "rebase"
    mode: Option<String>,
}

async fn pull(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<JobQuery>, body: Option<Json<PullBody>>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let mode = body.and_then(|Json(b)| b.mode).unwrap_or_else(|| "merge".into());
    let flag = match mode.as_str() {
        "merge" => "--no-rebase",
        "ff-only" => "--ff-only",
        "rebase" => "--rebase",
        other => return Err(bad(format!("unknown pull mode {other}"))),
    };
    remote_cmd(&s, &r, &["pull", flag, "--autostash", "--no-edit", "--progress"], q.job.as_deref()).await
}

#[derive(Deserialize, Default)]
struct PushBody {
    #[serde(default)]
    force: bool,
}

async fn push(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<JobQuery>, body: Option<Json<PushBody>>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let force = body.is_some_and(|Json(b)| b.force);
    let st = git::status(&r.path).await?;
    let branch = st.branch.ok_or_else(|| bad("HEAD is detached – check out a branch before pushing"))?;
    let mut args = vec!["push", "--progress"];
    if force {
        args.push("--force-with-lease");
    }
    // No upstream yet: publish the branch to the first remote (preferring origin) and track it.
    let remote;
    if st.upstream.is_none() {
        remote = git::default_remote(&r.path).await?.ok_or_else(|| bad("this repository has no remote to push to"))?;
        args.extend(["-u", remote.as_str(), branch.as_str()]);
    }
    remote_cmd(&s, &r, &args, q.job.as_deref()).await
}

// ---------------------------------------------------------------- local operations

#[derive(Deserialize)]
struct RefBody {
    name: String,
    /// For checkout: true when `name` is a remote-tracking branch like `origin/feature`.
    #[serde(default)]
    remote: bool,
    /// For checkout: true to check out `name` (a commit id) as a detached HEAD.
    #[serde(default)]
    detach: bool,
    /// For new branches: the commit to start from (defaults to HEAD).
    start: Option<String>,
}

async fn checkout(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<RefBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let name = valid_ref(&b.name)?;
    let out = if b.remote {
        // Re-use an existing local branch of the same name, otherwise create a tracking one.
        let local = name.split_once('/').map(|(_, l)| l).unwrap_or(name);
        let exists = git::run(&r.path, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{local}")], git::LOCAL_TIMEOUT).await?.ok;
        if exists {
            git::run(&r.path, &["switch", local], git::LOCAL_TIMEOUT).await?
        } else {
            git::run(&r.path, &["switch", "--track", name], git::LOCAL_TIMEOUT).await?
        }
    } else if b.detach {
        git::run(&r.path, &["switch", "--detach", valid_sha(name)?], git::LOCAL_TIMEOUT).await?
    } else {
        git::run(&r.path, &["switch", name], git::LOCAL_TIMEOUT).await?
    };
    net_result(out)
}

async fn create_branch(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<RefBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let name = valid_ref(&b.name)?;
    let mut args = vec!["switch", "-c", name];
    if let Some(start) = b.start.as_deref() {
        args.push(valid_sha(start)?);
    }
    net_result(git::run(&r.path, &args, git::LOCAL_TIMEOUT).await?)
}

#[derive(Deserialize)]
struct PathsBody {
    #[serde(default)]
    paths: Vec<String>,
}

async fn stage(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<PathsBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(b.paths.iter().map(String::as_str));
    net_result(git::run(&r.path, &args, git::LOCAL_TIMEOUT).await?)
}

async fn unstage(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<PathsBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let has_head = git::run(&r.path, &["rev-parse", "--verify", "--quiet", "HEAD"], git::LOCAL_TIMEOUT).await?.ok;
    // Before the first commit there is no HEAD to restore from, so drop the paths from the index instead.
    let mut args = if has_head { vec!["reset", "-q", "HEAD", "--"] } else { vec!["rm", "-r", "-q", "--cached", "--"] };
    if b.paths.is_empty() {
        args.push(".");
    }
    args.extend(b.paths.iter().map(String::as_str));
    net_result(git::run(&r.path, &args, git::LOCAL_TIMEOUT).await?)
}

#[derive(Deserialize)]
struct CommitBody {
    message: String,
    #[serde(default)]
    amend: bool,
}

async fn commit(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<CommitBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    if b.message.trim().is_empty() {
        return Err(bad("commit message is empty"));
    }
    let mut args = vec!["commit", "-m", b.message.as_str()];
    if b.amend {
        args.push("--amend");
    }
    // Hooks and commit signing can be slow, so allow more than the usual local timeout.
    net_result(git::run(&r.path, &args, git::NETWORK_TIMEOUT).await?)
}
