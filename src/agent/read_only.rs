//! Classify a shell command as read-only (pure investigation) or not.
//!
//! Shared by the read-only-agent permission guard and the `mcp__orc__run` pane tool. Conservative by
//! design — when in doubt it returns false so the agent is told to delegate.

/// Whether a Bash command is safe for a read-only agent: pure investigation, no state changes.
///
/// Rejects output redirection (`>`/`>>`), command substitution (`$(…)`/backticks), process
/// substitution, here-strings, and backgrounding, then requires every simple command (across pipes
/// and `&&`/`||`/`;`) to be a known read-only binary. `git` is allowed only for read-only
/// subcommands; `npm`/`yarn`/etc. only for their read-only subcommands.
pub fn is_read_only_bash_command(raw: &str) -> bool {
    let cmd = raw.trim();
    if cmd.is_empty() {
        return false;
    }

    // Command substitution can smuggle in an arbitrary writer; reject outright.
    if cmd.contains("$(") || cmd.contains('`') {
        return false;
    }
    // Any output redirection or file-descriptor write is a mutation (`2>&1` is fine; `>`/`>>` not).
    if re_redirection().is_match(cmd) {
        return false;
    }
    // Process substitution and here-strings can smuggle in writes.
    if cmd.contains("<(") || cmd.contains(">(") || cmd.contains("<<<") {
        return false;
    }
    // Backgrounding would leave a process running past the turn.
    if re_background().is_match(cmd) {
        return false;
    }

    // Split into simple commands across pipes and sequencing operators.
    let segments: Vec<&str> = re_segments()
        .split(cmd)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if segments.is_empty() {
        return false;
    }

    segments.iter().all(|s| is_read_only_simple_command(s))
}

use std::sync::OnceLock;

fn re_redirection() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(^|[^0-9&])>>?").unwrap())
}

fn re_background() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(^|[^&])&\s*$").unwrap())
}

fn re_segments() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    // Split on `||`, `&&`, or a single `;` or `|`.
    RE.get_or_init(|| regex::Regex::new(r"\|\||&&|[;|]").unwrap())
}

fn re_env_prefix() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*").unwrap())
}

/// Classify one simple command (already split off its pipeline) as read-only or not.
fn is_read_only_simple_command(segment: &str) -> bool {
    // Strip leading VAR=val environment assignments.
    let rest = re_env_prefix().replace(segment, "");
    let rest = rest.trim();
    if rest.is_empty() {
        return false;
    }

    let tokens: Vec<&str> = rest.split_whitespace().collect();
    let name = tokens[0].rsplit('/').next().unwrap_or(tokens[0]);
    let args: Vec<&str> = tokens[1..].to_vec();

    match name {
        "git" => is_read_only_git(&args),
        "sed" => args.contains(&"-n") && !args.iter().any(|a| *a == "-i" || a.starts_with("-i")),
        "awk" => true,
        "npm" | "pnpm" | "yarn" => is_read_only_package_script(&args),
        "npx" => !args
            .iter()
            .any(|a| matches!(*a, "i" | "install" | "add" | "create" | "init")),
        "node" => {
            args.is_empty()
                || args.iter().any(|a| {
                    matches!(
                        *a,
                        "-v" | "--version" | "-e" | "--eval" | "-p" | "--print" | "--help" | "-h"
                    )
                })
        }
        "python" | "python3" => {
            args.is_empty()
                || args
                    .iter()
                    .any(|a| matches!(*a, "-V" | "--version" | "-c" | "-m" | "--help" | "-h"))
        }
        "pip" => {
            args.first() == Some(&"list")
                || args.first() == Some(&"show")
                || args.first() == Some(&"freeze")
                || args.contains(&"--version")
        }
        "cargo" => {
            let sub = args.first().copied().unwrap_or("");
            [
                "check",
                "test",
                "tree",
                "metadata",
                "fmt",
                "clippy",
                "--version",
            ]
            .contains(&sub)
        }
        "go" => {
            let sub = args.first().copied().unwrap_or("");
            ["test", "vet", "list", "version", "env", "doc"].contains(&sub)
        }
        "make" => args
            .iter()
            .any(|a| matches!(*a, "-n" | "--dry-run" | "-p" | "--print-data-base")),
        _ => READONLY_BASH_COMMANDS.contains(&name),
    }
}

