//! Updates: asks GitHub for the newest release and, on Windows, swaps in the new devtree.exe
//! and restarts, so nobody has to download and reinstall by hand.
//!
//! Downloads go through `curl` (built into Windows 10+, macOS and most Linux systems), so
//! DevTree needs no HTTP or TLS library of its own.

use crate::api::{ApiResult, bad, ok};
use crate::git;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

const LATEST: &str = "https://api.github.com/repos/ErmanDev/DevTree/releases/latest";
/// Only files from DevTree's own releases are ever downloaded.
const DOWNLOADS: &str = "https://github.com/ErmanDev/DevTree/releases/download/";
const ASSET: &str = "devtree-windows-x64.exe";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Set on a restarted DevTree, so it waits for the old one to free the port.
pub const RESTARTED_ENV: &str = "DEVTREE_RESTARTED";

/// Arguments for the restarted program (set once at startup).
static RESTART_ARGS: OnceLock<Vec<String>> = OnceLock::new();

pub fn set_restart_args(args: Vec<String>) {
    let _ = RESTART_ARGS.set(args);
}

/// Development builds (`cargo run`, the tests) never check: they'd replace target/debug/devtree.
fn enabled() -> bool {
    !cfg!(debug_assertions) && std::env::var_os("DEVTREE_NO_UPDATE").is_none()
}

/// Only the Windows build is published, and only it can replace itself.
fn can_install() -> bool {
    cfg!(windows) && enabled()
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// GET /api/update: is a newer version out?
pub async fn check() -> ApiResult {
    if !enabled() {
        return ok(json!({ "current": VERSION, "available": false }));
    }
    let r = latest().await?;
    let latest = r.tag_name.trim_start_matches('v').to_string();
    ok(json!({
        "current": VERSION,
        "latest": latest,
        "available": newer(&latest, VERSION),
        "url": r.html_url,
        "can_install": can_install() && r.assets.iter().any(|a| a.name == ASSET),
    }))
}

/// POST /api/update/install: download the newest devtree.exe, put it in place of this one
/// and restart. The old program is kept as devtree.exe.old until the next start.
pub async fn install() -> ApiResult {
    if !can_install() {
        return Err(bad("this copy of DevTree can't update itself; download the new version instead"));
    }
    let r = latest().await?;
    let version = r.tag_name.trim_start_matches('v');
    if !newer(version, VERSION) {
        return Err(bad("DevTree is already up to date"));
    }
    let url = |name: &str| {
        r.assets
            .iter()
            .find(|a| a.name == name && a.browser_download_url.starts_with(DOWNLOADS))
            .map(|a| a.browser_download_url.clone())
            .ok_or_else(|| format!("the release has no {name}"))
    };
    let (exe_url, sum_url) = (url(ASSET)?, url(&format!("{ASSET}.sha256"))?);

    let exe = std::env::current_exe().map_err(|e| format!("cannot find devtree.exe: {e}"))?;
    let download = with_suffix(&exe, ".download");
    let expected = String::from_utf8_lossy(&curl(&[&sum_url], 30).await?)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    curl(&["-o", &download.to_string_lossy(), &exe_url], 600).await?;
    let bytes = tokio::fs::read(&download).await.map_err(|e| e.to_string())?;
    let actual: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if expected.len() != 64 || actual != expected {
        let _ = std::fs::remove_file(&download);
        return Err("the download is damaged (its checksum doesn't match); try again later".to_string().into());
    }

    // Windows can't overwrite a running program, but it can rename it.
    let old = with_suffix(&exe, ".old");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| replace_failed(&download, &e))?;
    if let Err(e) = std::fs::rename(&download, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return Err(replace_failed(&download, &e).into());
    }

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(RESTART_ARGS.get().into_iter().flatten()).env(RESTARTED_ENV, "1");
    git::hide_console_std(&mut cmd);
    cmd.spawn()
        .map_err(|e| format!("updated, but cannot restart DevTree: {e}. Start it again yourself."))?;
    // Answer the page first, then make way for the new version.
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        std::process::exit(0);
    });
    ok(json!({ "installed": version }))
}

/// Removes the program left behind by the last update. Runs at startup.
pub fn clean_up() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(with_suffix(&exe, ".old"));
        let _ = std::fs::remove_file(with_suffix(&exe, ".download"));
    }
}

fn replace_failed(download: &Path, e: &std::io::Error) -> String {
    let _ = std::fs::remove_file(download);
    format!("cannot replace devtree.exe ({e}). If it's in a protected folder, download the new version instead.")
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

async fn latest() -> Result<Release, String> {
    let body = curl(&["-H", "Accept: application/vnd.github+json", LATEST], 15).await?;
    serde_json::from_slice(&body).map_err(|e| format!("unexpected answer from GitHub: {e}"))
}

/// Runs curl and returns what it printed. Fails on HTTP errors and follows redirects.
async fn curl(args: &[&str], timeout_secs: u64) -> Result<Vec<u8>, String> {
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args(["-fsSL", "--proto", "=https", "--max-time", &timeout_secs.to_string(), "-A", "DevTree"])
        .args(args)
        .kill_on_drop(true);
    git::hide_console_std(cmd.as_std_mut());
    let out = cmd.output().await.map_err(|e| format!("cannot run curl: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("cannot reach GitHub: {}", err.trim().trim_start_matches("curl: ")))
    }
}

/// Is version `a` newer than `b`? Both like "1.2.3"; anything after the numbers is ignored.
fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>().parse().unwrap_or(0))
            .collect()
    };
    parse(a) > parse(b)
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn compares_versions() {
        assert!(newer("0.1.3", "0.1.2"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("1.0.0", "0.99.0"));
        assert!(!newer("0.1.2", "0.1.2"));
        assert!(!newer("0.1.1", "0.1.2"));
        assert!(!newer("0.1.2-beta", "0.1.2"));
    }
}
