//! Read-only views for exploring history: file history, blame, search and compare.

use crate::api::{ApiResult, Shared, bad, ok, repo, valid_path, valid_ref};
use crate::git::{self, LOCAL_TIMEOUT};
use axum::extract::{Path as UrlPath, Query, State};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

/// Most results a search returns.
const SEARCH_LIMIT: usize = 300;
/// Content searches (`git log -S`) read every diff, so they get longer.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Deserialize)]
pub struct FileQuery {
    path: String,
    /// Blame at this commit instead of the working tree.
    rev: Option<String>,
}

pub async fn file_history(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<FileQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    ok(git::file_history(&r.path, valid_path(&q.path)?, 500).await?)
}

pub async fn blame(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<FileQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let rev = match q.rev.as_deref() {
        Some(rev) => Some(git::resolve(&r.path, valid_ref(rev)?).await?),
        None => None,
    };
    ok(git::blame(&r.path, valid_path(&q.path)?, rev.as_deref()).await?)
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    /// "message" | "author" | "sha" | "file" | "code"
    mode: String,
}

/// Searches the whole history, not just the commits loaded in the graph.
pub async fn search(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<SearchQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let term = q.q.trim();
    if term.is_empty() || term.contains('\n') {
        return Err(bad("enter something to search for"));
    }
    let max = format!("--max-count={SEARCH_LIMIT}");
    let base = ["--all", "--exclude=refs/stash", max.as_str()];
    let commits = match q.mode.as_str() {
        "message" => {
            let grep = format!("--grep={term}");
            git::log_query(&r.path, &[&base[..], &["-i", "--fixed-strings", &grep]].concat(), LOCAL_TIMEOUT).await?
        }
        "author" => {
            let author = format!("--author={term}");
            git::log_query(&r.path, &[&base[..], &["-i", "--fixed-strings", &author]].concat(), LOCAL_TIMEOUT).await?
        }
        "sha" => {
            if !term.bytes().all(|b| b.is_ascii_hexdigit()) || term.len() < 4 {
                return Err(bad("a commit id is 4–40 hex characters"));
            }
            match git::resolve(&r.path, term).await {
                Ok(sha) => git::log_query(&r.path, &["-n", "1", &sha, "--"], LOCAL_TIMEOUT).await?,
                Err(_) => Vec::new(),
            }
        }
        "file" => {
            if term.contains(['*', '?', '[', ']', '\\', ':']) {
                return Err(bad("file search takes plain text (no wildcards)"));
            }
            // Any file or folder whose name contains the text, case-insensitively.
            let file = format!(":(icase,glob)**/*{term}*");
            let folder = format!(":(icase,glob)**/*{term}*/**");
            git::log_query(&r.path, &[&base[..], &["--", &file, &folder]].concat(), LOCAL_TIMEOUT).await?
        }
        "code" => {
            // Commits that added or removed the text (git's "pickaxe").
            let pickaxe = format!("-S{term}");
            git::log_query(&r.path, &[&base[..], &[&pickaxe]].concat(), SEARCH_TIMEOUT).await?
        }
        other => return Err(bad(format!("unknown search mode {other}"))),
    };
    ok(json!({ "commits": commits, "limited": commits.len() >= SEARCH_LIMIT }))
}

#[derive(Deserialize)]
pub struct CompareQuery {
    from: String,
    to: String,
    path: Option<String>,
    orig: Option<String>,
    #[serde(default)]
    ignore_ws: bool,
}

/// Differences between two commits/branches: changed files plus commits unique to each side.
pub async fn compare(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<CompareQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let from = git::resolve(&r.path, valid_ref(&q.from)?).await?;
    let to = git::resolve(&r.path, valid_ref(&q.to)?).await?;
    let only_to = format!("{from}..{to}");
    let only_from = format!("{to}..{from}");
    let to_args = ["--max-count=200", only_to.as_str(), "--"];
    let from_args = ["--max-count=200", only_from.as_str(), "--"];
    let (files, ahead, behind) = tokio::try_join!(
        git::compare_files(&r.path, &from, &to),
        git::log_query(&r.path, &to_args, LOCAL_TIMEOUT),
        git::log_query(&r.path, &from_args, LOCAL_TIMEOUT),
    )?;
    ok(json!({ "from": from, "to": to, "files": files, "only_to": ahead, "only_from": behind }))
}

pub async fn compare_diff(State(s): Shared, UrlPath(id): UrlPath<String>, Query(q): Query<CompareQuery>) -> ApiResult {
    let r = repo(&s, &id).await?;
    let path = valid_path(q.path.as_deref().unwrap_or_default())?;
    let orig = q.orig.as_deref().filter(|o| !o.is_empty()).map(valid_path).transpose()?;
    let from = git::resolve(&r.path, valid_ref(&q.from)?).await?;
    let to = git::resolve(&r.path, valid_ref(&q.to)?).await?;
    ok(json!({ "diff": git::compare_diff(&r.path, &from, &to, path, orig, q.ignore_ws).await? }))
}
