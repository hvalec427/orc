//! Parse the Claude CLI's stream-json stdout lines into [`DriverEvent`]s.

use crate::agent::driver::DriverEvent;
use serde_json::Value;

/// Parse a single line of the CLI's `--output-format stream-json` output into zero or more driver
/// events. Unknown / non-JSON lines yield an empty vec.
pub fn parse_stream_line(line: &str) -> Vec<DriverEvent> {
    let v: Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(msg_type) = v.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };

    match msg_type {
        "system" => parse_system(&v),
        "stream_event" => v.get("event").map(parse_stream_event).unwrap_or_default(),
        "user" => parse_user(&v),
        "result" => parse_result(&v),
        _ => Vec::new(),
    }
}

/// `system` messages: the `init` subtype carries the session id and model.
fn parse_system(v: &Value) -> Vec<DriverEvent> {
    if v.get("subtype").and_then(Value::as_str) != Some("init") {
        return Vec::new();
    }
    let mut events = Vec::new();
    if let Some(sid) = v.get("session_id").and_then(Value::as_str) {
        events.push(DriverEvent::SessionId(sid.to_string()));
    }
    if let Some(model) = v.get("model").and_then(Value::as_str) {
        events.push(DriverEvent::Model(model.to_string()));
    }
    events
}

/// `stream_event` wraps an Anthropic streaming event (content block start/delta/stop, message_stop).
fn parse_stream_event(event: &Value) -> Vec<DriverEvent> {
    let Some(kind) = event.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };
    match kind {
        "content_block_start" => {
            let Some(cb) = event.get("content_block") else {
                return Vec::new();
            };
            if cb.get("type").and_then(Value::as_str) == Some("tool_use") {
                let id = cb
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = cb
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let input_json = cb
                    .get("input")
                    .filter(|i| i.as_object().is_some_and(|o| !o.is_empty()))
                    .map(|i| i.to_string())
                    .unwrap_or_default();
                vec![DriverEvent::ToolUse {
                    id,
                    name,
                    input_json,
                }]
            } else {
                Vec::new()
            }
        }
        "content_block_delta" => {
            let Some(delta) = event.get("delta") else {
                return Vec::new();
            };
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => delta
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|t| vec![DriverEvent::TextDelta(t.to_string())])
                    .unwrap_or_default(),
                Some("thinking_delta") => delta
                    .get("thinking")
                    .and_then(Value::as_str)
                    .map(|t| vec![DriverEvent::ThinkingDelta(t.to_string())])
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
        "message_stop" => vec![DriverEvent::MessageStop],
        _ => Vec::new(),
    }
}

/// `user` messages carry tool_result blocks in `message.content`.
fn parse_user(v: &Value) -> Vec<DriverEvent> {
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array);
    let Some(blocks) = content else {
        return Vec::new();
    };
    let mut events = Vec::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let tool_use_id = block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let is_error = block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let text = flatten_tool_result(block.get("content"));
        events.push(DriverEvent::ToolResult {
            tool_use_id,
            text,
            is_error,
        });
    }
    events
}

/// Flatten a tool_result's `content` (a bare string or an array of `{type:'text', text}` blocks).
fn flatten_tool_result(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// `result` messages close a turn with the final text, cost and error info.
fn parse_result(v: &Value) -> Vec<DriverEvent> {
    let subtype = v
        .get("subtype")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let text = v
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let cost_usd = v.get("total_cost_usd").and_then(Value::as_f64);
    let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
        || (!subtype.is_empty() && subtype != "success");
    let session_id = v
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let errors = v
        .get("errors")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    vec![DriverEvent::TurnResult {
        subtype,
        text,
        cost_usd,
        is_error,
        session_id,
        errors,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_json_line_yields_nothing() {
        assert_eq!(parse_stream_line("not json"), Vec::new());
    }

    #[test]
    fn system_init_yields_session_id() {
        let line = r#"{"type":"system","subtype":"init","session_id":"sess-123"}"#;
        let events = parse_stream_line(line);
        assert!(events.contains(&DriverEvent::SessionId("sess-123".to_string())));
    }
}
