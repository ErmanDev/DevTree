//! devtree.log in the data folder. Started by double-click, DevTree has no console, so
//! startup errors, panics and update steps are also written here to be found later.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static FILE: OnceLock<PathBuf> = OnceLock::new();
static WRITE: Mutex<()> = Mutex::new(());
/// Started over when it grows past this, so it never fills the disk.
const MAX_BYTES: u64 = 512 * 1024;

/// Starts logging to `<data_dir>/devtree.log`, including panics.
pub fn init(data_dir: &Path) {
    let _ = std::fs::create_dir_all(data_dir);
    let _ = FILE.set(data_dir.join("devtree.log"));
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        line(&format!("panic: {info}"));
        default(info);
    }));
}

/// Appends one timestamped line (UTC). Errors are ignored: logging must never stop DevTree.
pub fn line(msg: &str) {
    let Some(path) = FILE.get() else { return };
    let _guard = WRITE.lock();
    let big = std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false);
    let file = std::fs::OpenOptions::new().create(true).append(!big).write(true).truncate(big).open(path);
    if let Ok(mut f) = file {
        let _ = writeln!(f, "{} [{}] {msg}", now(), std::process::id());
    }
}

/// Prints to stderr (if anyone is watching) and logs.
pub fn error(msg: &str) {
    eprintln!("devtree: {msg}");
    line(&format!("error: {msg}"));
}

/// "2026-10-17 13:05:09Z"
fn now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// Days since 1970-01-01 to (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::civil_from_days;

    #[test]
    fn dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(20_743), (2026, 10, 17));
    }
}
