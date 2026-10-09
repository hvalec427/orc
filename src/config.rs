//! `~/.config/orc/`: the projects config, the request registry, and each
//! request's conversation log.

use crate::proto::{Item, Request};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub root: String,
    /// Where worktrees go (default `<root>-worktrees`).
    #[serde(default)]
    pub worktrees: Option<String>,
    /// Paths (relative to root) cloned into each new worktree: deps, env files.
    #[serde(default)]
    pub copy: Vec<String>,
    /// Shell command run in the worktree after copying (e.g. `cd ios && pod install`).
    #[serde(default)]
    pub setup: Option<String>,
    /// metroctl command for the request's tmux window.
    #[serde(default)]
    pub metroctl: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Branch requests start from and finish into (default: develop, else main, else master).
    #[serde(default)]
    pub base: Option<String>,
}

impl Project {
    pub fn worktrees_dir(&self) -> PathBuf {
        match &self.worktrees {
            Some(w) => PathBuf::from(w),
            None => PathBuf::from(format!("{}-worktrees", self.root.trim_end_matches('/'))),
        }
    }

    pub fn base_branch(&self) -> String {
        if let Some(b) = &self.base {
            return b.clone();
        }
        for b in ["develop", "main", "master"] {
            let ok = std::process::Command::new("git").args(["-C", &self.root, "rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")]).output().is_ok_and(|o| o.status.success());
            if ok {
                return b.to_string();
            }
        }
        "main".into()
    }

    pub fn metroctl_command(&self) -> String {
        self.metroctl.clone().unwrap_or_else(|| "metroctl up --port auto --new-sim --prebuilt".into())
    }
}

#[derive(Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub projects: Vec<Project>,
    /// tmux session that holds the TUI and the metroctl windows.
    #[serde(default)]
    pub tmux_session: Option<String>,
}

impl Config {
    pub fn project(&self, name: &str) -> Result<&Project> {
        self.projects.iter().find(|p| p.name == name).ok_or_else(|| anyhow!("no project {name:?} in {}", config_path().display()))
    }

    pub fn tmux_session(&self) -> String {
        self.tmux_session.clone().unwrap_or_else(|| "orc".into())
    }
}

pub fn dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::env::var("ORC_HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(home).join(".config/orc"))
}

pub fn config_path() -> PathBuf {
    dir().join("config.json")
}

/// `<dir>/orcd.sock`, or a short temp path when that's too long for a Unix
/// socket (~104 bytes on macOS).
pub fn socket_path() -> PathBuf {
    let p = dir().join("orcd.sock");
    if p.as_os_str().len() < 100 {
        return p;
    }
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    dir().hash(&mut h);
    std::env::temp_dir().join(format!("orcd-{:x}.sock", h.finish()))
}

pub fn load_config() -> Result<Config> {
    let p = config_path();
    if !p.exists() {
        return Ok(Config::default());
    }
    serde_json::from_slice(&std::fs::read(&p)?).with_context(|| format!("parsing {}", p.display()))
}

fn requests_path() -> PathBuf {
    dir().join("requests.json")
}

pub fn load_requests() -> Vec<Request> {
    std::fs::read(requests_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_requests(list: &[Request]) {
    let _ = std::fs::create_dir_all(dir());
    let tmp = dir().join("requests.json.tmp");
    if let Ok(json) = serde_json::to_vec_pretty(list) {
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, requests_path());
        }
    }
}

fn log_path(id: &str) -> PathBuf {
    dir().join("requests").join(format!("{id}.jsonl"))
}

pub fn append_item(id: &str, item: &Item) {
    let p = log_path(id);
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", serde_json::to_string(item).unwrap_or_default());
    }
}

pub fn remove_items(id: &str) {
    let _ = std::fs::remove_file(log_path(id));
}

pub fn load_items(id: &str) -> Vec<Item> {
    std::fs::read_to_string(log_path(id)).map(|s| s.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()).unwrap_or_default()
}

/// `Fix login crash!` → `fix-login-crash`, unique among `taken`.
pub fn slug(title: &str, taken: &[String]) -> String {
    let mut s = String::new();
    for c in title.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
        if s.len() >= 40 {
            break;
        }
    }
    let base = s.trim_end_matches('-').to_string();
    let base = if base.is_empty() { "request".to_string() } else { base };
    let mut out = base.clone();
    let mut n = 2;
    while taken.contains(&out) {
        out = format!("{base}-{n}");
        n += 1;
    }
    out
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slug("Fix login crash!", &[]), "fix-login-crash");
        assert_eq!(slug("Fix login crash", &["fix-login-crash".into()]), "fix-login-crash-2");
        assert_eq!(slug("  ", &[]), "request");
        assert_eq!(slug("Add ÄÖ price screen", &[]), "add-price-screen");
    }
}
