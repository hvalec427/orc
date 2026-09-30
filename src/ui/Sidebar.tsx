import { Box, Text } from 'ink';
import type { AgentInfo, AgentStatus } from '../types.js';

const STATUS: Record<AgentStatus, { icon: string; color: string; label: string }> = {
  booting: { icon: '◌', color: 'gray', label: 'booting' },
  working: { icon: '●', color: 'cyan', label: 'working' },
  needs_input: { icon: '?', color: 'yellow', label: 'needs you' },
  needs_approval: { icon: '!', color: 'magenta', label: 'approve?' },
  done: { icon: '✓', color: 'green', label: 'done' },
  error: { icon: '✗', color: 'red', label: 'error' },
  stopped: { icon: '■', color: 'gray', label: 'stopped' },
};

export function Sidebar({ infos, selectedIndex }: { infos: AgentInfo[]; selectedIndex: number }) {
  return (
    <Box flexDirection="column" width={34} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold>Agents</Text>
      {infos.length === 0 ? (
        <Text dimColor>press n to start one</Text>
      ) : (
        infos.map((info, i) => {
          const s = STATUS[info.status];
          const selected = i === selectedIndex;
          return (
            <Box key={info.id} flexDirection="column" marginTop={1}>
              <Text>
                <Text color={selected ? 'cyan' : undefined}>{selected ? '›' : ' '}</Text>
                <Text dimColor>{i + 1} </Text>
                <Text color={s.color} bold={info.status === 'needs_input' || info.status === 'needs_approval'}>
                  {s.icon}
                </Text>
                <Text bold={selected}> {info.name}</Text>
                {info.template !== 'feature' ? (
                  <Text dimColor> [{info.template}]</Text>
                ) : null}
              </Text>
              <Text dimColor> ⟨{truncate(info.project, 26)}⟩</Text>
              <Text dimColor> {truncate(info.ticket, 28)}</Text>
              <Text dimColor>
                {' '}
                <Text color={s.color}>{s.label}</Text>
                {info.metroPort !== undefined ? ` · :${info.metroPort}` : ''}
                {info.totalCostUsd > 0 ? ` · $${info.totalCostUsd.toFixed(2)}` : ''}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}
