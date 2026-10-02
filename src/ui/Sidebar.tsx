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
  needs_login: { glyph: '⊘', color: 'red' },
  done: { glyph: '✓', color: 'green' },
  error: { glyph: '✗', color: 'red' },
  stopped: { glyph: '■', color: 'gray' },
};

/**
 * The sidebar renders two sections sharing ONE selection index: the active agents (full rows, project
 * headers, cost line) followed by a collapsible "Done" section of archived agents. `selectedIndex`
 * indexes into `active.concat(showDone ? archived : [])` — exactly the flat navigable list App builds —
 * so the `›` caret lands on the right row across both sections.
 *
 * The list is unbounded (one block per agent), so with many agents it could be taller than the
 * terminal. `height` pins the box to the body height and we clip + scroll internally: the outer box
 * is fixed height with overflow hidden, and the inner column is nudged up (negative marginTop) by
 * whole agent blocks until the selected agent fits in view. This keeps the TOTAL frame height constant
 * regardless of agent count, so the frame never overflows the terminal and scrolls Ink off-screen.
 */
export function Sidebar({
  active,
  archived,
  showDone,
  selectedIndex,
  height,
}: {
  active: AgentInfo[];
  archived: AgentInfo[];
  showDone: boolean;
  selectedIndex: number;
  height: number;
}) {
  // The flat navigable list, matching App's `active.concat(showDone ? archived : [])`.
  const rows: AgentInfo[] = active.concat(showDone ? archived : []);
  // Per-agent block heights (in terminal rows), in list order, so we can scroll by whole blocks
  // and know exactly how many fit under the "Agents" title.
  const blockHeights = rows.map((info, i) =>
    info.archived
      ? 1 // archived rows are a single compact line
      : blockHeightOf(info, lastTopLevelProjectBefore(active, i)),
  );
  // Rows available for the list itself: the box interior (height - 2 for the round border) minus the
  // "Agents" title line. Clamp so we always render at least one row.
  const listRows = Math.max(1, height - 2 - 1);
  const scroll = scrollOffset(blockHeights, selectedIndex, listRows);

  return (
    <Box
      flexDirection="column"
      width={34}
      height={height}
      flexShrink={0}
      overflow="hidden"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold>Agents</Text>
      {/* marginTop shifts the whole list up by the scrolled-off rows; the outer box clips the rest. */}
      <Box flexDirection="column" flexShrink={0} marginTop={-scroll}>
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
    </Box>
  );
}

/** Rendered height (in rows) of one active-agent block: optional project header + name + cost line,
 *  plus the top margin that separates top-level agents. Mirrors AgentRow's layout. */
function blockHeightOf(info: AgentInfo, prevProject: string | undefined): number {
  const isChild = info.parentId !== undefined;
  const marginTop = isChild ? 0 : 1;
  const header = !isChild && info.project !== prevProject ? 1 : 0;
  return marginTop + header + 1 /* name */ + 1 /* template·cost */;
}

/** Smallest number of leading rows to hide so the selected block fits within `listRows`.
 *  Scrolls by whole agent blocks: accumulate hidden rows until the selected block's bottom is in view. */
function scrollOffset(blockHeights: number[], selectedIndex: number, listRows: number): number {
  if (selectedIndex < 0) return 0;
  let start = 0; // first visible block index
  const heightFrom = (from: number, to: number) => {
    let h = 0;
    for (let i = from; i <= to; i++) h += blockHeights[i] ?? 0;
    return h;
  };
  // Advance the window start until the selected block's cumulative height fits.
  while (start < selectedIndex && heightFrom(start, selectedIndex) > listRows) start++;
  return heightFrom(0, start - 1);
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
          bold={
            info.status === 'needs_input' ||
            info.status === 'needs_approval' ||
            info.status === 'needs_login'
          }
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
