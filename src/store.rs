//! The list of imported repositories, persisted as JSON in the DevTree data directory.

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repo {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

pub struct Store {
    file: PathBuf,
    repos: Mutex<Vec<Repo>>,
}

impl Store {
    pub fn load(data_dir: &Path) -> Self {
        let file = data_dir.join("repos.json");
        let repos = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Store { file, repos: Mutex::new(repos) }
    }

    pub async fn list(&self) -> Vec<Repo> {
        self.repos.lock().await.clone()
    }

    pub async fn get(&self, id: &str) -> Option<Repo> {
        self.repos.lock().await.iter().find(|r| r.id == id).cloned()
    }

    /// Adds a repository (idempotent for the same path) and returns it.
    pub async fn add(&self, path: PathBuf) -> Result<Repo, String> {
        let id = id_for(&path);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
        let mut repos = self.repos.lock().await;
        if let Some(existing) = repos.iter().find(|r| r.path == path) {
            return Ok(existing.clone());
        }
        let repo = Repo { id, name, path };
        repos.push(repo.clone());
        self.save(&repos)?;
        Ok(repo)
    }

    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let mut repos = self.repos.lock().await;
        repos.retain(|r| r.id != id);
        self.save(&repos)
    }

    fn save(&self, repos: &[Repo]) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
        let json = serde_json::to_string_pretty(repos).map_err(|e| e.to_string())?;
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.file).map_err(|e| format!("cannot write {}: {e}", self.file.display()))
    }
}

fn id_for(path: &Path) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("{:012x}", h.finish() & 0xffff_ffff_ffff)
}
