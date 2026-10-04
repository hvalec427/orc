//! The tmux controller: each agent owns a long-lived interactive shell in its own detached tmux
//! window; selecting an agent breaks the previous occupant back to its window and joins the
//! selected agent's shell beside orc's TUI pane (focus stays on the TUI). See `PLAN.md`.

use crate::tmux::pane_run::{build_setup_script, cap_output, encode_injected_call, parse_captured_run, shq};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const SESSION_NAME: &str = "orc";

/// How orc should drive tmux.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Disabled / non-TTY / no binary → plain TUI, no tmux.
    Off,
    /// Launch our own tmux session and re-exec into it.
    Bootstrap,
    /// Already inside a tmux client — adopt the current window.
    Inside,
}

/// A filesystem/window-safe slug for an agent id.
pub fn pane_slug(id: &str) -> String {
    id.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect()
}

/// The tmux window name hosting an agent's shell.
pub fn agent_window_name(id: &str) -> String {
    format!("orc-agent-{}", pane_slug(id))
}

/// Decide how orc should drive tmux.
pub fn detect_mode(disabled: bool, is_tty: bool, binary_available: bool, in_tmux: bool, is_child: bool) -> Mode {
    if disabled || !is_tty || !binary_available {
        return Mode::Off;
    }
    if in_tmux || is_child {
        return Mode::Inside;
    }
    Mode::Bootstrap
}

/// Build the argv that re-execs orc inside the bootstrapped tmux session (with the child guard).
pub fn build_reexec_argv(exe: &str, user_args: &[String]) -> Vec<String> {
    let mut argv = vec![exe.to_string()];
    for a in user_args {
        if a != "--tmux-child" {
            argv.push(a.clone());
        }
    }
    argv.push("--tmux-child".to_string());
    argv
}

// --- argv builders (pure; unit-tested) ---------------------------------------------------------

pub fn argv_pipe_pane(pane: &str, cmd: &str) -> Vec<String> {
    vec!["pipe-pane".into(), "-o".into(), "-t".into(), pane.into(), cmd.into()]
}
pub fn argv_send_interrupt(pane: &str) -> Vec<String> {
    vec!["send-keys".into(), "-t".into(), pane.into(), "C-c".into()]
}
pub fn argv_send_keys_literal(pane: &str, text: &str) -> Vec<String> {
    vec!["send-keys".into(), "-t".into(), pane.into(), "-l".into(), text.into()]
}
pub fn argv_send_keys_enter(pane: &str) -> Vec<String> {
    vec!["send-keys".into(), "-t".into(), pane.into(), "Enter".into()]
}
pub fn argv_clear_history(pane: &str) -> Vec<String> {
    vec!["clear-history".into(), "-t".into(), pane.into()]
}
pub fn argv_has_session(name: &str) -> Vec<String> {
    vec!["has-session".into(), "-t".into(), name.into()]
}
pub fn argv_kill_session(name: &str) -> Vec<String> {
    vec!["kill-session".into(), "-t".into(), name.into()]
}
pub fn argv_new_session(name: &str, reexec: &[String]) -> Vec<String> {
    let mut v = vec!["new-session".into(), "-d".into(), "-s".into(), name.into()];
    v.extend(reexec.iter().cloned());
    v
}
pub fn argv_new_window(session: &str, name: &str, cwd: &str, cmd: &str) -> Vec<String> {
    vec![
        "new-window".into(), "-d".into(), "-P".into(), "-F".into(), "#{pane_id}".into(),
        "-t".into(), session.into(), "-n".into(), name.into(), "-c".into(), cwd.into(), cmd.into(),
    ]
}
pub fn argv_break_pane_named(pane: &str, window: &str) -> Vec<String> {
    vec!["break-pane".into(), "-d".into(), "-s".into(), pane.into(), "-n".into(), window.into()]
}
pub fn argv_join_pane(src: &str, dst: &str) -> Vec<String> {
    vec!["join-pane".into(), "-h".into(), "-s".into(), src.into(), "-t".into(), dst.into()]
}
pub fn argv_status_off(name: &str) -> Vec<String> {
    vec!["set".into(), "-t".into(), name.into(), "status".into(), "off".into()]
}
pub fn argv_list_panes(target: &str) -> Vec<String> {
    vec!["list-panes".into(), "-t".into(), target.into(), "-F".into(), "#{pane_id} #{pane_index}".into()]
}
pub fn argv_kill_window(target: &str) -> Vec<String> {
    vec!["kill-window".into(), "-t".into(), target.into()]
}
pub fn argv_select_pane(target: &str) -> Vec<String> {
    vec!["select-pane".into(), "-t".into(), target.into()]
}
pub fn argv_display_message(format: &str, target: Option<&str>) -> Vec<String> {
    match target {
        Some(t) => vec!["display-message".into(), "-p".into(), "-t".into(), t.into(), format.into()],
        None => vec!["display-message".into(), "-p".into(), format.into()],
    }
}

