//! Pane command protocol + capture helpers.
//!
//! Each agent owns long-lived interactive shells in tmux panes. The `mcp__orc__run` tool runs a
//! command in one such shell by injecting a short `__orc_run <token>` call and reading the framed
//! result (BEGIN/END sentinels + the command's combined output) back from a result file.

/// The BEGIN sentinel prefix.
pub const BEGIN_PREFIX: &str = "<<<ORC-BEGIN ";
/// The BEGIN sentinel suffix.
pub const BEGIN_SUFFIX: &str = ">>>";
/// Marker inserted in the middle of truncated output by [`cap_output`].
pub const TRUNCATION_MARKER: &str = "\n…[output truncated]…\n";

/// The exact BEGIN sentinel line (no newline) for a run id.
pub fn begin_sentinel(run_id: &str) -> String {
    format!("{BEGIN_PREFIX}{run_id}{BEGIN_SUFFIX}")
}

/// A regex matching this run's END sentinel line and capturing its rc: `<<<ORC-END runId rc>>>`.
/// The run id is regex-escaped.
pub fn end_sentinel_re(run_id: &str) -> regex::Regex {
    let esc = regex::escape(run_id);
    regex::Regex::new(&format!(r"<<<ORC-END {esc} (-?\d+)>>>")).unwrap()
}

/// Parse an rc token; non-numeric → -1 sentinel.
pub fn parse_rc(raw: &str) -> i32 {
    raw.trim().parse::<i32>().unwrap_or(-1)
}

/// Find this run's framed output in a capture buffer. Returns the text between the BEGIN and END
/// sentinels (control sequences stripped) plus the parsed rc, or `None` when the END sentinel for
/// this run has not been captured yet. `from_offset` ignores anything before a known starting point.
pub fn parse_captured_run(buf: &str, run_id: &str, from_offset: usize) -> Option<(String, i32)> {
    let hay = if from_offset > 0 && from_offset <= buf.len() {
        &buf[from_offset..]
    } else if from_offset > buf.len() {
        ""
    } else {
        buf
    };
    let begin = begin_sentinel(run_id);
    let b_idx = hay.find(&begin)?;
    let after_begin = b_idx + begin.len();
    let rest = &hay[after_begin..];
    let end_re = end_sentinel_re(run_id);
    let m = end_re.captures(rest)?;
    let whole = m.get(0).unwrap();
    let rc = parse_rc(&m[1]);
    let between = &rest[..whole.start()];
    let stripped = strip_control(between);
    let output = stripped.strip_prefix('\n').unwrap_or(&stripped).to_string();
    let output = output.strip_suffix('\n').unwrap_or(&output).to_string();
    Some((output, rc))
}

/// Cap captured output: under `max` unchanged, over → head + [`TRUNCATION_MARKER`] + tail.
pub fn cap_output(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let keep = max / 2;
    let head: String = chars[..keep].iter().collect();
    let tail: String = chars[chars.len() - keep..].iter().collect();
    format!("{head}{TRUNCATION_MARKER}{tail}")
}

/// Default tail size for [`slice_pane_text`] when neither tail nor since-offset is given.
pub const DEFAULT_TAIL_BYTES: usize = 8192;

/// Slice an agent's pane-log buffer for a reader. Returns `(text, size, next_offset)`.
///
/// When `since_offset` is given, return only the bytes after it (incremental polling); a stale
/// offset past the end yields empty text. Otherwise return the last `tail_bytes` (default 8192).
/// Always reports `next_offset = size`.
pub fn slice_pane_text(
    full: &str,
    tail_bytes: Option<usize>,
    since_offset: Option<usize>,
) -> (String, usize, usize) {
    let size = full.len();
    if let Some(offset) = since_offset {
        let from = offset.min(size);
        return (full[from..].to_string(), size, size);
    }
    let tail = tail_bytes.unwrap_or(DEFAULT_TAIL_BYTES);
    let text = if tail >= size {
        full.to_string()
    } else {
        full[size - tail..].to_string()
    };
    (text, size, size)
}

