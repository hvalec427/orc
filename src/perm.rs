//! `orc perm-mcp --request <id>`: the stdio MCP server claude calls for
//! permission prompts (`--permission-prompt-tool mcp__orc__approve`). Each
//! prompt is forwarded to orcd, which holds it until you answer in the TUI.

use crate::client;
use crate::proto::{Cmd, Ev};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

pub fn run(request: &str) {
    let mut out = std::io::stdout();
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let result = match msg["method"].as_str().unwrap_or("") {
            "initialize" => json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "orc", "version": env!("CARGO_PKG_VERSION") },
            }),
            "ping" => json!({}),
            "tools/list" => json!({ "tools": [{
                "name": "approve",
                "description": "Asks the user in orc whether a tool call may run.",
                "inputSchema": { "type": "object", "properties": {
                    "tool_name": { "type": "string" }, "input": { "type": "object" }, "tool_use_id": { "type": "string" } } },
            }]}),
            "tools/call" => {
                let a = &msg["params"]["arguments"];
                let input = a.get("input").cloned().unwrap_or(json!({}));
                let cmd = Cmd::PermRequest { id: request.to_string(), tool: a["tool_name"].as_str().unwrap_or("").to_string(), input: input.clone() };
                let decision = match client::request(&cmd) {
                    Ok(Ev::Decision { allow: true, .. }) => json!({ "behavior": "allow", "updatedInput": input }),
                    Ok(Ev::Decision { message, .. }) => json!({ "behavior": "deny", "message": message.unwrap_or_else(|| "Denied in orc.".into()) }),
                    Ok(_) => json!({ "behavior": "deny", "message": "orc gave no decision" }),
                    Err(e) => json!({ "behavior": "deny", "message": format!("orc unavailable: {e}") }),
                };
                json!({ "content": [{ "type": "text", "text": decision.to_string() }] })
            }
            m => {
                let _ = writeln!(out, "{}", json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("unknown method {m}") } }));
                let _ = out.flush();
                continue;
            }
        };
        let _ = writeln!(out, "{}", json!({ "jsonrpc": "2.0", "id": id, "result": result }));
        let _ = out.flush();
    }
}
