//! Thin async wrapper around the `git` CLI plus parsers for its machine-readable output.
//!
//! Shelling out (instead of linking libgit2) keeps the binary small and means pull/push
//! reuse whatever SSH agent, credential helper and config the user already has.

use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Notify;

pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);
pub const CLONE_TIMEOUT: Duration = Duration::from_secs(1800);

/// Upper bound on diff text returned to the browser.
const MAX_DIFF_BYTES: usize = 512 * 1024;

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

#[derive(Debug, Serialize)]
pub struct GitOutput {
    pub ok: bool,
    pub code: Option<i32>,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run(dir: &Path, args: &[&str], timeout: Duration) -> Result<GitOutput, String> {
    run_with(dir, args, timeout, &Extra::default()).await
}

/// A long-running git command the UI can watch and cancel.
#[derive(Default)]
pub struct Job {
    /// The latest progress line git printed (e.g. "Receiving objects:  45% (450/1000)").
    progress: std::sync::Mutex<String>,
    cancelled: AtomicBool,
    cancel: Notify,
}

impl Job {
    pub fn progress(&self) -> String {
        self.progress.lock().map(|p| p.clone()).unwrap_or_default()
    }

    pub fn set_progress(&self, line: &str) {
        if let Ok(mut p) = self.progress.lock() {
            *p = line.to_string();
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        // notify_one stores a permit, so a cancel that races the spawn is not lost.
        self.cancel.notify_one();
    }
}

/// Optional extras for a git invocation.
#[derive(Default)]
pub struct Extra {
    /// Report progress to, and accept cancellation from, this job.
    pub job: Option<Arc<Job>>,
    /// `-c key=value` settings placed before the subcommand.
    pub config: Vec<String>,
    pub env: Vec<(&'static str, String)>,
    /// Data written to git's standard input (e.g. a patch for `git apply -`).
    pub stdin: Option<Vec<u8>>,
}

/// Windows: start console programs (git, taskkill) without a console window of their own.
/// The desktop app has no console, so each git call would otherwise flash one open.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub fn hide_console_std(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(cmd, CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = cmd;
}

pub async fn run_with(dir: &Path, args: &[&str], timeout: Duration, extra: &Extra) -> Result<GitOutput, String> {
    let mut cmd = Command::new("git");
    hide_console(&mut cmd);
    cmd.arg("-C").arg(dir).args(["-c", "color.ui=false", "-c", "core.quotepath=false"]);
    for c in &extra.config {
        cmd.arg("-c").arg(c);
    }
    cmd.args(args)
        // Never block on an interactive username/password prompt: there is no TTY.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        // `--continue` steps would otherwise open an editor for the commit message.
        .env("GIT_EDITOR", self_command("edit-message").unwrap_or_else(|| "true".into()))
        .env("LC_ALL", "C")
        .envs(extra.env.iter().map(|(k, v)| (*k, v.as_str())))
        .stdin(if extra.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Own process group, so cancelling can stop git's helpers too (see kill_tree).
    #[cfg(unix)]
    cmd.process_group(0);

    let command = format!("git {}", args.join(" "));
    let mut child = cmd.spawn().map_err(|e| format!("failed to start git: {e}"))?;

    if let (Some(data), Some(mut pipe)) = (extra.stdin.clone(), child.stdin.take()) {
        tokio::spawn(async move {
            let _ = pipe.write_all(&data).await;
            // Dropping the pipe closes it, so git sees end-of-input.
        });
    }

    // Read both pipes concurrently; stderr is scanned live for progress lines.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    });
    let job = extra.job.clone();
    let err_task = tokio::spawn(async move {
        let mut all = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            all.extend_from_slice(&chunk[..n]);
            if let Some(job) = &job {
                // Progress redraws with \r; the last non-empty segment is the current state.
                let text = String::from_utf8_lossy(&all[all.len().saturating_sub(512)..]).into_owned();
                if let Some(line) = text.split(['\r', '\n']).map(str::trim).rfind(|l| !l.is_empty()) {
                    job.set_progress(line);
                }
            }
        }
        all
    });

    let cancelled = async {
        match &extra.job {
            Some(j) if j.cancelled.load(Ordering::SeqCst) => {}
            Some(j) => j.cancel.notified().await,
            None => std::future::pending().await,
        }
    };
    let status = tokio::select! {
        s = child.wait() => s.map_err(|e| format!("git failed: {e}"))?,
        _ = cancelled => {
            kill_tree(&mut child).await;
            return Err(CANCELLED.to_string());
        }
        _ = tokio::time::sleep(timeout) => {
            kill_tree(&mut child).await;
            return Err(format!("`{command}` timed out after {}s", timeout.as_secs()));
        }
    };
    let stdout = out_task.await.unwrap_or_default();
    let stderr = err_task.await.unwrap_or_default();
    Ok(GitOutput {
        ok: status.success(),
        code: status.code(),
        command,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

static SELF_EXE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Remembers DevTree's own executable, so git can call back into it (editors, helpers).
pub fn set_self_exe(path: &Path) {
    // Single-quoted for the shell git runs editors through; forward slashes also suit Windows' sh.
    let quoted = path.to_string_lossy().replace('\\', "/").replace('\'', r"'\''");
    let _ = SELF_EXE.set(format!("'{quoted}'"));
}

/// A shell command that runs DevTree in one of its helper modes, e.g. `'/path/devtree' write-todo`.
pub fn self_command(mode: &str) -> Option<String> {
    SELF_EXE.get().map(|exe| format!("{exe} {mode}"))
}

/// Holds new commit messages for "reword" steps of an interactive rebase (see `rebase.rs`).
pub const REWORD_FILE: &str = "devtree-reword.json";

/// Kills git and everything it started. Network commands run helpers such as
/// `git-remote-https`; killing only git would leave them transferring (and, on Windows,
/// holding files open) until the server answers.
async fn kill_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        let killer = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
        #[cfg(windows)]
        let killer = hide_console(&mut Command::new("taskkill"))
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        #[cfg(any(unix, windows))]
        let _ = killer.await;
    }
    let _ = child.kill().await;
}

/// Error text for a command the user cancelled.
pub const CANCELLED: &str = "cancelled by user";

/// Run and return stdout, turning a non-zero exit into an error carrying stderr.
pub async fn run_ok(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = run(dir, args, LOCAL_TIMEOUT).await?;
    if out.ok { Ok(out.stdout) } else { Err(error_text(&out)) }
}

pub fn error_text(out: &GitOutput) -> String {
    let msg = if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr };
    format!("{} failed: {}", out.command, msg.trim())
}

pub async fn is_repo(dir: &Path) -> bool {
    matches!(run(dir, &["rev-parse", "--git-dir"], LOCAL_TIMEOUT).await, Ok(o) if o.ok)
}

pub async fn toplevel(dir: &Path) -> Result<String, String> {
    Ok(run_ok(dir, &["rev-parse", "--show-toplevel"]).await?.trim().to_string())
}

// ---------------------------------------------------------------- log / graph

#[derive(Debug, Clone, Serialize)]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    pub refs: Vec<RefLabel>,
    /// Who committed it, as "Name <email>", only when that differs from the author
    /// (e.g. rebased, cherry-picked or merged through a web UI).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committer: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefLabel {
    pub name: String,
    /// "head" | "branch" | "remote" | "tag"
    pub kind: &'static str,
    pub current: bool,
}

pub async fn log(dir: &Path, limit: usize) -> Result<Vec<Commit>, String> {
    let max = format!("--max-count={limit}");
    let out = run(
        dir,
        &["log", "--exclude=refs/stash", "--all", "--topo-order", "--decorate=full", &max, LOG_FORMAT],
        LOCAL_TIMEOUT,
    )
    .await?;
    if !out.ok {
        // A freshly initialised repository has no commits yet: show an empty graph.
        if out.stderr.contains("does not have any commits") || out.stderr.contains("bad default revision") {
            return Ok(Vec::new());
        }
        return Err(error_text(&out));
    }
    Ok(parse_log(&out.stdout))
}

const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1f%cn%x1f%ce%x1e";

/// `git log` with extra arguments (filters, ranges), parsed into commits.
pub async fn log_query(dir: &Path, args: &[&str], timeout: Duration) -> Result<Vec<Commit>, String> {
    let mut all = vec!["log", "--decorate=full", LOG_FORMAT];
    all.extend(args);
    let out = run(dir, &all, timeout).await?;
    if !out.ok {
        return Err(error_text(&out));
    }
    Ok(parse_log(&out.stdout))
}

/// A commit that touched a file, and the file's path in that commit (it may have been renamed).
#[derive(Debug, Serialize)]
pub struct FileCommit {
    #[serde(flatten)]
    pub commit: Commit,
    pub path: String,
}

pub async fn file_history(dir: &Path, path: &str, limit: usize) -> Result<Vec<FileCommit>, String> {
    let max = format!("--max-count={limit}");
    let text = run_ok(
        dir,
        &[
            "log",
            "--follow",
            "-M",
            "--name-only",
            "--decorate=full",
            &max,
            "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1f",
            "--",
            path,
        ],
    )
    .await?;
    Ok(text
        .split(RECORD)
        .filter(|r| !r.trim().is_empty())
        .filter_map(|r| {
            // Fields end with a separator; the file name follows on its own line.
            let (fields, files) = r.rsplit_once(FIELD)?;
            let commit = parse_log(&format!("{fields}{RECORD}")).pop()?;
            let path = files.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(path).to_string();
            Some(FileCommit { commit, path })
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct BlameLine {
    pub sha: String,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Serialize, Default, Clone)]
pub struct BlameCommit {
    pub author: String,
    pub time: i64,
    pub summary: String,
    /// The file's path in that commit (differs after renames).
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct Blame {
    pub lines: Vec<BlameLine>,
    pub commits: std::collections::HashMap<String, BlameCommit>,
}

/// Line-by-line authorship. `rev` = None blames the working-tree file.
pub async fn blame(dir: &Path, path: &str, rev: Option<&str>) -> Result<Blame, String> {
    let mut args = vec!["blame", "--porcelain", "-M"];
    args.extend(rev);
    args.extend(["--", path]);
    Ok(parse_blame(&run_ok(dir, &args).await?))
}

fn parse_blame(text: &str) -> Blame {
    let mut blame = Blame {
        lines: Vec::new(),
        commits: Default::default(),
    };
    let mut current: Option<(String, u32)> = None;
    for line in text.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            if let Some((sha, n)) = current.take() {
                blame.lines.push(BlameLine {
                    sha,
                    line: n,
                    text: content.to_string(),
                });
            }
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("");
        if key.len() == 40 && key.bytes().all(|b| b.is_ascii_hexdigit()) {
            let n = value.split(' ').nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
            blame.commits.entry(key.to_string()).or_default();
            current = Some((key.to_string(), n));
            continue;
        }
        let Some((sha, _)) = &current else { continue };
        let c = blame.commits.entry(sha.clone()).or_default();
        match key {
            "author" => c.author = value.to_string(),
            "author-time" => c.time = value.parse().unwrap_or(0),
            "summary" => c.summary = value.to_string(),
            "filename" => c.path = value.to_string(),
            _ => {}
        }
    }
    blame
}

/// Files changed between two commits.
pub async fn compare_files(dir: &Path, from: &str, to: &str) -> Result<Vec<ChangedFile>, String> {
    Ok(parse_name_status(&run_ok(dir, &["diff", "--name-status", "-z", "-M", from, to, "--"]).await?))
}

pub async fn compare_diff(dir: &Path, from: &str, to: &str, path: &str, orig: Option<&str>, ignore_ws: bool) -> Result<String, String> {
    let mut args = vec!["diff", "-M", from, to];
    if ignore_ws {
        args.push("-w");
    }
    args.extend(["--", path]);
    args.extend(orig);
    Ok(truncate_diff(run_ok(dir, &args).await?))
}

/// Full commit id for a branch, tag or commit name.
pub async fn resolve(dir: &Path, name: &str) -> Result<String, String> {
    let out = run(
        dir,
        &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{name}^{{commit}}")],
        LOCAL_TIMEOUT,
    )
    .await?;
    if out.ok {
        Ok(out.stdout.trim().to_string())
    } else {
        Err(format!("unknown revision {name}"))
    }
}

fn parse_log(text: &str) -> Vec<Commit> {
    text.split(RECORD)
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.is_empty())
        .filter_map(|r| {
            let f: Vec<&str> = r.split(FIELD).collect();
            if f.len() < 7 {
                return None;
            }
            Some(Commit {
                sha: f[0].to_string(),
                parents: f[1].split_whitespace().map(str::to_string).collect(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                subject: f[5].to_string(),
                refs: parse_decorations(f[6]),
                // Committer fields are optional so formats without them still parse.
                committer: match (f.get(7), f.get(8)) {
                    (Some(name), Some(mail)) if (*name, *mail) != (f[2], f[3]) => Some(format!("{name} <{mail}>")),
                    _ => None,
                },
            })
        })
        .collect()
}

fn parse_decorations(d: &str) -> Vec<RefLabel> {
    let mut out = Vec::new();
    let mut head_target: Option<String> = None;
    for part in d.split(", ").map(str::trim).filter(|p| !p.is_empty()) {
        if let Some(target) = part.strip_prefix("HEAD -> ") {
            head_target = Some(target.to_string());
            out.push(label(target, true));
        } else if part == "HEAD" {
            out.push(RefLabel {
                name: "HEAD".into(),
                kind: "head",
                current: true,
            });
        } else if let Some(tag) = part.strip_prefix("tag: ") {
            out.push(label(tag, false));
        } else {
            out.push(label(part, false));
        }
    }
    // Hide `origin/HEAD` style symbolic refs – they only add noise.
    out.retain(|r| !(r.kind == "remote" && r.name.ends_with("/HEAD")));
    if let Some(t) = head_target {
        let short = short_ref(&t);
        for r in &mut out {
            if r.name == short && r.kind == "branch" {
                r.current = true;
            }
        }
    }
    out
}

fn label(full: &str, current: bool) -> RefLabel {
    let kind = if full.starts_with("refs/heads/") {
        "branch"
    } else if full.starts_with("refs/remotes/") {
        "remote"
    } else if full.starts_with("refs/tags/") {
        "tag"
    } else {
        "branch"
    };
    RefLabel {
        name: short_ref(full),
        kind,
        current,
    }
}

fn short_ref(full: &str) -> String {
    for p in ["refs/heads/", "refs/remotes/", "refs/tags/"] {
        if let Some(s) = full.strip_prefix(p) {
            return s.to_string();
        }
    }
    full.to_string()
}

// ---------------------------------------------------------------- status

#[derive(Debug, Default, Serialize)]
pub struct Status {
    pub operation: Option<Operation>,
    /// Unix time of the last fetch/pull (modification time of FETCH_HEAD).
    pub last_fetch: Option<i64>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
}

#[derive(Debug, Serialize)]
pub struct FileStatus {
    pub path: String,
    pub orig_path: Option<String>,
    /// Index (staged) status letter, `.` when unchanged.
    pub index: char,
    /// Worktree (unstaged) status letter, `.` when unchanged.
    pub worktree: char,
    pub untracked: bool,
    pub conflicted: bool,
}

pub async fn status(dir: &Path) -> Result<Status, String> {
    let (text, git_dir) = tokio::try_join!(
        run_ok(dir, &["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]),
        run_ok(dir, &["rev-parse", "--absolute-git-dir"]),
    )?;
    let mut st = parse_status(&text);
    let git_dir = Path::new(git_dir.trim());
    st.operation = operation(git_dir);
    if st.operation.is_none() {
        // A finished or aborted interactive rebase no longer needs its reword messages.
        let _ = std::fs::remove_file(git_dir.join(REWORD_FILE));
    }
    st.last_fetch = std::fs::metadata(git_dir.join("FETCH_HEAD"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    Ok(st)
}

/// A multi-step operation git has paused, usually because of conflicts.
#[derive(Debug, Serialize, PartialEq)]
pub struct Operation {
    /// "merge" | "rebase" | "cherry-pick" | "revert" | "am"
    pub kind: &'static str,
    /// Branch being rebased.
    pub head_name: Option<String>,
    /// Commit being rebased onto.
    pub onto: Option<String>,
    /// Commit being merged / picked / reverted.
    pub incoming: Option<String>,
    pub step: Option<u32>,
    pub total: Option<u32>,
}

impl Operation {
    pub fn can_skip(&self) -> bool {
        self.kind != "merge"
    }
}

pub fn operation(git_dir: &Path) -> Option<Operation> {
    let read = |p: &str| {
        std::fs::read_to_string(git_dir.join(p))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let num = |p: &str| read(p).and_then(|s| s.parse().ok());
    let blank = |kind| Operation {
        kind,
        head_name: None,
        onto: None,
        incoming: None,
        step: None,
        total: None,
    };

    if git_dir.join("rebase-merge").is_dir() {
        return Some(Operation {
            head_name: read("rebase-merge/head-name").map(|h| short_ref(&h)),
            onto: read("rebase-merge/onto"),
            incoming: read("REBASE_HEAD"),
            step: num("rebase-merge/msgnum"),
            total: num("rebase-merge/end"),
            ..blank("rebase")
        });
    }
    if git_dir.join("rebase-apply").is_dir() {
        let am = git_dir.join("rebase-apply/applying").exists();
        return Some(Operation {
            head_name: read("rebase-apply/head-name").map(|h| short_ref(&h)),
            onto: read("rebase-apply/onto"),
            incoming: read("REBASE_HEAD"),
            step: num("rebase-apply/next"),
            total: num("rebase-apply/last"),
            ..blank(if am { "am" } else { "rebase" })
        });
    }
    for (file, kind) in [("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")] {
        if let Some(head) = read(file) {
            return Some(Operation {
                incoming: head.lines().next().map(str::to_string),
                ..blank(kind)
            });
        }
    }
    None
}

fn parse_status(text: &str) -> Status {
    let mut st = Status::default();
    let mut entries = text.split('\0');
    while let Some(e) = entries.next() {
        if e.is_empty() {
            continue;
        }
        if let Some(h) = e.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.head ") {
                st.branch = (v != "(detached)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.oid ") {
                st.head = (v != "(initial)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                for n in v.split_whitespace() {
                    if let Some(a) = n.strip_prefix('+') {
                        st.ahead = a.parse().unwrap_or(0);
                    } else if let Some(b) = n.strip_prefix('-') {
                        st.behind = b.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let kind = e.as_bytes()[0];
        match kind {
            b'?' => st.files.push(FileStatus {
                path: e[2..].to_string(),
                orig_path: None,
                index: '.',
                worktree: '?',
                untracked: true,
                conflicted: false,
            }),
            b'1' | b'2' | b'u' => {
                // Fields before the path: 1 → 8, 2 → 9, u → 10.
                let n = match kind {
                    b'1' => 8,
                    b'2' => 9,
                    _ => 10,
                };
                let parts: Vec<&str> = e.splitn(n + 1, ' ').collect();
                if parts.len() <= n {
                    continue;
                }
                let xy: Vec<char> = parts[1].chars().collect();
                let orig_path = if kind == b'2' { entries.next().map(str::to_string) } else { None };
                st.files.push(FileStatus {
                    path: parts[n].to_string(),
                    orig_path,
                    index: xy.first().copied().unwrap_or('.'),
                    worktree: xy.get(1).copied().unwrap_or('.'),
                    untracked: false,
                    conflicted: kind == b'u',
                });
            }
            _ => {}
        }
    }
    st
}

// ---------------------------------------------------------------- refs

#[derive(Debug, Serialize)]
pub struct Branch {
    pub name: String,
    /// "local" | "remote" | "tag"
    pub kind: &'static str,
    pub sha: String,
    pub upstream: Option<String>,
    pub track: Option<String>,
    pub current: bool,
}

pub async fn branches(dir: &Path) -> Result<Vec<Branch>, String> {
    let text = run_ok(
        dir,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )
    .await?;
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split(FIELD).collect();
        if f.len() < 6 || f[0].ends_with("/HEAD") {
            continue;
        }
        let kind = if f[0].starts_with("refs/heads/") {
            "local"
        } else if f[0].starts_with("refs/remotes/") {
            "remote"
        } else {
            "tag"
        };
        out.push(Branch {
            name: f[1].to_string(),
            kind,
            sha: f[2].to_string(),
            upstream: (!f[3].is_empty()).then(|| f[3].to_string()),
            track: (!f[4].is_empty()).then(|| f[4].to_string()),
            current: f[5] == "*",
        });
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct Stash {
    pub index: u32,
    pub sha: String,
    pub message: String,
    pub time: i64,
}

pub async fn stashes(dir: &Path) -> Result<Vec<Stash>, String> {
    let text = run_ok(dir, &["stash", "list", "--format=%gd%x1f%H%x1f%gs%x1f%ct"]).await?;
    Ok(text
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(FIELD).collect();
            let index = f.first()?.strip_prefix("stash@{")?.strip_suffix('}')?.parse().ok()?;
            Some(Stash {
                index,
                sha: f.get(1)?.to_string(),
                message: f.get(2)?.to_string(),
                time: f.get(3)?.parse().unwrap_or(0),
            })
        })
        .collect())
}

/// Picks the remote to use when none is given: `origin` if present, else the first one.
pub async fn default_remote(dir: &Path) -> Result<Option<String>, String> {
    let remotes = remotes(dir).await?;
    Ok(remotes.iter().find(|r| *r == "origin").or(remotes.first()).cloned())
}

pub async fn remotes(dir: &Path) -> Result<Vec<String>, String> {
    Ok(run_ok(dir, &["remote"]).await?.lines().map(str::to_string).collect())
}

// ---------------------------------------------------------------- commit detail

#[derive(Debug, Serialize)]
pub struct CommitDetail {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub committer: String,
    pub committer_email: String,
    pub commit_time: i64,
    pub message: String,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Serialize)]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
    pub orig_path: Option<String>,
}

pub async fn commit_detail(dir: &Path, sha: &str) -> Result<CommitDetail, String> {
    let text = run_ok(
        dir,
        &["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B", sha, "--"],
    )
    .await?;
    let f: Vec<&str> = text.splitn(9, FIELD).collect();
    if f.len() < 9 {
        return Err("unexpected git show output".into());
    }
    let parents: Vec<String> = f[1].split_whitespace().map(str::to_string).collect();
    let names = match parents.first() {
        Some(p) => run_ok(dir, &["diff", "--name-status", "-z", "-M", p, sha, "--"]).await?,
        None => run_ok(dir, &["diff-tree", "-r", "--root", "--no-commit-id", "--name-status", "-z", "-M", sha, "--"]).await?,
    };
    Ok(CommitDetail {
        sha: f[0].to_string(),
        parents,
        author: f[2].to_string(),
        email: f[3].to_string(),
        author_time: f[4].parse().unwrap_or(0),
        committer: f[5].to_string(),
        committer_email: f[6].to_string(),
        commit_time: f[7].parse().unwrap_or(0),
        message: f[8].trim_end().to_string(),
        files: parse_name_status(&names),
    })
}

fn parse_name_status(text: &str) -> Vec<ChangedFile> {
    let mut out = Vec::new();
    let mut it = text.split('\0').filter(|s| !s.is_empty());
    while let Some(status) = it.next() {
        let Some(first) = it.next() else { break };
        if status.starts_with('R') || status.starts_with('C') {
            let Some(to) = it.next() else { break };
            out.push(ChangedFile {
                status: status[..1].to_string(),
                path: to.to_string(),
                orig_path: Some(first.to_string()),
            });
        } else {
            out.push(ChangedFile {
                status: status.to_string(),
                path: first.to_string(),
                orig_path: None,
            });
        }
    }
    out
}

// ---------------------------------------------------------------- diffs

pub fn truncate_diff(mut s: String) -> String {
    if s.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n\n… diff truncated by DevTree …\n");
    }
    s
}

/// Diff of one file inside a commit, against its first parent. `orig` is the old path of a rename.
pub async fn commit_file_diff(dir: &Path, sha: &str, path: &str, orig: Option<&str>, ignore_ws: bool) -> Result<String, String> {
    let parent = run(dir, &["rev-parse", "--verify", "--quiet", &format!("{sha}^1")], LOCAL_TIMEOUT).await?;
    let mut args = if parent.ok {
        vec!["diff", "-M", parent.stdout.trim(), sha]
    } else {
        vec!["show", "--format=", "-M", sha]
    };
    if ignore_ws {
        args.push("-w");
    }
    args.extend(["--", path]);
    args.extend(orig);
    Ok(truncate_diff(run_ok(dir, &args).await?))
}

/// Diff of one working-tree file: staged (index vs HEAD) or unstaged (worktree vs index).
pub async fn worktree_diff(dir: &Path, path: &str, staged: bool, untracked: bool, ignore_ws: bool) -> Result<String, String> {
    let ws: &[&str] = if ignore_ws { &["-w"] } else { &[] };
    let text = if untracked {
        // `--no-index` exits 1 when files differ, which is the expected case here.
        let out = run(dir, &["diff", "--no-index", "--", "/dev/null", path], LOCAL_TIMEOUT).await?;
        if out.code.is_some_and(|c| c > 1) {
            return Err(error_text(&out));
        }
        out.stdout
    } else {
        let mut args = vec!["diff"];
        if staged {
            args.extend(["--cached", "-M"]);
        }
        args.extend(ws);
        args.extend(["--", path]);
        run_ok(dir, &args).await?
    };
    Ok(truncate_diff(text))
}

/// Raw bytes of a file at a revision spec such as `HEAD:src/a.png` or `:src/a.png` (index).
pub async fn blob(dir: &Path, spec: &str) -> Result<Option<Vec<u8>>, String> {
    let out = hide_console(&mut Command::new("git"))
        .arg("-C")
        .arg(dir)
        .args(["cat-file", "blob", spec])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(LOCAL_TIMEOUT, out)
        .await
        .map_err(|_| "git cat-file timed out".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(out.status.success().then_some(out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_decorations() {
        let refs = parse_decorations("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0");
        let names: Vec<_> = refs.iter().map(|r| (r.name.as_str(), r.kind, r.current)).collect();
        assert_eq!(names, vec![("main", "branch", true), ("origin/main", "remote", false), ("v1.0", "tag", false)]);
    }

    #[test]
    fn parses_status() {
        let text = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 M. N... 100644 100644 100644 aaa bbb src/a.rs\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new name.rs\0old.rs\0\
? notes.txt\0";
        let st = parse_status(text);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.files.len(), 3);
        assert_eq!(st.files[0].path, "src/a.rs");
        assert_eq!(st.files[0].index, 'M');
        assert_eq!(st.files[1].path, "new name.rs");
        assert_eq!(st.files[1].orig_path.as_deref(), Some("old.rs"));
        assert!(st.files[2].untracked);
    }

    #[test]
    fn committer_only_when_different() {
        let rec = |cn: &str, ce: &str| format!("abc\u{1f}\u{1f}Ada\u{1f}ada@x\u{1f}1\u{1f}msg\u{1f}\u{1f}{cn}\u{1f}{ce}\u{1e}");
        assert_eq!(parse_log(&rec("Ada", "ada@x"))[0].committer, None);
        assert_eq!(
            parse_log(&rec("GitHub", "noreply@github.com"))[0].committer.as_deref(),
            Some("GitHub <noreply@github.com>")
        );
        // Older format without committer fields still parses.
        assert_eq!(parse_log("abc\u{1f}\u{1f}Ada\u{1f}ada@x\u{1f}1\u{1f}msg\u{1f}\u{1e}")[0].committer, None);
    }

    #[test]
    fn parses_blame_porcelain() {
        let sha = "a".repeat(40);
        let text = format!("{sha} 1 1 2\nauthor Ada\nauthor-time 100\nsummary First\nfilename a.rs\n\tfn main() {{\n{sha} 2 2\n\t}}\n");
        let b = parse_blame(&text);
        assert_eq!(b.lines.len(), 2);
        assert_eq!(b.lines[1].text, "}");
        assert_eq!(b.lines[1].line, 2);
        let c = &b.commits[&sha];
        assert_eq!((c.author.as_str(), c.time, c.summary.as_str(), c.path.as_str()), ("Ada", 100, "First", "a.rs"));
    }

    #[test]
    fn parses_name_status() {
        let files = parse_name_status("M\0a.txt\0R087\0old.txt\0new.txt\0A\0b.txt\0");
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].status, "R");
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[1].orig_path.as_deref(), Some("old.txt"));
    }

    /// Creates a throwaway repository and runs shell-free git commands in it.
    struct TempRepo(std::path::PathBuf);

    impl TempRepo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("devtree-test-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let r = TempRepo(dir);
            r.git(&["init", "-q", "-b", "main"]);
            r.git(&["config", "user.name", "Test"]);
            r.git(&["config", "user.email", "t@example.com"]);
            r
        }
        fn git(&self, args: &[&str]) -> bool {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        }
        fn commit(&self, file: &str, text: &str, msg: &str) {
            std::fs::write(self.0.join(file), text).unwrap();
            assert!(self.git(&["add", "-A"]));
            assert!(self.git(&["commit", "-q", "-m", msg]));
        }
        /// main and `other` both change the same line of a.txt.
        fn diverged(name: &str) -> Self {
            let r = TempRepo::new(name);
            r.commit("a.txt", "one\n", "base");
            r.git(&["switch", "-q", "-c", "other"]);
            r.commit("a.txt", "theirs\n", "theirs");
            r.git(&["switch", "-q", "main"]);
            r.commit("a.txt", "ours\n", "ours");
            r
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn detects_merge_conflict() {
        let r = TempRepo::diverged("merge");
        assert!(status(&r.0).await.unwrap().operation.is_none());
        assert!(!r.git(&["merge", "other"]));
        let st = status(&r.0).await.unwrap();
        let op = st.operation.expect("merge in progress");
        assert_eq!(op.kind, "merge");
        assert!(op.incoming.is_some());
        assert!(st.files.iter().any(|f| f.path == "a.txt" && f.conflicted));
        assert!(r.git(&["merge", "--abort"]));
        assert!(status(&r.0).await.unwrap().operation.is_none());
    }

    #[tokio::test]
    async fn detects_rebase_conflict() {
        let r = TempRepo::diverged("rebase");
        assert!(!r.git(&["rebase", "other"]));
        let op = status(&r.0).await.unwrap().operation.expect("rebase in progress");
        assert_eq!(op.kind, "rebase");
        assert_eq!(op.head_name.as_deref(), Some("main"));
        assert_eq!((op.step, op.total), (Some(1), Some(1)));
        assert!(op.can_skip());
    }

    #[tokio::test]
    async fn lists_stashes() {
        let r = TempRepo::new("stash");
        r.commit("a.txt", "one\n", "base");
        std::fs::write(r.0.join("a.txt"), "two\n").unwrap();
        assert!(r.git(&["stash", "push", "-m", "my work"]));
        let list = stashes(&r.0).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].index, 0);
        assert!(list[0].message.ends_with("my work"));
    }
}
