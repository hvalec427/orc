import { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { OrcConfig } from '../types.js';
import type { AgentManager } from '../agent/AgentManager.js';
import { Sidebar } from './Sidebar.js';
import { AgentView } from './AgentView.js';
import { InputBar } from './InputBar.js';
import { NewAgentForm } from './NewAgentForm.js';
import { ApprovalModal } from './ApprovalModal.js';

type Mode = 'list' | 'new' | 'input';

export function App({ manager, config }: { manager: AgentManager; config: OrcConfig }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 30;

  const [, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string>('');
  const [confirmingQuit, setConfirmingQuit] = useState(false);
  // Reply text is held here (not inside InputBar) so the layout can reserve rows
  // for exactly as many lines as the user has typed — keeping the whole frame
  // below the terminal height and avoiding the scroll/redraw flicker.
  const [replyValue, setReplyValue] = useState('');

  // Re-render whenever any agent updates. A busy agent emits ~15fps token-delta
  // updates; while the reply box is open, repainting the whole tree that fast
  // moves the focused TextInput cursor and makes the TUI flicker. So while
  // typing a reply we coalesce updates to a few frames per second — the log
  // stays live (you still see the agent working/finishing), but the repaint is
  // infrequent enough that the blink is negligible.
  const replyOpen = mode === 'input';
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);

    if (!replyOpen) {
      const onUpdate = () => bump();
      const onLog = (m: string) => setNotice(m);
      manager.on('update', onUpdate);
      manager.on('log', onLog);
      return () => {
        manager.off('update', onUpdate);
        manager.off('log', onLog);
      };
    }

    // Throttled path while the reply box is open (~4fps).
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (pending) {
        pending = false;
        bump();
      }
    };
    const onUpdate = () => {
      pending = true;
      if (!timer) timer = setTimeout(flush, 250);
    };
    const onLog = (m: string) => setNotice(m);
    manager.on('update', onUpdate);
    manager.on('log', onLog);
    return () => {
      manager.off('update', onUpdate);
      manager.off('log', onLog);
      if (timer) clearTimeout(timer);
    };
  }, [manager, replyOpen]);

  const agents = manager.list();
  const infos = agents.map((a) => a.getInfo());

  // Keep selection valid.
  const selectedIndex = Math.max(0, infos.findIndex((i) => i.id === selectedId));
  const selected = agents[selectedIndex];
  useEffect(() => {
    if (!selectedId && infos.length > 0) setSelectedId(infos[0].id);
    if (selectedId && !infos.some((i) => i.id === selectedId) && infos.length > 0) {
      setSelectedId(infos[0].id);
    }
  }, [selectedId, infos]);

  const select = useCallback(
    (index: number) => {
      const list = manager.list();
      if (list.length === 0) return;
      const clamped = ((index % list.length) + list.length) % list.length;
      setSelectedId(list[clamped].id);
    },
    [manager],
  );

  const approvalPending = selected?.pendingApproval;

  // Global keys — active only in list mode and when no approval modal is up.
  useInput(
    (input, key) => {
      if (input === 'q') {
        setConfirmingQuit(true);
        return;
      }
      if (input === 'n') {
        setMode('new');
        return;
      }
      if (manager.list().length === 0) return;

      if (key.downArrow || input === 'j' || key.tab) select(selectedIndex + 1);
      else if (key.upArrow || input === 'k') select(selectedIndex - 1);
      else if (input === 'l') {
        // Descend into the selected agent's first child (a merge agent, or a launcher's first
        // spawned feature agent), if any.
        if (selected) {
          const child = manager.firstChildOf(selected.id);
          if (child) setSelectedId(child.id);
        }
      } else if (input === 'h') {
        // Jump from a child session back up to its parent.
        const parentId = selected?.getInfo().parentId;
        if (parentId) setSelectedId(parentId);
      } else if (input === 'w') {
        const waiting = manager.firstWaiting();
        if (waiting) setSelectedId(waiting.id);
      } else if (input === 'i' || key.return) {
        if (selected) {
          setReplyValue('');
          setMode('input');
        }
      } else if (input === 'x') {
        void selected?.stop();
      } else if (input === 'r') {
        selected?.retry();
      } else if (input === 'm' && selected) {
        const id = selected.id;
        const branch = selected.getInfo().branch;
        if (!branch) {
          setNotice(`"${selected.name}" has no branch to merge`);
          return;
        }
        const existing = manager.mergeChildOf(id);
        setNotice(existing ? `merge agent for ${branch} already running` : `merging ${branch}…`);
        manager
          .mergeAgent(id)
          .then((s) => {
            setSelectedId(s.id);
            if (!existing) setNotice(`merging ${branch}`);
          })
          .catch((err) => setNotice(`merge failed: ${(err as Error).message}`));
      } else if (input === 'd' && selected) {
        const id = selected.id;
        // Move selection to the next agent (or previous if deleting the last).
        const next = infos[selectedIndex + 1] ?? infos[selectedIndex - 1];
        if (next) setSelectedId(next.id);
        setNotice(`deleting ${id}…`);
        void manager.remove(id).then(() => setNotice(`deleted ${id}`));
      }
    },
    { isActive: mode === 'list' && !approvalPending && !confirmingQuit },
  );

  // Quit confirmation keys — active only while the confirm popup is up.
  useInput(
    (input, key) => {
      if (input === 'y') {
        void manager.stopAll().finally(exit);
      } else if (input === 'n' || key.escape) {
        setConfirmingQuit(false);
      }
    },
    { isActive: confirmingQuit },
  );

  if (mode === 'new') {
    return (
      <NewAgentForm
        projects={manager.projects()}
        onCancel={() => setMode('list')}
        onSubmit={(template, project, name, ticket, prompt, magicLink) => {
          setMode('list');
          setNotice(`creating ${template} "${name}" in ${project}…`);
          manager
            .create(project, template, name, ticket, prompt, magicLink)
            .then((s) => {
              setSelectedId(s.id);
              setNotice(`launched "${name}"`);
            })
            .catch((err) => setNotice(`failed: ${(err as Error).message}`));
        }}
      />
    );
  }

  // Reserve rows for the header (1), the bottom occupant, and one safety line so the
  // total output stays STRICTLY below the terminal height. Rendering exactly `rows`
  // lines makes the terminal scroll and corrupts Ink's redraw (the top walks off-screen).
  //
  // The reply box is the one occupant whose height varies: its chrome (border ×2,
  // the "reply to" label, and the optional question line) plus one row per line of
  // typed text. We reserve rows for the actual number of typed lines so the frame
  // never overflows — but cap the input area so a very long reply shrinks the log
  // body instead of pushing the frame past the terminal (the real flicker cause).
  const inputQuestion = selected?.getInfo().question;
  const inputChrome = 2 + 1 + (inputQuestion ? 1 : 0); // borders + label + optional question
  // Keep the log body usable; whatever rows remain can host the input text.
  const maxInputLines = Math.max(1, rows - 2 - 1 - inputChrome - 6);
  const inputLines = Math.min(maxInputLines, replyValue.split('\n').length);

  const overlayRows =
    confirmingQuit ? 4
    : approvalPending ? 6
    : mode === 'input' ? inputChrome + inputLines
    : 1;
  const bodyHeight = Math.max(6, rows - 2 - overlayRows);

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text>
          <Text bold color="cyan">orc</Text>
          <Text dimColor> · {infos.length} agent(s) · {config.projects.length} project(s)</Text>
        </Text>
      </Box>

      <Box>
        <Sidebar infos={infos} selectedIndex={selectedIndex} />
        <AgentView
          session={selected}
          height={bodyHeight}
          width={(stdout?.columns ?? 100) - 36}
          active={mode === 'list' && !approvalPending}
        />
      </Box>

      {confirmingQuit ? (
        <QuitConfirm agentCount={infos.length} />
      ) : approvalPending && selected ? (
        <ApprovalModal
          agentName={selected.name}
          pending={approvalPending}
          onDecide={(ok) => selected.resolveApproval(ok)}
        />
      ) : mode === 'input' && selected ? (
        <InputBar
          agentName={selected.name}
          question={inputQuestion}
          value={replyValue}
          onChange={setReplyValue}
          maxLines={maxInputLines}
          onCancel={() => setMode('list')}
          onSubmit={(text) => {
            selected.send(text);
            setMode('list');
          }}
        />
      ) : (
        <HelpBar notice={notice} />
      )}
    </Box>
  );
}

function QuitConfirm({ agentCount }: { agentCount: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text bold color="red">Quit orc?</Text>
      <Text dimColor>
        This stops {agentCount} agent(s) and exits.
      </Text>
      <Text>
        <Text color="green">y</Text> quit · <Text color="red">n</Text> cancel
      </Text>
    </Box>
  );
}

function HelpBar({ notice }: { notice: string }) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>
        <Text bold>global</Text> n:new ↑↓/jk:switch h/l:parent/child w:next waiting J/K:scroll p:pause/resume scroll q:quit tui
        {'  ·  '}
        <Text bold>agent</Text> i:answer r:resume m:merge x:stop d:delete
      </Text>
      {notice ? (
        <Text color="yellow" wrap="truncate">
          {notice.replace(/\s+/g, ' ').trim()}
        </Text>
      ) : null}
    </Box>
  );
}
