//! Finishing a request: open a PR for its branch, or land it on the base
//! branch (rebased, optionally squashed) so it can be torn down.

use crate::config::Project;
use crate::proto::Request;
use anyhow::{bail, Context, Result};
use std::process::Command;

fn git(dir: &str, args: &[&str]) -> Result<String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().context("running git")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let so = String::from_utf8_lossy(&out.stdout);
        bail!("git {}: {}", args.join(" "), if err.trim().is_empty() { so.trim().to_string() } else { err.trim().to_string() });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn ok(dir: &str, args: &[&str]) -> bool {
    Command::new("git").arg("-C").arg(dir).args(args).output().is_ok_and(|o| o.status.success())
}

fn subjects(wt: &str, base: &str) -> Result<Vec<String>> {
    Ok(git(wt, &["log", "--reverse", "--format=%s", &format!("{base}..HEAD")])?.lines().map(String::from).collect())
}

fn check_clean(wt: &str) -> Result<()> {
    let dirty = git(wt, &["status", "--porcelain"])?;
    if !dirty.is_empty() {
        let files: Vec<&str> = dirty.lines().take(8).collect();
        bail!("the worktree has uncommitted changes; commit or discard them first (or ask the agent):\n{}", files.join("\n"));
    }
    Ok(())
}

/// Push the branch and open a PR against the base branch. Returns its URL.
pub fn create_pr(p: &Project, r: &Request) -> Result<String> {
    let (wt, base) = (r.worktree.as_str(), p.base_branch());
    check_clean(wt)?;
    let commits = subjects(wt, &base)?;
    if commits.is_empty() {
        bail!("{} has no commits on top of {base}", r.branch);
    }
    git(wt, &["push", "-u", "origin", &r.branch])?;
    let body = commits.iter().map(|s| format!("- {s}")).collect::<Vec<_>>().join("\n");
    let out = Command::new("gh").args(["pr", "create", "--base", &base, "--head", &r.branch, "--title", &r.title, "--body", &body]).current_dir(wt).output().context("running gh (is it installed and logged in?)")?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().lines().last().unwrap_or("").to_string());
    }
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    if err.contains("already exists") {
        let url = Command::new("gh").args(["pr", "view", &r.branch, "--json", "url", "-q", ".url"]).current_dir(wt).output()?;
        return Ok(format!("{} (already open; pushed the new commits)", String::from_utf8_lossy(&url.stdout).trim()));
    }
    bail!("gh pr create: {}", err.trim())
}

/// Rebase the branch onto the base branch (squashing it into one commit
/// first if asked) and fast-forward the base branch to it, locally. Nothing
/// is pushed. Returns a summary.
pub fn land(p: &Project, r: &Request, squash: bool) -> Result<String> {
    let (wt, root, base) = (r.worktree.as_str(), p.root.as_str(), p.base_branch());
    check_clean(wt)?;
    let commits = subjects(wt, &base)?;
    if commits.is_empty() {
        bail!("{} has no commits on top of {base}", r.branch);
    }
    let head = git(wt, &["rev-parse", "HEAD"])?;
    if squash && commits.len() > 1 {
        let mb = git(wt, &["merge-base", &base, "HEAD"])?;
        git(wt, &["reset", "--soft", &mb])?;
        let msg = if commits.len() == 1 { commits[0].clone() } else { r.title.clone() };
        if let Err(e) = git(wt, &["commit", "-q", "-m", &msg]) {
            let _ = git(wt, &["reset", "--soft", &head]); // back to the original commits
            bail!("squash commit failed (a commit hook?): {e}");
        }
    }
    if let Err(e) = git(wt, &["rebase", &base]) {
        let _ = git(wt, &["rebase", "--abort"]);
        bail!("rebasing onto {base} hit conflicts, so nothing changed. Ask the agent to rebase onto {base} and resolve them, then try again.\n{e}");
    }
    let new = git(wt, &["rev-parse", "HEAD"])?;
    let old = git(root, &["rev-parse", &format!("refs/heads/{base}")])?;
    if !ok(root, &["merge-base", "--is-ancestor", &old, &new]) {
        bail!("{base} moved while rebasing; try again");
    }
    // Move the base branch. If the main checkout has it checked out, merge so
    // its files follow; otherwise just move the ref.
    let current = git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    if current == base {
        git(root, &["merge", "--ff-only", "-q", &r.branch]).context("fast-forwarding the main checkout (uncommitted changes there?)")?;
    } else {
        git(root, &["update-ref", &format!("refs/heads/{base}"), &new, &old])?;
    }
    let n = git(root, &["rev-list", "--count", &format!("{old}..{new}")])?;
    Ok(format!("landed {n} commit{} on {base} (local, not pushed)", if n == "1" { "" } else { "s" }))
}
