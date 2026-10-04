//! The real [`ClaudeDriver`]: spawns a `claude` CLI subprocess in streaming mode and pumps its
//! stream-json stdout into [`DriverEvent`]s, while forwarding queued input onto its stdin.

use crate::agent::driver::{ClaudeDriver, DriverEvent, DriverHandle, SessionOpts};
use crate::agent::stream::parse_stream_line;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Spawns real `claude` sessions. `binary` defaults to `"claude"` on the `PATH`.
pub struct CliDriver {
    pub binary: String,
}

impl Default for CliDriver {
    fn default() -> Self {
        Self {
            binary: "claude".to_string(),
        }
    }
}

impl CliDriver {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
        }
    }
}

/// Encode one human/agent input line as a stream-json user message.
fn encode_user_message(text: &str) -> String {
    let v = json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    });
    v.to_string()
}

#[async_trait::async_trait]
impl ClaudeDriver for CliDriver {
    async fn start(&self, opts: SessionOpts) -> anyhow::Result<DriverHandle> {
        let mut cmd = Command::new(&self.binary);
        cmd.arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--verbose");

        if !opts.model.is_empty() {
            cmd.arg("--model").arg(&opts.model);
        }
        if let Some(cwd) = &opts.cwd {
            cmd.current_dir(cwd);
            cmd.arg("--add-dir").arg(cwd);
        }
        if let Some(sp) = &opts.system_prompt {
            cmd.arg("--append-system-prompt").arg(sp);
        }
        match opts.permission_mode.as_deref() {
            Some("bypassPermissions") => {
                cmd.arg("--dangerously-skip-permissions");
            }
            Some("acceptEdits") => {
                cmd.arg("--permission-mode").arg("acceptEdits");
            }
            _ => {}
        }
        if let Some(resume) = &opts.resume_session_id {
            cmd.arg("--resume").arg(resume);
        }
        if let Some(mcp) = &opts.mcp_config {
            cmd.arg("--mcp-config").arg(mcp);
        }
        if !opts.disallowed_tools.is_empty() {
            cmd.arg("--disallowedTools").arg(opts.disallowed_tools.join(","));
        }
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }

        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn `{}`: {e}", self.binary))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("child has no stdout"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("child has no stdin"))?;
        let stderr = child.stderr.take();

        let (event_tx, event_rx) = mpsc::channel::<DriverEvent>(256);
        let (input_tx, mut input_rx) = mpsc::channel::<String>(64);
        let cancel = CancellationToken::new();

        // stdout → DriverEvents
        let stdout_cancel = cancel.clone();
        let evt_for_stdout = event_tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                tokio::select! {
                    _ = stdout_cancel.cancelled() => break,
                    line = reader.next_line() => match line {
                        Ok(Some(line)) => {
                            for evt in parse_stream_line(&line) {
                                if evt_for_stdout.send(evt).await.is_err() {
                                    return;
                                }
                            }
                        }
                        _ => break, // EOF or read error
                    }
                }
            }
        });

        // stderr → drained silently so the pipe never fills and blocks the child. In stream-json
        // mode real failures surface as `result` events on stdout; raw stderr is low-signal.
        if let Some(stderr) = stderr {
            let stderr_cancel = cancel.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                loop {
                    tokio::select! {
                        _ = stderr_cancel.cancelled() => break,
                        line = reader.next_line() => match line {
                            Ok(Some(_)) => continue,
                            _ => break,
                        }
                    }
                }
            });
        }

        // queued input → child stdin as stream-json user messages
        let stdin_cancel = cancel.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stdin_cancel.cancelled() => break,
                    msg = input_rx.recv() => match msg {
                        Some(text) => {
                            let line = encode_user_message(&text) + "\n";
                            if stdin.write_all(line.as_bytes()).await.is_err() {
                                break;
                            }
                            let _ = stdin.flush().await;
                        }
                        None => break,
                    }
                }
            }
        });

        // reap the child when cancelled so we don't leak zombies
        let reap_cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = reap_cancel.cancelled() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
                status = child.wait() => {
                    let _ = status;
                }
            }
        });

        Ok(DriverHandle {
            events: event_rx,
            stdin: input_tx,
            cancel,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_encoding_is_stream_json() {
        let line = encode_user_message("hi there");
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"][0]["text"], "hi there");
    }

    /// Spawns the REAL `claude` CLI. Ignored by default; run with:
    ///   cargo test real_claude_round_trip -- --ignored --nocapture
    #[ignore]
    #[tokio::test]
    async fn real_claude_round_trip() {
        let driver = CliDriver::default();
        let tmp = tempfile::tempdir().unwrap();
        let mut handle = driver
            .start(SessionOpts {
                cwd: Some(tmp.path().to_string_lossy().into_owned()),
                permission_mode: Some("bypassPermissions".into()),
                ..Default::default()
            })
            .await
            .expect("spawn claude");

        handle
            .stdin
            .send("Reply with exactly the single word: PONG".to_string())
            .await
            .unwrap();

        let mut saw_text = String::new();
        let mut got_result = false;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(90);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, handle.events.recv()).await {
                Ok(Some(DriverEvent::TextDelta(t))) => saw_text.push_str(&t),
                Ok(Some(DriverEvent::TurnResult { text, .. })) => {
                    saw_text.push_str(&text);
                    got_result = true;
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => break,
            }
        }
        handle.cancel.cancel();
        eprintln!("claude said: {saw_text:?}");
        assert!(got_result, "never received a turn result from claude");
        assert!(
            saw_text.to_uppercase().contains("PONG"),
            "claude reply did not contain PONG: {saw_text:?}"
        );
    }
}
