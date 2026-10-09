//! One Claude Code agent: a `claude -p` process in stream-json mode. Its
//! stdout is parsed into conversation items; user messages (and interrupts)
//! are written to its stdin.

use crate::proto::Item;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

pub enum AgentEvent {
    SessionId(String),
    Delta(String),
    Item(Item),
    /// The turn finished (after its `Turn` item).
    TurnDone,
    Exited,
}

pub struct AgentOpts {
    pub cwd: String,
    pub resume: Option<String>,
    pub mcp_config: String,
    pub permission_mode: Option<String>,
    pub allowed_tools: Vec<String>,
    pub model: Option<String>,
    pub system_prompt: String,
}

pub struct Agent {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
}

impl Agent {
    pub fn start(o: AgentOpts, on_event: impl Fn(AgentEvent) + Send + 'static) -> Result<Agent> {
        let mut cmd = Command::new("claude");
        cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
        cmd.args(["--mcp-config", &o.mcp_config, "--permission-prompt-tool", "mcp__orc__approve"]);
        cmd.args(["--append-system-prompt", &o.system_prompt]);
        if let Some(m) = &o.permission_mode {
            cmd.args(["--permission-mode", m]);
        }
        if !o.allowed_tools.is_empty() {
            cmd.arg("--allowedTools").arg(o.allowed_tools.join(","));
        }
        if let Some(m) = &o.model {
            cmd.args(["--model", m]);
        }
        if let Some(r) = &o.resume {
            cmd.args(["--resume", r]);
        }
        cmd.current_dir(&o.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| anyhow!("couldn't start claude: {e}"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        // stderr: keep the last lines, report them if the process dies.
        let tail: Arc<Mutex<Vec<String>>> = Arc::default();
        let tail_w = tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut t = tail_w.lock().unwrap();
                t.push(line);
                if t.len() > 20 {
                    t.remove(0);
                }
            }
        });
        let ev = on_event;
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                for e in parse_line(&line) {
                    ev(e);
                }
            }
            let t = tail.lock().unwrap().join("\n");
            if !t.trim().is_empty() {
                ev(AgentEvent::Item(Item::System { text: format!("claude exited:\n{t}") }));
            }
            ev(AgentEvent::Exited);
        });
        Ok(Agent { stdin: Arc::new(Mutex::new(stdin)), child: Arc::new(Mutex::new(child)) })
    }

    fn write(&self, v: Value) -> Result<()> {
        let mut s = self.stdin.lock().unwrap();
        writeln!(s, "{v}")?;
        s.flush()?;
        Ok(())
    }

    pub fn send(&self, text: &str) -> Result<()> {
        self.write(json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } }))
    }

    /// Stop the current turn (the agent keeps its session).
    pub fn interrupt(&self) -> Result<()> {
        self.write(json!({ "type": "control_request", "request_id": format!("orc-{}", crate::config::now()), "request": { "subtype": "interrupt" } }))
    }

    pub fn kill(&self) {
        let mut c = self.child.lock().unwrap();
        let _ = c.kill();
        let _ = c.wait();
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        self.kill();
    }
}

fn parse_line(line: &str) -> Vec<AgentEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    match v["type"].as_str().unwrap_or("") {
        "system" if v["subtype"] == "init" => {
            if let Some(s) = v["session_id"].as_str() {
                out.push(AgentEvent::SessionId(s.to_string()));
            }
        }
        "stream_event" => {
            let e = &v["event"];
            if e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta" {
                if let Some(t) = e["delta"]["text"].as_str() {
                    out.push(AgentEvent::Delta(t.to_string()));
                }
            }
        }
        "assistant" => {
            for b in v["message"]["content"].as_array().into_iter().flatten() {
                match b["type"].as_str() {
                    Some("text") => {
                        let t = b["text"].as_str().unwrap_or("").trim();
                        if !t.is_empty() {
                            out.push(AgentEvent::Item(Item::Assistant { text: t.to_string() }));
                        }
                    }
                    Some("tool_use") => {
                        let name = b["name"].as_str().unwrap_or("").to_string();
                        out.push(AgentEvent::Item(Item::Tool { id: b["id"].as_str().unwrap_or("").into(), summary: tool_summary(&name, &b["input"]), name }));
                    }
                    _ => {}
                }
            }
        }
        "user" => {
            for b in v["message"]["content"].as_array().into_iter().flatten() {
                if b["type"] == "tool_result" {
                    let text = match &b["content"] {
                        Value::String(s) => s.clone(),
                        Value::Array(a) => a.iter().filter_map(|c| c["text"].as_str().or_else(|| (c["type"] == "image").then_some("[image]"))).collect::<Vec<_>>().join("\n"),
                        _ => String::new(),
                    };
                    out.push(AgentEvent::Item(Item::ToolResult { id: b["tool_use_id"].as_str().unwrap_or("").into(), ok: !b["is_error"].as_bool().unwrap_or(false), preview: preview(&text) }));
                }
            }
        }
        "result" => {
            let error = (v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str().is_some_and(|s| s != "success"))
                .then(|| v["result"].as_str().filter(|s| !s.is_empty()).or(v["subtype"].as_str()).unwrap_or("error").to_string());
            out.push(AgentEvent::Item(Item::Turn { cost: v["total_cost_usd"].as_f64(), error }));
            out.push(AgentEvent::TurnDone);
        }
        _ => {}
    }
    out
}

/// One line describing a tool call: the command, file or pattern it's about.
pub fn tool_summary(name: &str, input: &Value) -> String {
    let s = |k: &str| input[k].as_str().unwrap_or("").to_string();
    let short = match name {
        "Bash" => s("command"),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => s("file_path"),
        "Grep" => format!("{} {}", s("pattern"), s("path")),
        "Glob" => s("pattern"),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        "Task" | "Agent" => s("description"),
        "TodoWrite" => format!("{} todos", input["todos"].as_array().map_or(0, |a| a.len())),
        _ => {
            let j = input.to_string();
            if j == "{}" {
                String::new()
            } else {
                j
            }
        }
    };
    let short = short.replace('\n', " ⏎ ");
    match short.char_indices().nth(160) {
        Some((i, _)) => format!("{}…", &short[..i]),
        None => short,
    }
}

fn preview(text: &str) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let mut p: String = lines.iter().take(3).map(|l| l.chars().take(200).collect::<String>()).collect::<Vec<_>>().join("\n");
    if lines.len() > 3 {
        p.push_str(&format!("\n… {} more lines", lines.len() - 3));
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(line: &str) -> Vec<Item> {
        parse_line(line).into_iter().filter_map(|e| if let AgentEvent::Item(i) = e { Some(i) } else { None }).collect()
    }

    #[test]
    fn parses_assistant_tools_and_results() {
        let a = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls\nsrc"}}]}}"#;
        assert_eq!(items(a), vec![Item::Assistant { text: "Looking.".into() }, Item::Tool { id: "t1".into(), name: "Bash".into(), summary: "ls ⏎ src".into() }]);
        let u = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"a\nb\nc\nd"}],"is_error":false}]}}"#;
        assert_eq!(items(u), vec![Item::ToolResult { id: "t1".into(), ok: true, preview: "a\nb\nc\n… 1 more lines".into() }]);
        let r = r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.12,"result":"done"}"#;
        assert_eq!(items(r), vec![Item::Turn { cost: Some(0.12), error: None }]);
    }
}
