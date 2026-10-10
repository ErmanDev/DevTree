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
}

pub type Shared = State<Arc<AppState>>;
pub type ApiResult = Result<Json<Value>, ApiError>;

pub struct ApiError(pub StatusCode, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<String> for ApiError {
    fn from(e: String) -> Self {
        ApiError(StatusCode::UNPROCESSABLE_ENTITY, e)
    }
}

pub fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

pub fn ok<T: serde::Serialize>(v: T) -> ApiResult {
    Ok(Json(serde_json::to_value(v).map_err(|e| e.to_string())?))
}

pub async fn repo(state: &AppState, id: &str) -> Result<Repo, ApiError> {
    state.store.get(id).await.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("unknown repository {id}")))
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
    if out.ok { ok(out) } else { Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, git::error_text(&out))) }
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
