//! Shared plumbing for the HTTP handlers: state, error type and input validation.

use crate::git;
use crate::store::{Repo, Store};
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

pub struct AppState {
    pub store: Store,
    pub clone_dir: PathBuf,
    pub net: crate::net::Net,
}

pub type Shared = State<Arc<AppState>>;
pub type ApiResult = Result<Json<Value>, ApiError>;

pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    /// Extra fields merged into the JSON error body (e.g. what kind of sign-in failed).
    pub extra: Option<Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError { status, message: message.into(), extra: None }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.message });
        if let (Some(Value::Object(extra)), Value::Object(map)) = (self.extra, &mut body) {
            map.extend(extra);
        }
        (self.status, Json(body)).into_response()
    }
}

impl From<String> for ApiError {
    fn from(e: String) -> Self {
        ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, e)
    }
}

pub fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, msg.into())
}

pub fn ok<T: serde::Serialize>(v: T) -> ApiResult {
    Ok(Json(serde_json::to_value(v).map_err(|e| e.to_string())?))
}

pub async fn repo(state: &AppState, id: &str) -> Result<Repo, ApiError> {
    state.store.get(id).await.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("unknown repository {id}")))
}

pub fn valid_sha(s: &str) -> Result<&str, ApiError> {
    if (4..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit()) { Ok(s) } else { Err(bad("invalid commit id")) }
}

/// Refuses anything git could read as an option, plus whitespace/control characters.
pub fn valid_ref(s: &str) -> Result<&str, ApiError> {
    if s.is_empty() || s.starts_with('-') || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        Err(bad(format!("invalid branch name: {s:?}")))
    } else {
        Ok(s)
    }
}

/// Network commands report their full output so the UI console can show it.
pub fn net_result(out: git::GitOutput) -> ApiResult {
    if out.ok {
        return ok(out);
    }
    let mut err = ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, git::error_text(&out));
    // Tell the UI when a remote rejected us, so it can ask for credentials or explain SSH setup.
    if let Some(auth) = crate::net::auth_failure(&out.stderr) {
        err.status = StatusCode::UNAUTHORIZED;
        err.extra = Some(json!({ "auth": auth }));
    }
    Err(err)
}

/// A repository-relative path that cannot escape the repository.
pub fn valid_path(p: &str) -> Result<&str, ApiError> {
    let path = Path::new(p);
    if p.is_empty() || p.contains('\0') || !path.components().all(|c| matches!(c, Component::Normal(_))) {
        Err(bad(format!("invalid file path: {p:?}")))
    } else {
        Ok(p)
    }
}
