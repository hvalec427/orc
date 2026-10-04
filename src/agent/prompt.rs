//! Agent prompt sentinels + turn-end detection.

/// The sentinel an agent emits when it needs human input.
pub const NEEDS_INPUT: &str = "@@NEEDS_INPUT@@";
/// The prefix an agent emits (followed by an optional commit hash) when done.
pub const DONE: &str = "@@DONE@@";

/// Parsed classification of a final turn's sentinel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnEnd {
    /// `@@DONE@@ <hash>` — the agent finished; `hash` may be empty.
    Done { hash: String },
    /// `@@NEEDS_INPUT@@` — the agent is asking the human.
    NeedsInput,
    /// No recognized sentinel.
    None,
}

/// Detect a turn-end sentinel in a final message, capturing the commit hash for DONE.
///
/// Recognizes `@@DONE@@ <hash>` (hash: the first whitespace-delimited token after the sentinel,
/// possibly empty) and `@@NEEDS_INPUT@@`.
pub fn detect_turn_end(text: &str) -> TurnEnd {
    let text = text.trim();
    // DONE wins over NEEDS_INPUT, matching the TS precedence in AgentSession.handleResult.
    if let Some(idx) = text.find(DONE) {
        let after = text[idx + DONE.len()..].trim();
        let hash = after.split_whitespace().next().unwrap_or("").to_string();
        return TurnEnd::Done { hash };
    }
    if text.contains(NEEDS_INPUT) {
        return TurnEnd::NeedsInput;
    }
    TurnEnd::None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn done_captures_hash() {
        let end = detect_turn_end("all finished\n@@DONE@@ a1b2c3d");
        assert_eq!(
            end,
            TurnEnd::Done {
                hash: "a1b2c3d".to_string()
            }
        );
    }

    #[test]
    fn done_captures_long_hash() {
        let hash = "0123456789abcdef0123456789abcdef01234567"; // 40 chars
        let end = detect_turn_end(&format!("done\n@@DONE@@ {hash}"));
        assert_eq!(
            end,
            TurnEnd::Done {
                hash: hash.to_string()
            }
        );
    }

    #[test]
    fn needs_input_detected() {
        let end = detect_turn_end("which option?\n@@NEEDS_INPUT@@");
        assert_eq!(end, TurnEnd::NeedsInput);
    }

    #[test]
    fn plain_text_is_none() {
        assert_eq!(detect_turn_end("just some text"), TurnEnd::None);
    }
}
