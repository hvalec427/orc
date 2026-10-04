//! Git worktree + branch helpers for agents.

/// Turn an agent name into a filesystem/branch-safe slug.
///
/// Lowercase, trim, collapse runs of non `[a-z0-9]` into `-`, strip leading/trailing `-`, truncate
/// to 40 chars, and fall back to `"agent"` when empty.
pub fn slugify(name: &str) -> String {
    let re = regex::Regex::new(r"[^a-z0-9]+").unwrap();
    let lowered = name.to_lowercase();
    let trimmed = lowered.trim();
    let collapsed = re.replace_all(trimmed, "-");
    let stripped = collapsed.trim_matches('-');
    let truncated: String = stripped.chars().take(40).collect();
    if truncated.is_empty() {
        "agent".to_string()
    } else {
        truncated
    }
}

/// The branch name for a slug: `agent/{slug}`.
pub fn branch_for(slug: &str) -> String {
    format!("agent/{slug}")
}

/// The worktree path for a slug: `<repo>/<worktree_dir>/<slug>`.
pub fn worktree_path(repo: &str, worktree_dir: &str, slug: &str) -> String {
    std::path::Path::new(repo)
        .join(worktree_dir)
        .join(slug)
        .to_string_lossy()
        .into_owned()
}

/// `git -C <repo> worktree add <path> -b <branch>` argv.
pub fn git_worktree_add_argv(repo: &str, path: &str, branch: &str) -> Vec<String> {
    vec![
        "-C".into(),
        repo.into(),
        "worktree".into(),
        "add".into(),
        path.into(),
        "-b".into(),
        branch.into(),
    ]
}

/// `git -C <repo> worktree remove <path> --force` argv.
pub fn git_worktree_remove_argv(repo: &str, path: &str) -> Vec<String> {
    vec![
        "-C".into(),
        repo.into(),
        "worktree".into(),
        "remove".into(),
        path.into(),
        "--force".into(),
    ]
}

/// `git -C <repo> rev-parse --is-inside-work-tree` argv.
pub fn git_is_inside_work_tree_argv(repo: &str) -> Vec<String> {
    vec![
        "-C".into(),
        repo.into(),
        "rev-parse".into(),
        "--is-inside-work-tree".into(),
    ]
}

/// `git -C <repo> branch --list <branch>` argv.
pub fn git_branch_list_argv(repo: &str, branch: &str) -> Vec<String> {
    vec![
        "-C".into(),
        repo.into(),
        "branch".into(),
        "--list".into(),
        branch.into(),
    ]
}

/// Verify the path is the top level of a git working tree.
///
/// Errors contain `<repo> is not a git repository`.
pub fn assert_git_repo(repo: &str) -> anyhow::Result<()> {
    let output = std::process::Command::new("git")
        .args(git_is_inside_work_tree_argv(repo))
        .output();
    let ok = matches!(output, Ok(ref o) if o.status.success());
    if ok {
        Ok(())
    } else {
        anyhow::bail!("{repo} is not a git repository (run 'git init' there first).")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("My Agent"), "my-agent");
    }

    #[test]
    fn slugify_trims_and_collapses() {
        assert_eq!(slugify("  X--Y  "), "x-y");
    }

    #[test]
    fn slugify_empty_falls_back() {
        assert_eq!(slugify(""), "agent");
    }

    #[test]
    fn slugify_truncates_to_40() {
        let input: String = "a".repeat(50);
        assert_eq!(slugify(&input), "a".repeat(40));
    }

    #[test]
    fn slugify_punctuation() {
        assert_eq!(slugify("Feature: Add Login!"), "feature-add-login");
    }

    #[test]
    fn branch_for_prefixes() {
        assert_eq!(branch_for("foo"), "agent/foo");
    }

    #[test]
    fn worktree_path_joins() {
        assert_eq!(
            worktree_path("/repo", ".worktrees", "foo"),
            "/repo/.worktrees/foo"
        );
    }

    #[test]
    fn worktree_add_argv_exact() {
        assert_eq!(
            git_worktree_add_argv("/repo", "/repo/.worktrees/foo", "agent/foo"),
            vec![
                "-C",
                "/repo",
                "worktree",
                "add",
                "/repo/.worktrees/foo",
                "-b",
                "agent/foo"
            ]
        );
    }

    #[test]
    fn worktree_remove_argv_exact() {
        assert_eq!(
            git_worktree_remove_argv("/repo", "/repo/.worktrees/foo"),
            vec![
                "-C",
                "/repo",
                "worktree",
                "remove",
                "/repo/.worktrees/foo",
                "--force"
            ]
        );
    }

    #[test]
    fn is_inside_work_tree_argv_exact() {
        assert_eq!(
            git_is_inside_work_tree_argv("/repo"),
            vec!["-C", "/repo", "rev-parse", "--is-inside-work-tree"]
        );
    }

    #[test]
    fn branch_list_argv_exact() {
        assert_eq!(
            git_branch_list_argv("/repo", "agent/foo"),
            vec!["-C", "/repo", "branch", "--list", "agent/foo"]
        );
    }
}