/// Parse `list-panes -F '#{pane_id} #{pane_index}'` output into `(pane_id, index)` rows.
pub fn parse_panes(stdout: &str) -> Vec<(String, u32)> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pane = it.next()?.to_string();
            let idx = it.next()?.parse().ok()?;
            Some((pane, idx))
        })
        .collect()
}

// --- Controller --------------------------------------------------------------------------------

/// Runs a tmux subcommand (argv after the `tmux` binary), yielding stdout.
pub type Runner = Box<dyn Fn(&[String]) -> anyhow::Result<String> + Send>;

struct AgentWindow {
    window: String,
    pane_id: String,
    capture_path: String,
}

/// Drives per-agent tmux shells and the shared stage pane beside the TUI.
pub struct TmuxController {
    run: Runner,
    logs_dir: PathBuf,
    session_name: String,
    owns_session: bool,
    orc_pane_id: Option<String>,
    agents: HashMap<String, AgentWindow>,
    stage_occupant: Option<String>,
    selected: Option<String>,
    run_counter: u64,
}

/// The default runner: shells out to the real `tmux` binary.
fn real_tmux(args: &[String]) -> anyhow::Result<String> {
    let out = std::process::Command::new("tmux").args(args).output()?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

impl TmuxController {
    pub fn new() -> Self {
        let logs_dir = dirs::home_dir().unwrap_or_default().join(".orc").join("panes");
        Self::with(Box::new(real_tmux), logs_dir)
    }

    #[cfg(test)]
    fn new_test(session_name: &str, logs_dir: PathBuf) -> Self {
        let mut c = Self::with(Box::new(real_tmux), logs_dir);
        c.session_name = session_name.to_string();
        c
    }

    pub fn with(run: Runner, logs_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&logs_dir);
        Self {
            run,
            logs_dir,
            session_name: SESSION_NAME.to_string(),
            owns_session: false,
            orc_pane_id: None,
            agents: HashMap::new(),
            stage_occupant: None,
            selected: None,
            run_counter: 0,
        }
    }

    /// Is tmux present and new enough (>=1.9)?
    pub fn is_available() -> bool {
        let Ok(out) = std::process::Command::new("tmux").arg("-V").output() else {
            return false;
        };
        if !out.status.success() {
            return false;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        if let Some(caps) = regex::Regex::new(r"(\d+)\.(\d+)").unwrap().captures(&s) {
            let major: u32 = caps[1].parse().unwrap_or(0);
            let minor: u32 = caps[2].parse().unwrap_or(0);
            major > 1 || (major == 1 && minor >= 9)
        } else {
            false
        }
    }

    fn capture_path(&self, id: &str) -> String {
        self.logs_dir
            .join(format!("{}.cap", pane_slug(id)))
            .to_string_lossy()
            .into_owned()
    }

    fn tmux(&self, args: Vec<String>) -> anyhow::Result<String> {
        (self.run)(&args)
    }

    fn tmux_ok(&self, args: Vec<String>) {
        let _ = (self.run)(&args);
    }

    /// Provision an agent's long-lived interactive shell in a detached window in its worktree.
    pub fn register_agent(&mut self, id: &str, cwd: &str) {
        let capture = self.capture_path(id);
        let _ = std::fs::write(&capture, "");
        let window = agent_window_name(id);
        let pane_id = match self.tmux(argv_new_window(&self.session_name, &window, cwd, "exec zsh -if")) {
            Ok(out) => out.trim().to_string(),
            Err(_) => return, // best-effort: no window → no pane for this agent
        };
        if pane_id.is_empty() {
            return;
        }
        self.tmux_ok(argv_pipe_pane(&pane_id, &format!("cat >> {}", shq(&capture))));
        self.install_setup(&pane_id);
        self.agents.insert(
            id.to_string(),
            AgentWindow { window, pane_id, capture_path: capture },
        );
        if self.selected.as_deref() == Some(id) {
            self.show_agent(Some(id));
        }
    }

    fn install_setup(&self, pane_id: &str) {
        let dir = self.logs_dir.to_string_lossy().into_owned();
        self.tmux_ok(argv_send_keys_literal(pane_id, &build_setup_script(&dir)));
        self.tmux_ok(argv_send_keys_enter(pane_id));
        self.tmux_ok(argv_send_keys_literal(pane_id, "clear"));
        self.tmux_ok(argv_send_keys_enter(pane_id));
        self.tmux_ok(argv_clear_history(pane_id));
    }

    /// Kill an agent's shell window and remove its capture file.
    pub fn unregister_agent(&mut self, id: &str) {
        if let Some(entry) = self.agents.remove(id) {
            if self.stage_occupant.as_deref() == Some(id) {
                self.stage_occupant = None;
            }
            self.tmux_ok(argv_kill_window(&entry.window));
            let _ = std::fs::remove_file(&entry.capture_path);
        } else {
            let _ = std::fs::remove_file(self.capture_path(id));
        }
    }

    /// Reveal the selected agent's shell beside the TUI (focus stays on orc). No-op until orc's
    /// pane is known or the agent has no shell yet.
    pub fn show_agent(&mut self, id: Option<&str>) {
        self.selected = id.map(str::to_string);
        let (Some(orc_pane), Some(id)) = (self.orc_pane_id.clone(), id) else {
            return;
        };
        if !self.agents.contains_key(id) {
            return; // shell not created yet; register_agent re-calls show_agent once it exists
        }
        if self.stage_occupant.as_deref() == Some(id) {
            self.tmux_ok(argv_select_pane(&orc_pane));
            return;
        }
        // Break the previous occupant back to its own window (preserved, not killed).
        if let Some(prev_id) = self.stage_occupant.take() {
            if let Some(prev) = self.agents.get(&prev_id) {
                self.tmux_ok(argv_break_pane_named(&prev.pane_id, &prev.window));
            }
        }
        let pane_id = self.agents.get(id).map(|a| a.pane_id.clone());
        if let Some(pane_id) = pane_id {
            self.tmux_ok(argv_join_pane(&pane_id, &orc_pane));
            self.stage_occupant = Some(id.to_string());
            // join-pane focuses the joined pane; pull focus back to the TUI.
            self.tmux_ok(argv_select_pane(&orc_pane));
        }
    }

    fn next_run_token(&mut self) -> String {
        let seq = self.run_counter;
        self.run_counter += 1;
        format!("r{}{}", seq, uuid::Uuid::new_v4().simple().to_string()[..6].to_string())
    }

    /// Run a command live in the selected agent's shell, returning `(output, rc)`, or `None` when it
    /// can't be driven in-pane (agent not selected / not staged / no shell) so the caller falls back.
    pub fn run_in_pane(&mut self, id: &str, cmd: &str, timeout: Duration) -> Option<(String, i32)> {
        if self.selected.as_deref() != Some(id) || self.stage_occupant.as_deref() != Some(id) {
            return None;
        }
        let pane_id = self.agents.get(id)?.pane_id.clone();
        let token = self.next_run_token();
        let cmd_path = self.logs_dir.join(format!("{token}.cmd"));
        let res_path = self.logs_dir.join(format!("{token}.res"));
        if std::fs::write(&cmd_path, cmd).is_err() || std::fs::write(&res_path, "").is_err() {
            return None;
        }
        self.tmux_ok(argv_send_keys_literal(&pane_id, &encode_injected_call(&token)));
        self.tmux_ok(argv_send_keys_enter(&pane_id));

        let deadline = Instant::now() + timeout;
        let result = loop {
            if let Ok(buf) = std::fs::read_to_string(&res_path) {
                if let Some((out, rc)) = parse_captured_run(&buf, &token, 0) {
                    break Some((cap_output(&out, 32768), rc));
                }
            }
            if Instant::now() >= deadline {
                self.tmux_ok(argv_send_interrupt(&pane_id));
                break Some((String::new(), 130));
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let _ = std::fs::remove_file(&cmd_path);
        let _ = std::fs::remove_file(&res_path);
        result
    }

    /// BOOTSTRAP: create our own tmux session running the re-exec child as its only pane, hide the
    /// status bar, and attach (replacing this process). Never returns on success.
    pub fn bootstrap_and_reexec(reexec_argv: &[String]) -> anyhow::Result<()> {
        use std::os::unix::process::CommandExt;
        let _ = real_tmux(&argv_kill_session(SESSION_NAME)); // kill any stale session (ignore errors)
        real_tmux(&argv_new_session(SESSION_NAME, reexec_argv))?;
        let _ = real_tmux(&argv_status_off(SESSION_NAME));
        // Replace this process with `tmux attach` so the human sees the session.
        let err = std::process::Command::new("tmux")
            .args(["attach-session", "-t", SESSION_NAME])
            .exec();
        anyhow::bail!("failed to attach tmux session: {err}")
    }

    /// BOOTSTRAP-CHILD: discover orc's own TUI pane (window 0 of the session we created).
    pub fn adopt(&mut self) {
        self.owns_session = true;
        let target = format!("{}:0", self.session_name);
        if let Ok(out) = self.tmux(argv_list_panes(&target)) {
            if let Some((pane, _)) = parse_panes(&out).into_iter().find(|(_, idx)| *idx == 0) {
                self.orc_pane_id = Some(pane);
            }
        }
    }

    /// TRUE INSIDE: orc launched inside the user's own tmux. Adopt the current pane as the stage
    /// anchor and learn the real session name. Never kills the user's session on shutdown.
    pub fn adopt_inside(&mut self, current_pane: Option<String>) {
        let orc_pane = current_pane
            .or_else(|| std::env::var("TMUX_PANE").ok())
            .or_else(|| self.tmux(argv_display_message("#{pane_id}", None)).ok().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty());
        let Some(orc_pane) = orc_pane else {
            return;
        };
        if let Ok(session) = self.tmux(argv_display_message("#{session_name}", Some(&orc_pane))) {
            let session = session.trim();
            if !session.is_empty() {
                self.session_name = session.to_string();
            }
        }
        self.orc_pane_id = Some(orc_pane);
    }

    /// Tear down what we own: the whole session when we bootstrapped, else just our agent windows.
    pub fn shutdown(&mut self) {
        let ids: Vec<String> = self.agents.keys().cloned().collect();
        for id in ids {
            self.unregister_agent(&id);
        }
        if self.owns_session {
            self.tmux_ok(argv_kill_session(&self.session_name));
        }
    }
}

impl Default for TmuxController {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_mode_matrix() {
        assert_eq!(detect_mode(true, true, true, false, false), Mode::Off);
        assert_eq!(detect_mode(false, false, true, false, false), Mode::Off);
        assert_eq!(detect_mode(false, true, false, false, false), Mode::Off);
        assert_eq!(detect_mode(false, true, true, true, false), Mode::Inside);
        assert_eq!(detect_mode(false, true, true, false, true), Mode::Inside);
        assert_eq!(detect_mode(false, true, true, false, false), Mode::Bootstrap);
    }

    #[test]
    fn reexec_argv_appends_child_guard_once() {
        let argv = build_reexec_argv("/bin/orc", &["--model".into(), "x".into(), "--tmux-child".into()]);
        assert_eq!(argv, vec!["/bin/orc", "--model", "x", "--tmux-child"]);
        assert_eq!(argv.iter().filter(|a| *a == "--tmux-child").count(), 1);
    }

    #[test]
    fn pane_slug_folds_unsafe_chars() {
        assert_eq!(pane_slug("Ab/C 1"), "ab-c-1");
    }

    #[test]
    fn argv_shapes() {
        assert_eq!(
            argv_new_window("orc", "w", "/cwd", "exec zsh -if"),
            vec!["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "orc", "-n", "w", "-c", "/cwd", "exec zsh -if"]
        );
        assert_eq!(argv_join_pane("%1", "%2"), vec!["join-pane", "-h", "-s", "%1", "-t", "%2"]);
        assert_eq!(argv_break_pane_named("%1", "w"), vec!["break-pane", "-d", "-s", "%1", "-n", "w"]);
    }

    #[test]
    fn parse_panes_rows() {
        let out = "%0 0\n%3 1\n";
        assert_eq!(parse_panes(out), vec![("%0".to_string(), 0), ("%3".to_string(), 1)]);
    }

    /// End-to-end against REAL tmux (headless): register an agent shell, stage it, run a command in
    /// it, and read the framed result back. Skips cleanly if tmux isn't available.
    #[test]
    fn tmux_round_trip_real() {
        if !TmuxController::is_available() {
            eprintln!("tmux not available; skipping");
            return;
        }
        let sess = format!("orctest-{}", std::process::id());
        let logs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();

        let _ = real_tmux(&argv_kill_session(&sess));
        real_tmux(&argv_new_session(&sess, &[])).expect("new-session");

        let mut c = TmuxController::new_test(&sess, logs.path().to_path_buf());
        c.adopt(); // discovers the session's window-0 pane as the orc anchor
        assert!(c.orc_pane_id.is_some(), "adopt found no orc pane");

        c.register_agent("a1", &cwd.path().to_string_lossy());
        assert!(c.agents.contains_key("a1"), "agent window not registered");
        c.show_agent(Some("a1"));
        assert_eq!(c.stage_occupant.as_deref(), Some("a1"));

        let res = c.run_in_pane("a1", "echo hello-from-pane", Duration::from_secs(15));
        c.shutdown();
        let _ = real_tmux(&argv_kill_session(&sess));

        let (out, rc) = res.expect("run_in_pane returned None");
        assert_eq!(rc, 0, "command rc (output was {out:?})");
        assert!(out.contains("hello-from-pane"), "unexpected output: {out:?}");
    }
}
