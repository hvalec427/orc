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

/**
 * The sidebar renders two sections sharing ONE selection index: the active agents (full rows, project
 * headers, cost line) followed by a collapsible "Done" section of archived agents. `selectedIndex`
 * indexes into `active.concat(showDone ? archived : [])` — exactly the flat navigable list App builds —
 * so the `›` caret lands on the right row across both sections.
 */
export function Sidebar({
  active,
  archived,
  showDone,
  selectedIndex,
}: {
  active: AgentInfo[];
  archived: AgentInfo[];
  showDone: boolean;
  selectedIndex: number;
}) {
  return (
    <Box flexDirection="column" width={34} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold>Agents</Text>
      {active.length === 0 ? (
        <Text dimColor>press n to start one</Text>
      ) : (
        active.map((info, i) => (
          <AgentRow key={info.id} info={info} index={i} selected={i === selectedIndex} prevProject={lastTopLevelProjectBefore(active, i)} />
        ))
      )}
      {archived.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Done ({archived.length}){showDone ? '' : ' — t to show'}</Text>
          {showDone
            ? archived.map((info, i) => (
                <ArchivedRow key={info.id} info={info} selected={active.length + i === selectedIndex} />
              ))
            : null}
        </Box>
      ) : null}
    </Box>
  );
}

/** A full active-agent row: status glyph, name, optional project header, and the template·cost line. */
function AgentRow({
  info,
  index,
  selected,
  prevProject,
}: {
  info: AgentInfo;
  index: number;
  selected: boolean;
  prevProject: string | undefined;
}) {
  const { glyph, color } = STATUS_ICON[info.status];
  // A child session (e.g. a merge agent spawned from a feature agent) renders indented
  // beneath its parent with a `└` connector instead of a list number.
  const isChild = info.parentId !== undefined;
  // Agents are grouped by project (see AgentManager.list), so a distinct project header is
  // rendered whenever a top-level agent's project differs from the previous top-level one.
  const showProjectHeader = !isChild && info.project !== prevProject;
  return (
    <Box flexDirection="column" marginTop={isChild ? 0 : 1}>
      {showProjectHeader ? <Text bold color="blue">{truncate(info.project, 30)}</Text> : null}
      <Text wrap="truncate">
        <Text color={selected ? 'cyan' : undefined}>{selected ? '›' : ' '}</Text>
        {isChild ? <Text dimColor>  └ </Text> : <Text dimColor>{index + 1} </Text>}
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
        {info.totalCostUsd === undefined ? '$NaN' : `$${info.totalCostUsd.toFixed(2)}`}
      </Text>
    </Box>
  );
}

/** A compact, dimmed row for an archived agent in the Done section: caret + status glyph + name. */
function ArchivedRow({ info, selected }: { info: AgentInfo; selected: boolean }) {
  const { glyph } = STATUS_ICON[info.status];
  return (
    <Text wrap="truncate" dimColor>
      <Text color={selected ? 'cyan' : undefined}>{selected ? '›' : ' '}</Text>
      {' '}
      {glyph}
      <Text bold={selected}> {truncate(info.name, 24)}</Text>
    </Text>
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
