//! Everything around talking to remotes: progress jobs with cancel, a per-repository lock,
//! credentials typed into the UI, and recognising authentication failures.
//!
//! Credentials reach git through DevTree itself acting as a git credential helper
//! (`devtree credential-helper get`). The secrets travel in that child's environment, never
//! on a command line, and are only kept in memory.

use crate::api::{ApiError, ApiResult, AppState, Shared, bad, net_result, ok};
use crate::git::{self, CANCELLED, Extra, GitOutput, Job};
use crate::store::Repo;
use axum::{
    Json,
    extract::{Path as UrlPath, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const CREDS_ENV: &str = "DEVTREE_CREDS";

#[derive(Clone, Serialize, Deserialize)]
struct Cred {
    host: String,
    username: String,
    password: String,
    /// Keep for the rest of this DevTree session; otherwise used for one operation only.
    #[serde(skip)]
    keep: bool,
}

#[derive(Default)]
pub struct Net {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    creds: Mutex<HashMap<String, Cred>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Net {
    pub fn new() -> Self {
        Net::default()
    }

    fn lock_for(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().unwrap().entry(key.to_string()).or_default().clone()
    }

    fn register(&self, id: Option<&str>) -> Result<Option<(String, Arc<Job>)>, ApiError> {
        let Some(id) = id else { return Ok(None) };
        if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(bad("invalid job id"));
        }
        let job = Arc::new(Job::default());
        self.jobs.lock().unwrap().insert(id.to_string(), job.clone());
        Ok(Some((id.to_string(), job)))
    }

    /// Settings that let git use credentials typed into DevTree, if there are any.
    fn credential_extra(&self, extra: &mut Extra) {
        let creds: Vec<Cred> = self.creds.lock().unwrap().values().cloned().collect();
        let Some(helper) = git::self_command("credential-helper") else { return };
        if creds.is_empty() {
            return;
        }
        // `!` makes git run this through the shell and append the action (get/store/erase).
        extra.config.push(format!("credential.helper=!{helper}"));
        extra.env.push((CREDS_ENV, serde_json::to_string(&creds).unwrap_or_default()));
    }

    fn forget_one_shot(&self) {
        self.creds.lock().unwrap().retain(|_, c| c.keep);
    }
}

/// When git would otherwise sit waiting for ssh to ask a question nobody can answer
/// (key passphrase, unknown host), make ssh fail fast instead. Respects the user's own
/// ssh command settings.
async fn ssh_batch_mode(dir: &Path, extra: &mut Extra) {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some() {
        return;
    }
    let configured = git::run(dir, &["config", "--get", "core.sshCommand"], git::LOCAL_TIMEOUT).await;
    if !matches!(configured, Ok(o) if o.ok) {
        extra.env.push(("GIT_SSH_COMMAND", "ssh -o BatchMode=yes".to_string()));
    }
}

/// Runs a git command that talks to a remote: one at a time per `lock_key`, with live
/// progress under `job_id`, cancellable, and with any credentials the user typed in.
pub async fn run_network(net: &Net, lock_key: &str, dir: &Path, args: &[&str], timeout: Duration, job_id: Option<&str>) -> Result<GitOutput, ApiError> {
    let job = net.register(job_id)?;
    let result = async {
        let lock = net.lock_for(lock_key);
        let _guard = match lock.try_lock() {
            Ok(g) => g,
            Err(_) => {
                if let Some((_, j)) = &job {
                    j.set_progress("waiting for another git operation to finish…");
                }
                lock.lock().await
            }
        };
        let mut extra = Extra {
            job: job.as_ref().map(|(_, j)| j.clone()),
            ..Default::default()
        };
        net.credential_extra(&mut extra);
        ssh_batch_mode(dir, &mut extra).await;
        let used_creds = !extra.config.is_empty();
        let out = git::run_with(dir, args, timeout, &extra).await;
        if used_creds {
            net.forget_one_shot();
        }
        out
    }
    .await;
    if let Some((id, _)) = &job {
        net.jobs.lock().unwrap().remove(id);
    }
    result.map_err(|e| if e == CANCELLED { ApiError::new(StatusCode::CONFLICT, e) } else { e.into() })
}

/// Runs a remote-facing command for a repository with progress, cancel and credentials.
pub async fn remote_cmd(s: &AppState, r: &Repo, args: &[&str], job: Option<&str>) -> ApiResult {
    net_result(run_network(&s.net, &r.id, &r.path, args, git::NETWORK_TIMEOUT, job).await?)
}

// ---------------------------------------------------------------- HTTP handlers

#[derive(Deserialize)]
pub struct JobQuery {
    pub job: Option<String>,
}

pub async fn job_status(State(s): Shared, UrlPath(id): UrlPath<String>) -> ApiResult {
    let job = s.net.jobs.lock().unwrap().get(&id).cloned();
    match job {
        Some(j) => ok(json!({ "progress": j.progress() })),
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "no such job (it may have finished)")),
    }
}

