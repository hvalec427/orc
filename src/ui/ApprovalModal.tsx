import { Box, Text, useInput } from 'ink';
import type { PendingApproval } from '../types.js';

export function ApprovalModal({
  agentName,
  pending,
  onDecide,
}: {
  agentName: string;
  pending: PendingApproval;
  onDecide: (approved: boolean) => void;
}) {
  useInput((input) => {
    if (input === 'y') onDecide(true);
    else if (input === 'n') onDecide(false);
  });

  const summary = JSON.stringify(pending.input).slice(0, 300);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        {agentName} wants to run: {pending.toolName}
      </Text>
      {pending.reason ? <Text dimColor>{pending.reason}</Text> : null}
      <Text wrap="wrap" dimColor>
        {summary}
      </Text>
      <Text>
        <Text color="green">y</Text> approve · <Text color="red">n</Text> deny
      </Text>
    </Box>
  );
}
