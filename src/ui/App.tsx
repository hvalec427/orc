import { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { OrcConfig } from '../types.js';
import type { AgentManager } from '../agent/AgentManager.js';
import { Sidebar } from './Sidebar.js';
import { AgentView } from './AgentView.js';
import { InputBar } from './InputBar.js';
import { NewAgentForm } from './NewAgentForm.js';
import { ApprovalModal } from './ApprovalModal.js';
import { ProjectsView } from './ProjectsView.js';

type Mode = 'list' | 'new' | 'input' | 'projects';

export function App({ manager, config }: { manager: AgentManager; config: OrcConfig }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 30;

  const [, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string>('');
  const [confirmingQuit, setConfirmingQuit] = useState(false);

  // Re-render whenever any agent updates.
  useEffect(() => {
    const onUpdate = () => setTick((t) => t + 1);
    const onLog = (m: string) => setNotice(m);
    manager.on('update', onUpdate);
    manager.on('log', onLog);
    return () => {
      manager.off('update', onUpdate);
      manager.off('log', onLog);
    };
  }, [manager]);

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
      if (input === 'p') {
        setMode('projects');
        return;
      }
      if (manager.list().length === 0) return;

      if (key.downArrow || input === 'j' || input === 'l' || key.tab) select(selectedIndex + 1);
      else if (key.upArrow || input === 'k' || input === 'h') select(selectedIndex - 1);
      else if (input >= '1' && input <= '9') select(Number(input) - 1);
      else if (input === 'w') {
        const waiting = manager.firstWaiting();
        if (waiting) setSelectedId(waiting.id);
      } else if (input === 'i' || key.return) {
        if (selected) setMode('input');
      } else if (input === 'x') {
        void selected?.stop();
      } else if (input === 'r') {
        selected?.retry();
      } else if (input === 'd' && selected) {
        const id = selected.id;
        setNotice(`removing ${id}…`);
        void manager.remove(id).then(() => setNotice(`removed ${id}`));
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

  if (mode === 'projects') {
    return <ProjectsView projects={manager.projects()} onExit={() => setMode('list')} />;
  }

  if (mode === 'new') {
    return (
      <NewAgentForm
        projects={manager.projects()}
        onCancel={() => setMode('list')}
        onSubmit={(project, name, ticket, prompt, magicLink) => {
          setMode('list');
          setNotice(`creating "${name}" in ${project}…`);
          manager
            .create(project, name, ticket, prompt, magicLink)
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
  const overlayRows = confirmingQuit ? 4 : approvalPending ? 6 : mode === 'input' ? 5 : 1;
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
          question={selected.getInfo().question}
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
        n:new p:projects ↑↓/hjkl:switch J/K:scroll 1-9:jump w:waiting i:answer r:resume x:stop d:remove q:quit
      </Text>
      {notice ? <Text color="yellow">{notice}</Text> : null}
    </Box>
  );
}
