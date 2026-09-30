import { Box, Text } from 'ink';
import type { AgentSession } from '../agent/AgentSession.js';
import type { LogEntry, LogKind } from '../types.js';

const COLOR: Record<LogKind, { color?: string; dim?: boolean }> = {
  text: {},
  thinking: { color: 'gray', dim: true },
  tool: { color: 'cyan' },
  system: { color: 'gray', dim: true },
  result: { color: 'green' },
  error: { color: 'red' },
  input: { color: 'yellow' },
};

export function AgentView({
  session,
  height,
  width,
}: {
  session: AgentSession | undefined;
  height: number;
  width: number;
}) {
  if (!session) {
    return (
      <Box flexGrow={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>No agent selected. Press n to start one.</Text>
      </Box>
    );
  }

  const info = session.getInfo();
  const bodyRows = Math.max(3, height - 3);
  const contentWidth = Math.max(20, width - 4);
  const visible = tailEntries(session.getEvents(), contentWidth, bodyRows);

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text>
        <Text bold>{info.name}</Text>
        <Text dimColor> · {info.status} · {info.branch} · :{info.metroPort}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((e) => {
          const c = COLOR[e.kind];
          return (
            <Text key={e.id} color={c.color} dimColor={c.dim} wrap="wrap">
              {e.text || (e.done ? '' : '…')}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * Return the entries that fit in `maxRows`, newest at the bottom.
 * Long text blocks are tail-truncated so a single big message can't blow the viewport.
 */
function tailEntries(entries: readonly LogEntry[], width: number, maxRows: number): LogEntry[] {
  const capped = entries.map((e) => {
    if ((e.kind === 'text' || e.kind === 'thinking') && e.text.length > width * 4) {
      return { ...e, text: '…' + e.text.slice(-width * 4) };
    }
    return e;
  });
  // Estimate rows per entry to avoid overflowing the terminal frame.
  const out: LogEntry[] = [];
  let used = 0;
  for (let i = capped.length - 1; i >= 0 && used < maxRows; i--) {
    const e = capped[i];
    const lines = Math.max(1, Math.ceil((e.text.length || 1) / width));
    out.unshift(e);
    used += lines;
  }
  return out;
}
