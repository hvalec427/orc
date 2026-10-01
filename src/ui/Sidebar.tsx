import { Box, Text } from 'ink';
import type { AgentInfo, AgentStatus } from '../types.js';

/**
 * Single-width glyphs + colors instead of emojis: terminals render emojis at an
 * inconsistent (often 2-cell) width which breaks column alignment, whereas these
 * glyphs are reliably one cell wide.
 */
const STATUS_ICON: Record<AgentStatus, { glyph: string; color: string }> = {
  booting: { glyph: '○', color: 'yellow' },
  working: { glyph: '●', color: 'cyan' },
  needs_input: { glyph: '?', color: 'magenta' },
  needs_approval: { glyph: '!', color: 'yellow' },
  done: { glyph: '✓', color: 'green' },
  error: { glyph: '✗', color: 'red' },
  stopped: { glyph: '■', color: 'gray' },
};

export function Sidebar({ infos, selectedIndex }: { infos: AgentInfo[]; selectedIndex: number }) {
  return (
    <Box flexDirection="column" width={34} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold>Agents</Text>
      {infos.length === 0 ? (
        <Text dimColor>press n to start one</Text>
      ) : (
        infos.map((info, i) => {
          const { glyph, color } = STATUS_ICON[info.status];
          const selected = i === selectedIndex;
          // A child session (e.g. a merge agent spawned from a feature agent) renders indented
          // beneath its parent with a `└` connector instead of a list number.
          const isChild = info.parentId !== undefined;
          // Agents are grouped by project (see AgentManager.list), so a distinct project header is
          // rendered whenever a top-level agent's project differs from the previous top-level one.
          const prevTopLevel = lastTopLevelProjectBefore(infos, i);
          const showProjectHeader = !isChild && info.project !== prevTopLevel;
          return (
            <Box key={info.id} flexDirection="column" marginTop={isChild ? 0 : 1}>
              {showProjectHeader ? (
                <Text bold color="blue">{truncate(info.project, 30)}</Text>
              ) : null}
              <Text wrap="truncate">
                <Text color={selected ? 'cyan' : undefined}>{selected ? '›' : ' '}</Text>
                {isChild ? <Text dimColor>  └ </Text> : <Text dimColor>{i + 1} </Text>}
                <Text
                  color={color}
                  bold={info.status === 'needs_input' || info.status === 'needs_approval'}
                >
                  {glyph}
                </Text>
                <Text bold={selected}> {truncate(info.name, isChild ? 20 : 22)}</Text>
              </Text>
              <Text dimColor>
                {isChild ? '    ' : '  '}
                {info.template}
                {' · '}
                {info.totalCostUsd > 0 ? `$${info.totalCostUsd.toFixed(2)}` : '$0.00'}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

/** Project of the nearest top-level agent before index `i` (skipping nested children), or undefined. */
function lastTopLevelProjectBefore(infos: AgentInfo[], i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) {
    if (infos[j].parentId === undefined) return infos[j].project;
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}
