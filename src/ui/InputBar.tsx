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
        <Text wrap="wrap" dimColor>
          {truncate(question, 300)}
        </Text>
      ) : null}
      <Box>
        <Text color="yellow">reply to {agentName} › </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(v) => {
            if (v.trim()) onSubmit(v.trim());
          }}
          placeholder="type your answer, Enter to send, Esc to cancel"
        />
      </Box>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? '…' + s.slice(-n) : s;
}
