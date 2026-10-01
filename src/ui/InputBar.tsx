import { Box, Text, useInput } from 'ink';
import { MultilineInput } from './MultilineInput.js';

export function InputBar({
  agentName,
  question,
  value,
  onChange,
  onSubmit,
  onCancel,
  maxLines,
  inputWidth,
}: {
  agentName: string;
  question?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  maxLines: number;
  inputWidth: number;
}) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      {question ? (
        <Text wrap="truncate" dimColor>
          {truncate(question, 300)}
        </Text>
      ) : null}
      <Box flexDirection="column">
        <Text color="yellow">reply to {agentName} ›</Text>
        <Box marginLeft={2}>
          <MultilineInput
            value={value}
            onChange={onChange}
            onSubmit={(v) => {
              const t = v.trim();
              if (t) onSubmit(t);
            }}
            focusColor="yellow"
            maxLines={maxLines}
            width={inputWidth}
            placeholder="type your answer · Enter to send · Alt/Shift+Enter newline · Esc to cancel"
          />
        </Box>
      </Box>
    </Box>
  );
}

// Collapse the (possibly multi-line) agent question into a single line so the
// bordered box stays intact, and tail-truncate it to `n` characters.
function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? '…' + one.slice(-n) : one;
}