/// Strip terminal control sequences (CR, ANSI/CSI/OSC escapes) from captured text.
pub fn strip_control(text: &str) -> String {
    use std::sync::OnceLock;
    static CSI: OnceLock<regex::Regex> = OnceLock::new();
    static OSC: OnceLock<regex::Regex> = OnceLock::new();
    let csi = CSI.get_or_init(|| regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());
    let osc = OSC.get_or_init(|| regex::Regex::new("\x1b\\][^\x07]*(?:\x07|\x1b\\\\)").unwrap());
    let s = csi.replace_all(text, "");
    let s = osc.replace_all(&s, "");
    s.replace('\r', "")
}

/// Single-quote a string for safe embedding in a bash command line.
pub fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Build the SHORT line orc types to run one command: `__orc_run '<token>'`.
pub fn encode_injected_call(token: &str) -> String {
    format!("__orc_run {}", shq(token))
}

/// The one-time setup script orc types into a freshly created agent shell.
///
/// Defines the `__orc_run <token>` helper used to inject an agent's commands into its own visible
/// interactive pane: it reads the command from `<token>.cmd`, pushes it into the shell's history
/// (so the human can press ↑ to rerun it), echoes a clean `$ <cmd>` banner, runs it, and frames the
/// combined output + exit code into `<token>.res` for the caller to read back. The shell's own
/// prompt is left untouched so the pane stays a usable interactive terminal between runs.
pub fn build_setup_script(dir: &str) -> String {
    format!(
        "setopt no_prompt_cr no_prompt_sp 2>/dev/null; \
__ORC_DIR={dir}; \
__orc_run() {{ \
local __orc_tok=$1; \
local __orc_cmdf=\"$__ORC_DIR/$__orc_tok.cmd\" __orc_resf=\"$__ORC_DIR/$__orc_tok.res\"; \
local __orc_cmd; __orc_cmd=$(cat \"$__orc_cmdf\"); \
print -s -- \"$__orc_cmd\"; \
printf '\\033[A\\r\\033[K'; \
print -r -- \"$ $__orc_cmd\"; \
print -r -- \"<<<ORC-BEGIN $__orc_tok>>>\" >> \"$__orc_resf\"; \
{{ eval \"$__orc_cmd\" }} 2>&1 | tee -a \"$__orc_resf\"; \
local __orc_rc=${{pipestatus[1]}}; \
print -r -- \"<<<ORC-END $__orc_tok $__orc_rc>>>\" >> \"$__orc_resf\"; \
}}",
        dir = shq(dir)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_sentinel_exact() {
        assert_eq!(begin_sentinel("abc"), "<<<ORC-BEGIN abc>>>");
    }

    #[test]
    fn end_regex_captures_rc() {
        let re = end_sentinel_re("id1");
        let caps = re.captures("...<<<ORC-END id1 7>>>").unwrap();
        assert_eq!(&caps[1], "7");
    }

    #[test]
    fn end_regex_captures_negative_rc() {
        let re = end_sentinel_re("id1");
        let caps = re.captures("... <<<ORC-END id1 -1>>>").unwrap();
        assert_eq!(&caps[1], "-1");
    }

    #[test]
    fn end_regex_wrong_id_no_match() {
        let re = end_sentinel_re("id1");
        assert!(re.captures("<<<ORC-END id2 0>>>").is_none());
    }

    #[test]
    fn parse_rc_values() {
        assert_eq!(parse_rc("0"), 0);
        assert_eq!(parse_rc("130\n"), 130);
        assert_eq!(parse_rc("abc"), -1);
    }

    #[test]
    fn parse_captured_run_basic() {
        let buf = "<<<ORC-BEGIN id1>>>\nhi\n<<<ORC-END id1 0>>>";
        assert_eq!(
            parse_captured_run(buf, "id1", 0),
            Some(("hi".to_string(), 0))
        );
    }

    #[test]
    fn parse_captured_run_missing_end_is_none() {
        let buf = "<<<ORC-BEGIN id1>>>\nhi\n";
        assert_eq!(parse_captured_run(buf, "id1", 0), None);
    }

    #[test]
    fn parse_captured_run_ignores_leading_noise() {
        let buf = "garbage before\n<<<ORC-BEGIN id1>>>\nhi\n<<<ORC-END id1 0>>>";
        assert_eq!(
            parse_captured_run(buf, "id1", 0),
            Some(("hi".to_string(), 0))
        );
    }

    #[test]
    fn parse_captured_run_from_offset_skips_first_frame() {
        let first = "<<<ORC-BEGIN id1>>>\nfirst\n<<<ORC-END id1 0>>>";
        let buf = format!("{first}\n<<<ORC-BEGIN id1>>>\nsecond\n<<<ORC-END id1 0>>>");
        let off = first.len();
        assert_eq!(
            parse_captured_run(&buf, "id1", off),
            Some(("second".to_string(), 0))
        );
    }

    #[test]
    fn parse_captured_run_strips_ansi() {
        let buf = "<<<ORC-BEGIN id1>>>\n\x1b[31mred\x1b[0m\n<<<ORC-END id1 0>>>";
        assert_eq!(
            parse_captured_run(buf, "id1", 0),
            Some(("red".to_string(), 0))
        );
    }

    #[test]
    fn cap_output_under_max_unchanged() {
        assert_eq!(cap_output("hello", 32768), "hello");
    }

    #[test]
    fn cap_output_empty() {
        assert_eq!(cap_output("", 32768), "");
    }

    #[test]
    fn cap_output_over_max_truncated() {
        let max = 100;
        let input = "x".repeat(500);
        let out = cap_output(&input, max);
        assert!(out.contains("…[output truncated]…"));
        assert!(out.len() <= max + TRUNCATION_MARKER.len());
    }

    #[test]
    fn slice_pane_text_tail() {
        let (text, size, next) = slice_pane_text("0123456789", Some(4), None);
        assert_eq!(text, "6789");
        assert_eq!(size, 10);
        assert_eq!(next, 10);
    }

    #[test]
    fn slice_pane_text_since_offset() {
        let (text, _size, next) = slice_pane_text("0123456789", None, Some(7));
        assert_eq!(text, "789");
        assert_eq!(next, 10);
    }

    #[test]
    fn slice_pane_text_stale_offset_empty() {
        let (text, _size, next) = slice_pane_text("0123456789", None, Some(999));
        assert_eq!(text, "");
        assert_eq!(next, 10);
    }

    #[test]
    fn encode_injected_call_quotes_token() {
        assert_eq!(encode_injected_call("abc123"), "__orc_run 'abc123'");
    }

    #[test]
    fn shq_escapes_single_quote() {
        // Rust raw-ish: expected is the 9-char string  'it'\''s'
        assert_eq!(shq("it's"), r#"'it'\''s'"#);
    }

    #[test]
    fn build_setup_script_contains_dir_and_plumbing() {
        let s = build_setup_script("/run/dir");
        assert!(s.contains("'/run/dir'"), "dir single-quoted: {s}");
        assert!(s.contains("print -s --"), "pushes command into history for rerun");
        assert!(s.contains("__orc_run"), "defines __orc_run");
        assert!(s.contains("<<<ORC-BEGIN"), "writes BEGIN sentinel");
        assert!(s.contains("<<<ORC-END"), "writes END sentinel");
        assert!(s.contains("${pipestatus[1]}"), "uses pipestatus[1]");
    }

    #[test]
    fn build_setup_script_escapes_quoted_dir() {
        let s = build_setup_script("/it's/dir");
        assert!(s.contains(r#"'/it'\''s/dir'"#), "escaped dir: {s}");
    }
}
