//! Per-request environment: the git worktree, cloned deps/env files, the
//! project's setup command, and the tmux window running metroctl.

use crate::config::Project;
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

fn run(cmd: &mut Command) -> Result<String> {
    let out = cmd.output().with_context(|| format!("running {cmd:?}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let so = String::from_utf8_lossy(&out.stdout);
        let text = if err.trim().is_empty() { so } else { err };
        bail!("{}", tail(&text, 20));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.trim_end().lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Branch and worktree folder for request `id`: `orc/<id>` and `orc-<id>`.
pub fn names(p: &Project, id: &str) -> (String, PathBuf) {
    (format!("orc/{id}"), p.worktrees_dir().join(format!("orc-{id}")))
}

/// `git worktree add` the request's branch, new from the project's base
/// branch (whatever the main checkout has checked out doesn't matter), or the
/// existing one.
pub fn create_worktree(p: &Project, branch: &str, dir: &Path) -> Result<()> {
    if dir.exists() {
        bail!("{} already exists", dir.display());
    }
    std::fs::create_dir_all(p.worktrees_dir())?;
    let branch_exists = Command::new("git").args(["-C", &p.root, "rev-parse", "--verify", "--quiet"]).arg(format!("refs/heads/{branch}")).output()?.status.success();
    let mut cmd = Command::new("git");
    cmd.args(["-C", &p.root, "worktree", "add"]);
    if branch_exists {
        cmd.arg(dir).arg(branch);
    } else {
        cmd.args(["-b", branch]).arg(dir).arg(p.base_branch());
    }
    run(&mut cmd)?;
    Ok(())
}

/// Clone each `copy` path from the main checkout (APFS clones: fast, no extra
/// space until files change). Returns what was copied.
pub fn copy_files(p: &Project, wt: &Path) -> Result<Vec<String>> {
    let mut done = Vec::new();
    for rel in &p.copy {
        let src = Path::new(&p.root).join(rel);
        let dst = wt.join(rel);
        if !src.exists() || dst.exists() {
            continue;
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        run(Command::new("cp").arg("-cR").arg(&src).arg(&dst)).with_context(|| format!("copying {rel}"))?;
        done.push(rel.clone());
    }
    Ok(done)
}

pub fn run_setup(cmd: &str, wt: &Path) -> Result<()> {
    run(Command::new("sh").args(["-lc", cmd]).current_dir(wt)).map(|_| ())
}

pub fn ensure_tmux_session(session: &str) -> Result<()> {
    if Command::new("tmux").args(["has-session", "-t", session]).output()?.status.success() {
        return Ok(());
    }
    run(Command::new("tmux").args(["new-session", "-d", "-s", session]))?;
    Ok(())
}

/// The request's tmux window running metroctl. It drops to a shell when
/// metroctl exits, so the output stays readable.
pub fn open_window(session: &str, id: &str, wt: &Path, metroctl: &str) -> Result<()> {
    ensure_tmux_session(session)?;
    let script = format!("{metroctl}; echo; echo '[metroctl exited]'; exec \"${{SHELL:-zsh}}\" -l");
    run(Command::new("tmux").args(["new-window", "-d", "-t", &format!("{session}:"), "-n", id, "-c"]).arg(wt).arg(script))?;
    Ok(())
}

pub fn kill_window(session: &str, id: &str) {
    let _ = Command::new("tmux").args(["kill-window", "-t", &format!("{session}:{id}")]).output();
}

/// Stop metroctl (deleting the simulator it created), close the window and
/// remove the worktree. The branch is kept.
pub fn teardown(p: &Project, session: &str, id: &str, wt: &Path) -> Vec<String> {
    let mut problems = Vec::new();
    if wt.join(".metroctl/session.json").exists() {
        if let Err(e) = run(Command::new("metroctl").arg("down").current_dir(wt)) {
            problems.push(format!("metroctl down: {e}"));
        }
    }
    kill_window(session, id);
    if wt.exists() {
        if let Err(e) = run(Command::new("git").args(["-C", &p.root, "worktree", "remove", "--force"]).arg(wt)) {
            problems.push(format!("git worktree remove: {e}"));
        }
    }
    problems
}

/// (port, udid, status) from the worktree's metroctl session file.
pub fn metro_session(wt: &Path) -> Option<(Option<u16>, Option<String>, Option<String>)> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(wt.join(".metroctl/session.json")).ok()?).ok()?;
    Some((v["port"].as_u64().map(|p| p as u16), v["udid"].as_str().map(String::from), v["status"].as_str().map(String::from)))
}