/// Read-only binaries a read-only agent may run.
const READONLY_BASH_COMMANDS: &[&str] = &[
    // Filesystem inspection
    "ls", "cat", "head", "tail", "wc", "file", "stat", "du", "tree", "pwd", "realpath", "basename",
    "dirname", "readlink", // Search
    "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "locate",
    // Text viewing / transforms that don't write
    "echo", "printf", "sort", "uniq", "cut", "tr", "column", "diff", "comm", "nl", "tee", "xargs",
    "date", "env", "whoami", "hostname", "uname", "which", "type", "command", "true", "false",
    "jq", "yq",
    // Package/tooling introspection (read-only subcommands only; see per-command checks)
    "node", "npm", "npx", "pnpm", "yarn", "python", "python3", "pip", "cargo", "go", "make",
];

/// git subcommands that only read repository state.
const READONLY_GIT_SUBCOMMANDS: &[&str] = &[
    "log",
    "diff",
    "show",
    "status",
    "blame",
    "ls-files",
    "ls-tree",
    "cat-file",
    "rev-parse",
    "rev-list",
    "branch",
    "tag",
    "describe",
    "shortlog",
    "reflog",
    "grep",
    "whatchanged",
    "remote",
    "config",
    "show-ref",
    "symbolic-ref",
    "merge-base",
    "name-rev",
    "for-each-ref",
    "count-objects",
];

fn is_read_only_git(args: &[&str]) -> bool {
    // Skip leading global flags like `-C <path>`, `--no-pager`, `-c key=val`.
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        if args[i] == "-C" || args[i] == "-c" {
            i += 2;
        } else {
            i += 1;
        }
    }
    let sub = match args.get(i) {
        Some(s) => *s,
        None => return true, // bare `git` / `git --version`
    };
    if sub == "config" {
        let after: Vec<&str> = args[i + 1..]
            .iter()
            .copied()
            .filter(|a| !a.starts_with('-'))
            .collect();
        return after.len() <= 1
            || args[i + 1..]
                .iter()
                .any(|a| *a == "--get" || *a == "--list" || *a == "-l");
    }
    if sub == "branch" || sub == "tag" {
        let tail = &args[i + 1..];
        let no_mutate = !tail.iter().any(|a| re_branch_mutate().is_match(a));
        let no_positional = tail.iter().filter(|a| !a.starts_with('-')).count() == 0;
        return no_mutate && no_positional;
    }
    if sub == "remote" {
        let next = args.get(i + 1).copied().unwrap_or("");
        return ["", "-v", "show", "get-url"].contains(&next);
    }
    READONLY_GIT_SUBCOMMANDS.contains(&sub)
}

fn re_branch_mutate() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^-(d|D|m|M|f)$").unwrap())
}

/// npm/pnpm/yarn invocations that run read-only scripts or inspect, never install.
fn is_read_only_package_script(args: &[&str]) -> bool {
    let sub = args.first().copied().unwrap_or("");
    if re_pkg_mutate().is_match(sub) {
        return false;
    }
    if matches!(sub, "ls" | "list" | "outdated" | "why" | "view" | "info") {
        return true;
    }
    if sub == "--version" || sub == "-v" {
        return true;
    }
    let script = if sub == "run" || sub == "run-script" {
        args.get(1).copied().unwrap_or("")
    } else {
        sub
    };
    re_readonly_script().is_match(script)
}

fn re_pkg_mutate() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"^(install|i|add|remove|rm|uninstall|update|up|ci|link|unlink|publish|exec|dlx|create|init)$",
        )
        .unwrap()
    })
}

fn re_readonly_script() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"^(test|tests|lint|typecheck|type-check|tsc|check|coverage)$").unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_status_is_read_only() {
        assert!(is_read_only_bash_command("git status"));
    }

    #[test]
    fn ls_is_read_only() {
        assert!(is_read_only_bash_command("ls -la"));
    }

    #[test]
    fn rm_is_not_read_only() {
        assert!(!is_read_only_bash_command("rm -rf x"));
    }

    #[test]
    fn git_commit_is_not_read_only() {
        assert!(!is_read_only_bash_command("git commit -m x"));
    }

    #[test]
    fn redirection_is_not_read_only() {
        assert!(!is_read_only_bash_command("echo hi > f"));
    }
}
