import { memo, useState, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentSession } from '../agent/AgentSession.js';
import type { AgentManager } from '../agent/AgentManager.js';
import type { LogKind } from '../types.js';
import { LOG_KIND_COLOR } from './logFormat.js';
import { subscribeAgent } from './subscriptions.js';

interface DLine {
  kind: LogKind;
  text: string;
}

export const AgentView = memo(function AgentView({
  session,
  manager,
  height,
  width,
  active,
  preview,
}: {
  session: AgentSession | undefined;
  manager: AgentManager;
  height: number;
  width: number;
  active: boolean;
  /** When set, show these "how to run/test this branch" instructions instead of the log. */
  preview?: string;
}) {
  // Subscribe ONLY to the selected agent's content slice: re-render this pane when its eventsVersion
  // advances (a new log entry), falling back to the global 'update' event. A background update to a
  // DIFFERENT agent leaves this agent's eventsVersion unchanged, so this pane does not repaint.
  const eventsVersion = useSyncExternalStore(
    (onChange) =>
      subscribeAgent(manager as unknown as Parameters<typeof subscribeAgent>[0], session?.id, onChange),
    () => session?.eventsVersion() ?? 0,
    () => session?.eventsVersion() ?? 0,
  );

  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const maxTopRef = useRef(0);
  const followRef = useRef(follow);
  followRef.current = follow;

  // Reset scroll when the selected agent changes, or when toggling into/out of preview, so the
  // view starts at the top of the preview and returns to live-tail afterwards.
  const sessionId = session?.id;
  const previewing = preview !== undefined;
  useEffect(() => {
    setFollow(true);
    setPaused(false);
    setScrollTop(0);
  }, [sessionId, previewing]);

  const bodyRows = Math.max(3, height - 3);
  const contentWidth = Math.max(20, width - 4);

  // Flatten the log entries — or, while previewing, the instruction text — into wrapped lines. This
  // re-wraps the whole (up to ~800-entry) buffer, so memoize it: it only changes when the selected
  // agent (id), its content (eventsVersion), the wrap width (contentWidth), or the preview document
  // changes — NOT on every scroll keypress or unrelated re-render.
  const lines: DLine[] = useMemo(() => {
    const out: DLine[] = [];
    if (previewing) {
      for (const t of wrapText(preview, contentWidth)) out.push({ kind: 'system', text: t });
    } else if (session) {
      for (const e of session.getEvents()) {
        const wrapped = wrapText(e.text, contentWidth);
        if (wrapped.length === 0) {
          if (!e.done) out.push({ kind: e.kind, text: '…' });
          continue;
        }
        for (const t of wrapped) out.push({ kind: e.kind, text: t });
      }
    }
    return out;
    // eventsVersion drives content changes; sessionId/preview/contentWidth cover the rest. session is
    // intentionally read through sessionId (stable per agent) so a mere re-render doesn't rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, eventsVersion, contentWidth, previewing, preview]);
  const maxTop = Math.max(0, lines.length - bodyRows);
  maxTopRef.current = maxTop;
  // The preview is a static document: start at the top and let the reader scroll, rather than
  // auto-tailing to the bottom like the live log.
  const top = previewing ? Math.min(scrollTop, maxTop) : follow ? maxTop : Math.min(scrollTop, maxTop);

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
  const scrollLabel = previewing
    ? 'preview (P:close)'
    : follow
      ? 'live'
      : paused
        ? behind > 0
          ? `⏸ scroll paused ↑${behind} (p:resume)`
          : '⏸ scroll paused (p:resume)'
        : maxTop === 0
          ? 'live'
          : `↑${behind} (G:bottom)`;
  const labelColor = previewing ? 'cyan' : follow ? 'green' : paused ? 'magenta' : 'yellow';

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
          const c = LOG_KIND_COLOR[l.kind];
          return (
            <Text key={i} color={c.color} dimColor={c.dim} wrap="truncate">
              {l.text || ' '}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
});

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
