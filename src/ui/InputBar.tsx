import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

export function InputBar({
  agentName,
  question,
  onSubmit,
  onCancel,
}: {
  agentName: string;
  question?: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');

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
      <Box>
        <Text color="yellow">reply to {agentName} › </Text>
        <TextInput
          value={value}
          onChange={(v) => setValue(stripBreaks(v))}
          onSubmit={(v) => {
            const t = stripBreaks(v).trim();
            if (t) onSubmit(t);
          }}
          placeholder="type your answer, Enter to send, Esc to cancel"
        />
      </Box>
    </Box>
  );
}

// Replace line breaks (from pasted multiline text) with spaces so the
// single-line input never wraps and breaks the bordered box layout.
function stripBreaks(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ');
}

function truncate(s: string, n: number): string {
  const one = stripBreaks(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? '…' + one.slice(-n) : one;
}