pub async fn job_cancel(State(s): Shared, UrlPath(id): UrlPath<String>) -> ApiResult {
    let job = s.net.jobs.lock().unwrap().get(&id).cloned();
    match job {
        Some(j) => {
            j.cancel();
            ok(json!({ "cancelled": id }))
        }
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "no such job (it may have finished)")),
    }
}

#[derive(Deserialize)]
pub struct CredBody {
    host: String,
    username: String,
    password: String,
    #[serde(default)]
    remember: bool,
}

pub async fn set_credentials(State(s): Shared, Json(b): Json<CredBody>) -> ApiResult {
    let host = b.host.trim().to_lowercase();
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c == '/') || b.username.contains('\n') || b.password.contains('\n') {
        return Err(bad("invalid host or credentials"));
    }
    s.net.creds.lock().unwrap().insert(
        host.clone(),
        Cred {
            host: host.clone(),
            username: b.username,
            password: b.password,
            keep: b.remember,
        },
    );
    ok(json!({ "host": host }))
}

/// Hosts with remembered credentials (never the secrets themselves).
pub async fn list_credentials(State(s): Shared) -> ApiResult {
    let hosts: Vec<String> = s.net.creds.lock().unwrap().values().filter(|c| c.keep).map(|c| c.host.clone()).collect();
    ok(json!({ "hosts": hosts }))
}

pub async fn forget_credentials(State(s): Shared) -> ApiResult {
    s.net.creds.lock().unwrap().clear();
    ok(json!({ "forgotten": true }))
}

// ---------------------------------------------------------------- auth failures

#[derive(Debug, Serialize, PartialEq)]
pub struct AuthFailure {
    /// "https" (ask for a username/token) or "ssh" (explain key setup).
    pub kind: &'static str,
    pub host: Option<String>,
    /// For ssh: "publickey" or "hostkey".
    pub reason: Option<&'static str>,
}

pub fn auth_failure(stderr: &str) -> Option<AuthFailure> {
    let lower = stderr.to_lowercase();
    if lower.contains("host key verification failed") {
        return Some(AuthFailure {
            kind: "ssh",
            host: None,
            reason: Some("hostkey"),
        });
    }
    if lower.contains("permission denied (publickey") || lower.contains("permission denied, please try again") {
        let host = stderr
            .lines()
            .find_map(|l| l.split_once("@").map(|(_, h)| h.split([':', ' ']).next().unwrap_or("").to_string()))
            .filter(|h| !h.is_empty());
        return Some(AuthFailure {
            kind: "ssh",
            host,
            reason: Some("publickey"),
        });
    }
    const HTTPS: [&str; 7] = [
        "could not read username",
        "could not read password",
        "authentication failed",
        "invalid username or password",
        "http basic: access denied",
        "the requested url returned error: 401",
        "the requested url returned error: 403",
    ];
    if HTTPS.iter().any(|p| lower.contains(p)) {
        return Some(AuthFailure {
            kind: "https",
            host: url_host(stderr),
            reason: None,
        });
    }
    None
}

/// Host (with port) of the first quoted http(s) URL in git's message.
fn url_host(text: &str) -> Option<String> {
    let start = text.find("'http")? + 1;
    let url = &text[start..start + text[start..].find('\'')?];
    let rest = url.split_once("://")?.1;
    let authority = rest.split('/').next()?;
    let host = authority.rsplit('@').next()?;
    (!host.is_empty()).then(|| host.to_lowercase())
}

// ---------------------------------------------------------------- credential helper mode

/// `devtree credential-helper <action>`: git runs this to ask for a username and password.
/// Answers `get` from the credentials DevTree put in the environment; ignores store/erase.
pub fn credential_helper(action: Option<&str>) {
    if action != Some("get") {
        return;
    }
    let mut host = None;
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if line.is_empty() {
            break;
        }
        if let Some(h) = line.strip_prefix("host=") {
            host = Some(h.to_lowercase());
        }
    }
    let creds: Vec<Cred> = std::env::var(CREDS_ENV).ok().and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    if let Some(c) = host.and_then(|h| creds.into_iter().find(|c| c.host == h)) {
        let mut out = std::io::stdout().lock();
        let _ = write!(out, "username={}\npassword={}\n", c.username, c.password);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_https_auth_failures() {
        let e = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
        assert_eq!(
            auth_failure(e),
            Some(AuthFailure {
                kind: "https",
                host: Some("github.com".into()),
                reason: None
            })
        );
        let e = "remote: Invalid username or password.\nfatal: Authentication failed for 'https://bob@git.example.com:8443/team/repo.git/'";
        assert_eq!(auth_failure(e).unwrap().host.as_deref(), Some("git.example.com:8443"));
    }

    #[test]
    fn recognises_ssh_failures() {
        let e = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.";
        assert_eq!(
            auth_failure(e),
            Some(AuthFailure {
                kind: "ssh",
                host: Some("github.com".into()),
                reason: Some("publickey")
            })
        );
        assert_eq!(auth_failure("Host key verification failed.").unwrap().reason, Some("hostkey"));
        assert_eq!(auth_failure("fatal: not a git repository"), None);
    }
}
