//! Interactive rebase driven from the UI.
//!
//! git asks an editor for the rebase plan and for reworded messages. DevTree answers both by
//! acting as those editors: `devtree write-todo <file>` writes the plan the user built, and
//! `devtree edit-message <file>` (always set as GIT_EDITOR) fills in a new message when the
//! step git is on is a "reword". Messages live in `.git/devtree-reword.json`, so they still
//! apply if the rebase stops for conflicts and is continued later.

use crate::api::{ApiResult, Shared, bad, net_result, ok, repo, valid_sha};
use crate::git::{self, Extra, LOCAL_TIMEOUT, NETWORK_TIMEOUT, REWORD_FILE};
use axum::{
    Json,
    extract::{Path as UrlPath, Query, State},
};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Longest history the rebase editor handles in one go.
const MAX_STEPS: usize = 300;
const TODO_ENV: &str = "DEVTREE_TODO";

// ---------------------------------------------------------------- helper modes (run by git)

/// `devtree write-todo <file>`: replaces git's rebase plan with the one from the UI.
pub fn write_todo(file: Option<&str>) -> std::io::Result<()> {
    if let (Some(file), Ok(todo)) = (file, std::env::var(TODO_ENV)) {
        std::fs::write(file, todo)?;
    }
    Ok(())
}

/// `devtree edit-message <file>`: the commit-message "editor". Leaves the message as git
/// proposed it, except during a reword step of a DevTree rebase.
pub fn edit_message(file: Option<&str>) -> std::io::Result<()> {
    let Some(file) = file else { return Ok(()) };
    let Ok(out) = std::process::Command::new("git").args(["rev-parse", "--absolute-git-dir"]).output() else { return Ok(()) };
    let git_dir = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    let Ok(map) = std::fs::read_to_string(git_dir.join(REWORD_FILE)) else { return Ok(()) };
    let map: HashMap<String, String> = serde_json::from_str(&map).unwrap_or_default();
    // git moves the step it is executing to the end of `done` before calling the editor.
    let done = std::fs::read_to_string(git_dir.join("rebase-merge/done")).unwrap_or_default();
    let Some(step) = done.lines().rev().find(|l| !l.trim().is_empty() && !l.starts_with('#')) else { return Ok(()) };
    let mut parts = step.split_whitespace();
    let (Some(action), Some(sha)) = (parts.next(), parts.next()) else { return Ok(()) };
    let reword = matches!(action, "reword" | "r");
    if let Some(msg) = map.iter().find(|(k, _)| reword && (k.starts_with(sha) || sha.starts_with(k.as_str()))).map(|(_, m)| m) {
        std::fs::write(file, format!("{}\n", msg.trim_end()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------- endpoints

#[derive(Deserialize)]
pub struct PlanQuery {
    base: String,
}

async fn commits_after(dir: &Path, base: &str) -> Result<Vec<git::Commit>, crate::api::ApiError> {
    let is_ancestor = git::run(dir, &["merge-base", "--is-ancestor", base, "HEAD"], LOCAL_TIMEOUT).await?;
    if !is_ancestor.ok {
        return Err(bad("that commit is not part of the current branch's history"));
    }
    let range = format!("{base}..HEAD");
    let count: usize = git::run_ok(dir, &["rev-list", "--count", &range, "--"]).await?.trim().parse().unwrap_or(0);
    if count == 0 {
        return Err(bad("there are no commits after that one on the current branch"));
    }
    if count > MAX_STEPS {
        return Err(bad(format!("{count} commits is too many to edit at once (max {MAX_STEPS})")));
    }
    Ok(git::log_query(dir, &["--reverse", "--topo-order", &range, "--"], LOCAL_TIMEOUT).await?)
}

/// The commits an interactive rebase onto `base` would replay, oldest first.
pub async fn plan(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<PlanQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let base = git::resolve(&r.path, valid_sha(&q.base)?).await?;
    let commits = commits_after(&r.path, &base).await?;
    let merges = commits.iter().filter(|c| c.parents.len() > 1).count();
    ok(json!({ "base": base, "commits": commits, "merges": merges }))
}

#[derive(Deserialize)]
pub struct Step {
    sha: String,
    /// pick | reword | squash | fixup | drop
    action: String,
    /// New message for reword.
    message: Option<String>,
}

#[derive(Deserialize)]
pub struct StartBody {
    base: String,
    steps: Vec<Step>,
}

pub async fn start(State(s): Shared, UrlPath(id): UrlPath<String>, Json(b): Json<StartBody>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let (Some(write_todo), Some(_)) = (git::self_command("write-todo"), git::self_command("edit-message")) else {
        return Err(bad("DevTree could not find its own executable to drive the rebase"));
    };
    let st = git::status(&r.path).await?;
    if st.operation.is_some() {
        return Err(bad("finish or abort the operation in progress first"));
    }
    let base = git::resolve(&r.path, valid_sha(&b.base)?).await?;
    let commits = commits_after(&r.path, &base).await?;

    // Every commit must appear exactly once, so nothing is dropped by accident.
    let mut todo = String::new();
    let mut rewords = HashMap::new();
    let mut seen = std::collections::HashSet::new();
    let mut kept_any = false;
    for step in &b.steps {
        let sha = valid_sha(&step.sha)?;
        let Some(c) = commits.iter().find(|c| c.sha == sha) else {
            return Err(bad(format!("{sha} is not one of the commits being rebased")));
        };
        if !seen.insert(c.sha.clone()) {
            return Err(bad(format!("{} appears twice", &sha[..7.min(sha.len())])));
        }
        match step.action.as_str() {
            "pick" | "drop" => {}
            "reword" => {
                let msg = step.message.as_deref().map(str::trim).filter(|m| !m.is_empty()).ok_or_else(|| bad("a reworded commit needs a message"))?;
                rewords.insert(c.sha.clone(), msg.to_string());
            }
            "squash" | "fixup" if !kept_any => return Err(bad("the first commit can't be squashed: there's nothing above it to squash into")),
            "squash" | "fixup" => {}
            other => return Err(bad(format!("unknown action {other}"))),
        }
        if step.action != "drop" {
            kept_any = true;
        }
        todo.push_str(&format!("{} {}\n", step.action, c.sha));
    }
    if seen.len() != commits.len() {
        return Err(bad("the plan must list every commit (use drop to remove one)"));
    }

    let git_dir = PathBuf::from(git::run_ok(&r.path, &["rev-parse", "--absolute-git-dir"]).await?.trim());
    let reword_file = git_dir.join(REWORD_FILE);
    std::fs::write(&reword_file, serde_json::to_string(&rewords).unwrap_or_default()).map_err(|e| bad(format!("cannot write {}: {e}", reword_file.display())))?;

    let extra = Extra { env: vec![(TODO_ENV, todo), ("GIT_SEQUENCE_EDITOR", write_todo)], ..Default::default() };
    let out = git::run_with(&r.path, &["rebase", "-i", "--autostash", &base], NETWORK_TIMEOUT, &extra).await?;
    if out.ok {
        let _ = std::fs::remove_file(&reword_file);
    }
    net_result(out)
}
