//! Thin async wrapper around the `git` CLI plus parsers for its machine-readable output.
//!
//! Shelling out (instead of linking libgit2) keeps the binary small and means pull/push
//! reuse whatever SSH agent, credential helper and config the user already has.

use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

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
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(["-c", "color.ui=false", "-c", "core.quotepath=false"])
        .args(args)
        // Never block on an interactive username/password prompt: there is no TTY.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let command = format!("git {}", args.join(" "));
    let child = cmd.spawn().map_err(|e| format!("failed to start git: {e}"))?;
    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| format!("git failed: {e}"))?,
        Err(_) => return Err(format!("`{command}` timed out after {}s", timeout.as_secs())),
    };
    Ok(GitOutput {
        ok: out.status.success(),
        code: out.status.code(),
        command,
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Run and return stdout, turning a non-zero exit into an error carrying stderr.
pub async fn run_ok(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = run(dir, args, LOCAL_TIMEOUT).await?;
    if out.ok {
        Ok(out.stdout)
    } else {
        Err(error_text(&out))
    }
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
    let format = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e";
    let out = run(
        dir,
        &["log", "--exclude=refs/stash", "--all", "--topo-order", "--decorate=full", &max, format],
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
            out.push(RefLabel { name: "HEAD".into(), kind: "head", current: true });
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
    RefLabel { name: short_ref(full), kind, current }
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
    let text = run_ok(dir, &["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]).await?;
    Ok(parse_status(&text))
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
    let text = run_ok(dir, &["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B", sha, "--"]).await?;
    let f: Vec<&str> = text.splitn(8, FIELD).collect();
    if f.len() < 8 {
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
        commit_time: f[6].parse().unwrap_or(0),
        message: f[7].trim_end().to_string(),
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
            out.push(ChangedFile { status: status[..1].to_string(), path: to.to_string(), orig_path: Some(first.to_string()) });
        } else {
            out.push(ChangedFile { status: status.to_string(), path: first.to_string(), orig_path: None });
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

/// Diff of one file inside a commit, against its first parent.
pub async fn commit_file_diff(dir: &Path, sha: &str, path: &str) -> Result<String, String> {
    let parent = run(dir, &["rev-parse", "--verify", "--quiet", &format!("{sha}^1")], LOCAL_TIMEOUT).await?;
    let text = if parent.ok {
        run_ok(dir, &["diff", "-M", parent.stdout.trim(), sha, "--", path]).await?
    } else {
        run_ok(dir, &["show", "--format=", sha, "--", path]).await?
    };
    Ok(truncate_diff(text))
}

/// Diff of one working-tree file: staged (index vs HEAD) or unstaged (worktree vs index).
pub async fn worktree_diff(dir: &Path, path: &str, staged: bool, untracked: bool) -> Result<String, String> {
    let text = if untracked {
        // `--no-index` exits 1 when files differ, which is the expected case here.
        let out = run(dir, &["diff", "--no-index", "--", "/dev/null", path], LOCAL_TIMEOUT).await?;
        if out.code.is_some_and(|c| c > 1) {
            return Err(error_text(&out));
        }
        out.stdout
    } else if staged {
        run_ok(dir, &["diff", "--cached", "-M", "--", path]).await?
    } else {
        run_ok(dir, &["diff", "--", path]).await?
    };
    Ok(truncate_diff(text))
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
    fn parses_name_status() {
        let files = parse_name_status("M\0a.txt\0R087\0old.txt\0new.txt\0A\0b.txt\0");
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].status, "R");
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[1].orig_path.as_deref(), Some("old.txt"));
    }
}
