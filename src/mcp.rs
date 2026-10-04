//! A tiny MCP (Model Context Protocol) stdio server built into the orc binary.
//!
//! Launched per agent as `orc __mcp --pane <paneId> --dir <logsDir>` and wired into that agent's
//! `claude` session via `--mcp-config`. It exposes a single tool, `run`, which the agent calls to
//! execute a shell command **in its own visible tmux pane** (via the `__orc_run` protocol in
//! [`crate::tmux::pane_run`]). The human watches the command run in the pane and can press ↑ to
//! rerun it. The server drives tmux directly, so it needs no connection back to the main orc
//! process.
//!
//! Framing is newline-delimited JSON-RPC 2.0 (the MCP stdio transport).

use crate::tmux::pane_run::{cap_output, encode_injected_call, parse_captured_run};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::Path;
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: &str = "2025-06-18";
/// Max time to wait for one injected command to finish before giving up.
const RUN_TIMEOUT: Duration = Duration::from_secs(600);

/// Run the stdio MCP server until stdin closes.
pub fn serve(pane: &str, dir: &Path) -> anyhow::Result<()> {
    let stdin = std::io::stdin();
    let mut counter: u64 = 0;
    let mut lines = stdin.lock().lines();
    while let Some(line) = lines.next() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue; // ignore unparseable frames
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");

        match method {
            "initialize" => {
                let client_version = msg
                    .get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(Value::as_str)
                    .unwrap_or(PROTOCOL_VERSION)
                    .to_string();
                respond(
                    id,
                    json!({
                        "protocolVersion": client_version,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "orc", "version": env!("CARGO_PKG_VERSION") }
                    }),
                );
            }
            "notifications/initialized" | "notifications/cancelled" => { /* notification: no reply */ }
            "ping" => respond(id, json!({})),
            "tools/list" => respond(id, json!({ "tools": [tool_def()] })),
            "tools/call" => {
                let result = handle_call(&msg, pane, dir, &mut counter);
                respond(id, result);
            }
            _ => {
                if id.is_some() {
                    respond_error(id, -32601, "method not found");
                }
            }
        }
    }
    Ok(())
}

fn tool_def() -> Value {
    json!({
        "name": "run",
        "description": "Run a shell command in your dedicated terminal pane. The command executes \
in your own visible interactive shell (the human watches it run and can rerun it from history), \
and its combined stdout+stderr and exit code are returned. Use this for ALL shell commands.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "The shell command line to run." }
            },
            "required": ["command"]
        }
    })
}

fn handle_call(msg: &Value, pane: &str, dir: &Path, counter: &mut u64) -> Value {
    let command = msg
        .get("params")
        .and_then(|p| p.get("arguments"))
        .and_then(|a| a.get("command"))
        .and_then(Value::as_str);
    let Some(command) = command else {
        return tool_error("missing required argument: command");
    };

    let token = next_token(counter);
    let cmd_path = dir.join(format!("{token}.cmd"));
    let res_path = dir.join(format!("{token}.res"));
    if std::fs::write(&cmd_path, command).is_err() || std::fs::write(&res_path, "").is_err() {
        return tool_error("orc: could not stage the command files");
    }

    let injected = encode_injected_call(&token);
    if tmux(&["send-keys", "-t", pane, "-l", &injected]).is_err()
        || tmux(&["send-keys", "-t", pane, "Enter"]).is_err()
    {
        cleanup(&cmd_path, &res_path);
        return tool_error("orc: could not inject the command into the pane");
    }

    let deadline = Instant::now() + RUN_TIMEOUT;
    let outcome = loop {
        if let Ok(buf) = std::fs::read_to_string(&res_path) {
            if let Some((output, rc)) = parse_captured_run(&buf, &token, 0) {
                break Some((output, rc));
            }
        }
        if Instant::now() >= deadline {
            let _ = tmux(&["send-keys", "-t", pane, "C-c"]);
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    cleanup(&cmd_path, &res_path);

    match outcome {
        Some((output, rc)) => {
            let text = cap_output(&output, 32768);
            let body = if rc == 0 {
                text
            } else {
                format!("{text}\n(exit code {rc})")
            };
            json!({
                "content": [{ "type": "text", "text": body }],
                "isError": rc != 0
            })
        }
        None => tool_error("orc: the command timed out (600s) and was interrupted"),
    }
}

fn tool_error(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn next_token(counter: &mut u64) -> String {
    let seq = *counter;
    *counter += 1;
    let rand = uuid::Uuid::new_v4().simple().to_string();
    format!("m{seq}{}", &rand[..6])
}

fn tmux(args: &[&str]) -> anyhow::Result<()> {
    let out = std::process::Command::new("tmux").args(args).output()?;
    if !out.status.success() {
        anyhow::bail!("tmux {args:?} failed");
    }
    Ok(())
}

fn cleanup(a: &Path, b: &Path) {
    let _ = std::fs::remove_file(a);
    let _ = std::fs::remove_file(b);
}

fn respond(id: Option<Value>, result: Value) {
    write_msg(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
}

fn respond_error(id: Option<Value>, code: i64, message: &str) {
    write_msg(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }));
}

fn write_msg(v: Value) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

/// Build the `--mcp-config` JSON that points an agent's `claude` session at this server for `pane`.
/// `exe` is orc's own binary path; `dir` is the logs/panes directory where `.cmd`/`.res` files live.
/// `extra` servers (e.g. Maestro) are merged under their own keys.
pub fn build_mcp_config(exe: &str, pane: &str, dir: &Path, extra: Option<(&str, Value)>) -> String {
    let mut servers = serde_json::Map::new();
    servers.insert(
        "orc".to_string(),
        json!({
            "command": exe,
            "args": ["__mcp", "--pane", pane, "--dir", dir.to_string_lossy()]
        }),
    );
    if let Some((name, def)) = extra {
        servers.insert(name.to_string(), def);
    }
    json!({ "mcpServers": servers }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_config_includes_orc_server() {
        let cfg = build_mcp_config("/bin/orc", "%3", Path::new("/logs"), None);
        let v: Value = serde_json::from_str(&cfg).unwrap();
        assert_eq!(v["mcpServers"]["orc"]["command"], "/bin/orc");
        assert_eq!(v["mcpServers"]["orc"]["args"][0], "__mcp");
        assert_eq!(v["mcpServers"]["orc"]["args"][2], "%3");
    }

    #[test]
    fn mcp_config_merges_extra_server() {
        let maestro = json!({ "command": "maestro", "args": ["mcp"] });
        let cfg = build_mcp_config("/bin/orc", "%1", Path::new("/l"), Some(("maestro", maestro)));
        let v: Value = serde_json::from_str(&cfg).unwrap();
        assert_eq!(v["mcpServers"]["maestro"]["command"], "maestro");
        assert!(v["mcpServers"]["orc"].is_object());
    }

    #[test]
    fn tool_def_requires_command() {
        let t = tool_def();
        assert_eq!(t["name"], "run");
        assert_eq!(t["inputSchema"]["required"][0], "command");
    }
}
