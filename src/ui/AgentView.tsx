import { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentSession } from '../agent/AgentSession.js';
import type { LogKind } from '../types.js';

const COLOR: Record<LogKind, { color?: string; dim?: boolean }> = {
  text: {},
  thinking: { color: 'gray', dim: true },
  tool: { color: 'cyan' },
  system: { color: 'gray', dim: true },
  result: { color: 'green' },
  error: { color: 'red' },
  input: { color: 'yellow' },
};

interface DLine {
  kind: LogKind;
  text: string;
}

export function AgentView({
  session,
  height,
  width,
  active,
}: {
  session: AgentSession | undefined;
  height: number;
  width: number;
  active: boolean;
}) {
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const maxTopRef = useRef(0);
  const followRef = useRef(follow);
  followRef.current = follow;

  // Reset scroll to live-tail when the selected agent changes.
  const sessionId = session?.id;
  useEffect(() => {
    setFollow(true);
    setPaused(false);
    setScrollTop(0);
  }, [sessionId]);

  const bodyRows = Math.max(3, height - 3);
  const contentWidth = Math.max(20, width - 4);

  // Flatten log entries into wrapped display lines.
  const lines: DLine[] = [];
  if (session) {
    for (const e of session.getEvents()) {
      const wrapped = wrapText(e.text, contentWidth);
      if (wrapped.length === 0) {
        if (!e.done) lines.push({ kind: e.kind, text: '…' });
        continue;
      }
      for (const t of wrapped) lines.push({ kind: e.kind, text: t });
    }
  }
  const maxTop = Math.max(0, lines.length - bodyRows);
  maxTopRef.current = maxTop;
  const top = follow ? maxTop : Math.min(scrollTop, maxTop);

  useInput(
    (input) => {
      const mt = maxTopRef.current;
      const cur = follow ? mt : Math.min(scrollTop, mt);
      if (input === 'p') {
        // Toggle pause. Pausing freezes the view at the current bottom so the
        // reader stays put while new logs keep accumulating in the buffer (none
        // are dropped). Resuming jumps to the latest log and re-enables follow.
        if (followRef.current) {
          setScrollTop(mt);
          setFollow(false);
          setPaused(true);
        } else {
          setScrollTop(mt);
          setFollow(true);
          setPaused(false);
        }
      } else if (input === 'K') {
        setScrollTop(Math.max(0, cur - 1));
        setFollow(false);
      } else if (input === 'J') {
        const nt = Math.min(mt, cur + 1);
        setScrollTop(nt);
        setFollow(nt >= mt);
        if (nt >= mt) setPaused(false);
      } else if (input === 'G') {
        setScrollTop(mt);
        setFollow(true);
        setPaused(false);
      }
    },
    { isActive: active && !!session },
  );

  const windowLines = lines.slice(top, top + bodyRows);
  while (windowLines.length < bodyRows) windowLines.push({ kind: 'text', text: '' });

  const behind = maxTop - top;
  const scrollLabel = follow
    ? 'live'
    : paused
      ? behind > 0
        ? `⏸ scroll paused ↑${behind} (p:resume)`
        : '⏸ scroll paused (p:resume)'
      : maxTop === 0
        ? 'live'
        : `↑${behind} (G:bottom)`;
  const labelColor = follow ? 'green' : paused ? 'magenta' : 'yellow';

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      height={height}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      {session ? (
        <Text>
          <Text bold>{session.getInfo().name}</Text>
          <Text dimColor>
            {' '}
            · {session.getInfo().template} · {session.getInfo().status} ·{' '}
            {session.getInfo().branch ?? 'no worktree'}
            {session.getInfo().metroPort !== undefined ? ` · :${session.getInfo().metroPort}` : ''} ·{' '}
          </Text>
          <Text color={labelColor}>{scrollLabel}</Text>
        </Text>
      ) : (
        <Text dimColor>No agent selected. Press n to start one.</Text>
      )}
      <Box flexDirection="column" height={bodyRows}>
        {windowLines.map((l, i) => {
          const c = COLOR[l.kind];
          return (
            <Text key={i} color={c.color} dimColor={c.dim} wrap="truncate">
              {l.text || ' '}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

/** Split text on newlines and hard-wrap each segment to `width` (predictable line count). */
function wrapText(s: string, width: number): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const seg of s.split('\n')) {
    if (seg.length === 0) {
      out.push('');
      continue;
    }
    for (let i = 0; i < seg.length; i += width) out.push(seg.slice(i, i + width));
  }
  return out;
}
