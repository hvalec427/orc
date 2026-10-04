import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { OrcConfig, AgentStatus, AgentInfo } from '../types.js';
import type { AgentManager } from '../agent/AgentManager.js';
import { Sidebar } from './Sidebar.js';
import { AgentView } from './AgentView.js';
import { InputBar } from './InputBar.js';
import { NewAgentForm } from './NewAgentForm.js';
import { ApprovalModal } from './ApprovalModal.js';
import { visualRows, inputChrome as inputChromeFor, inputWidthFor, overlayRowsFor, bodyHeightFor } from './layout.js';
import { subscribeRoster } from './subscriptions.js';
import { debounce } from './debounce.js';
import { buildPreviewInstructions } from '../previewInstructions.js';

type Mode = 'list' | 'new' | 'input' | 'preview';

export function App({ manager, config }: { manager: AgentManager; config: OrcConfig }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 30;

  const [mode, setMode] = useState<Mode>('list');
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string>('');
  const [confirmingQuit, setConfirmingQuit] = useState(false);
  // When the new-agent form is opened via `c`, this holds the group-root id the new agent should be
  // nested under as a subagent. Undefined means the form creates a top-level agent (opened via `n`).
  const [subagentParentId, setSubagentParentId] = useState<string | undefined>(undefined);
  // Reply text is held here (not inside InputBar) so the layout can reserve rows
  // for exactly as many lines as the user has typed — keeping the whole frame
  // below the terminal height and avoiding the scroll/redraw flicker.
  const [replyValue, setReplyValue] = useState('');
  // Whether the sidebar's collapsible "Done" section is expanded. When collapsed, archived agents
  // are hidden (only a "Done (N)" header shows) and are not part of the navigable list.
  const [showDone, setShowDone] = useState(false);

  // Per-slice subscription for the roster/status: App re-renders only when the set of agents OR any
  // agent's getInfo() snapshot changes identity. Because getInfo() is memoized (stable identity
  // unless a status/field it exposes changed), a pure CONTENT update (a token-delta pushEntry that
  // bumps eventsVersion but not getInfo) leaves this snapshot unchanged, so the whole App tree does
  // NOT repaint — that's the flicker fix. The AgentView subscribes to its own eventsVersion slice to
  // pick those content updates up for the selected agent only.
  const rosterStore = useRef<{ version: number; infos: readonly AgentInfo[] }>({ version: 0, infos: [] });
  const rosterSnapshot = () => {
    // Build the current ordered getInfo() identities (cheap: getInfo is memoized). Bump the cached
    // version only when they differ from the last observed set, so getSnapshot returns a stable
    // primitive between unrelated (content-only) updates — React requires getSnapshot be cached.
    const infos = manager.list().map((a) => a.getInfo());
    const prev = rosterStore.current.infos;
    let changed = infos.length !== prev.length;
    if (!changed) for (let i = 0; i < infos.length; i++) if (!Object.is(infos[i], prev[i])) { changed = true; break; }
    if (changed) rosterStore.current = { version: rosterStore.current.version + 1, infos };
    return rosterStore.current.version;
  };
  useSyncExternalStore(
    (onChange) => subscribeRoster(manager as unknown as Parameters<typeof subscribeRoster>[0], onChange),
    rosterSnapshot,
    rosterSnapshot,
  );

  // Surface the manager's log lines as the transient notice.
  useEffect(() => {
    const onLog = (m: string) => setNotice(m);
    manager.on('log', onLog);
    return () => {
      manager.off('log', onLog);
    };
  }, [manager]);

  // Recompute the layout on terminal resize, but debounced: a drag-resize fires a storm of 'resize'
  // events, and repainting the whole frame on each one flickers. Coalesce them into one trailing
  // re-render. resizeTick is otherwise unused — bumping it just forces this component to re-read
  // stdout.rows/columns and recompute the height math.
  const [, setResizeTick] = useState(0);
  useEffect(() => {
    if (!stdout) return;
    const onResize = debounce(() => setResizeTick((t) => t + 1), 100);
    stdout.on('resize', onResize);
    return () => {
      onResize.cancel();
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // The ONE flat navigable list: active agents, plus archived ones only while the Done section is
  // expanded. selectedIndex indexes into this list, and the Sidebar renders from the same split, so
  // selection stays aligned across the active rows and the (optional) Done rows.
  const activeAgents = manager.active();
  const archivedAgents = manager.archived();
  const agents = activeAgents.concat(showDone ? archivedAgents : []);
  const infos = agents.map((a) => a.getInfo());
  const activeInfos = activeAgents.map((a) => a.getInfo());
  const archivedInfos = archivedAgents.map((a) => a.getInfo());

  // Keep selection valid.
  const selectedIndex = Math.max(0, infos.findIndex((i) => i.id === selectedId));
  const selected = agents[selectedIndex];
  useEffect(() => {
    if (!selectedId && infos.length > 0) setSelectedId(infos[0].id);
    if (selectedId && !infos.some((i) => i.id === selectedId) && infos.length > 0) {
      setSelectedId(infos[0].id);
    }
  }, [selectedId, infos]);

  // Re-point the tmux viewer pane at whichever agent is selected (no-op when tmux is off, or when a
  // mock manager in tests lacks the method).
  useEffect(() => {
    manager.showAgentInPane?.(selectedId);
  }, [manager, selectedId]);

  const approvalPending = selected?.pendingApproval;

  // Global keys — active in list mode when no approval modal is up. Quit
  // confirmation is handled inline here (rather than a second useInput) so a
  // single keypress is never seen by two active handlers.
  useInput(
    (input, key) => {
      // While the quit popup is up, only y confirms and Esc cancels; swallow the rest.
      // Cancel is Esc-only (not `n`): `n` is also the "new agent" key, so letting it
      // dismiss the popup meant a second `n` — out of habit or because the dismiss gave
      // no feedback — immediately opened the new-agent form right after cancelling.
      if (confirmingQuit) {
        if (input === 'y') {
          void manager.stopAll().finally(exit);
        } else if (key.escape) {
          setConfirmingQuit(false);
        }
        return;
      }
      // In preview mode the body shows the run/test instructions; P or Esc closes it. Scroll keys
      // (J/K/G/p) fall through to AgentView's own handler, so we only swallow the rest here to keep
      // the overlay from also triggering list navigation/actions.
      if (mode === 'preview') {
        if (input === 'P' || key.escape) setMode('list');
        return;
      }
      if (input === 'q') {
        setConfirmingQuit(true);
        return;
      }
      if (input === 'n') {
        setSubagentParentId(undefined);
        setMode('new');
        return;
      }
      if (manager.list().length === 0) return;

      if (key.downArrow || input === 'j' || key.tab || key.upArrow || input === 'k') {
        // j/k step by position through the ONE flat navigable list (active agents, plus the archived
        // Done rows when expanded), in exactly the order the sidebar renders them. Parents and their
        // nested subagents live in that same list, so j/k simply crosses between a parent and its
        // children — no separate "enter a group" step.
        if (!selected) return;
        const delta = key.downArrow || input === 'j' || key.tab ? 1 : -1;
        const next = Math.max(0, Math.min(selectedIndex + delta, agents.length - 1));
        const target = agents[next];
        if (target) setSelectedId(target.id);
      } else if (input === 'w') {
        const waiting = manager.firstWaiting();
        if (waiting) setSelectedId(waiting.id);
      } else if (input === 'i' || key.return) {
        // Ask/reply works for ANY selected agent: send() routes a live agent's text into its
        // current turn and resumes a finished/dead one, so the human can follow up or redirect
        // at any point — not only when the agent explicitly paused for input.
        if (selected) {
          setReplyValue('');
          setMode('input');
        }
      } else if (input === 'c' && selected) {
        // Launch a subagent of the selected agent's group (see createSubagent): the new agent
        // joins the group root as a sibling so every subagent is one flat level under one
        // orchestrator parent.
        setSubagentParentId(manager.groupRootOf(selected.id).id);
        setMode('new');
      } else if (input === 'x') {
        // x pauses (keep-alive interrupt): only act on a live, non-terminal, non-paused agent.
        // pause() keeps the subprocess alive so r resumes the same session (see Shift+X to hard-kill).
        const status = selected?.getInfo().status;
        if (
          selected &&
          status !== 'done' &&
          status !== 'error' &&
          status !== 'stopped' &&
          status !== 'paused'
        ) {
          void selected.pause();
        }
      } else if (input === 'X') {
        // Shift+X hard-kills (old x behavior): interrupt + abort the subprocess. stop() no-ops once
        // dead, so only act while it's alive (a paused agent is still alive and killable).
        const status = selected?.getInfo().status;
        if (
          selected &&
          status !== 'done' &&
          status !== 'error' &&
          status !== 'stopped' &&
          status !== 'needs_login'
        ) {
          void selected.stop();
        }
      } else if (input === 'r') {
        // Resuming a now-running agent shouldn't leave it hidden in Done, so unarchive it too.
        if (selected) {
          // A paused agent resumes its LIVE session (resume); a dead one retries (relaunch/resume id).
          if (selected.getInfo().status === 'paused') {
            selected.resume();
          } else {
            selected.retry();
          }
          if (selected.getInfo().archived) void manager.unarchive(selected.id);
        }
      } else if (input === 'm' && selected) {
        const id = selected.id;
        const { branch, status, archived, parentId } = selected.getInfo();
        // Child agents share their parent's worktree/branch, so integrating them makes no sense.
        if (!branch || archived || parentId) {
          return;
        }
        // Don't integrate a branch the agent is still actively editing. Only allow
        // integrating once its turn has ended (mirrors HelpBar's canMerge gate).
        if (status === 'working' || status === 'booting') {
          return;
        }
        const existing = manager.mergeChildOf(id);
        setNotice(existing ? `integrate agent for ${branch} already running` : `integrating ${branch}…`);
        manager
          .mergeAgent(id)
          .then(() => {
            // The integrate agent is a subagent nested under the source. Stay on the source so
            // the view keeps its place instead of jumping to the freshly spawned merge child.
            if (!existing) setNotice(`integrating ${branch}`);
          })
          .catch((err) => setNotice(`integrate failed: ${(err as Error).message}`));
      } else if (input === 'C' && selected) {
        // Spawn a cleanup worker nested under the selected agent to tear down its worktree + branch.
        // The worker runs in the base repo (no worktree of its own), so it can safely remove the
        // source agent's worktree — something the agent itself can't do to its own working directory.
        const id = selected.id;
        const { branch, worktree } = selected.getInfo();
        if (!branch || !worktree) return;
        const existing = manager.cleanupChildOf(id);
        setNotice(existing ? `cleanup agent for ${branch} already running` : `cleaning up ${branch}…`);
        manager
          .cleanupAgent(id)
          .then((s) => setSelectedId(s.id))
          .catch((err) => setNotice(`cleanup failed: ${(err as Error).message}`));
      } else if (input === 'P' && selected) {
        // Show orc's generated "how to run/test this branch" instructions inside the agent window.
        setMode('preview');
      } else if (input === 'd' && selected) {
        // Archive (non-destructive): move the agent into the collapsible Done section. The session
        // keeps running and the worktree/branch/port are untouched. Move selection to a neighbour in
        // the ACTIVE list, since the archived agent leaves it.
        const id = selected.id;
        const activeIdx = activeInfos.findIndex((i) => i.id === id);
        const next =
          activeIdx === -1
            ? undefined
            : activeInfos[activeIdx + 1] ?? activeInfos[activeIdx - 1];
        if (next) setSelectedId(next.id);
        setNotice(`archived ${id}`);
        void manager.archive(id);
      } else if (input === 'D' && selected) {
        // Destructive delete (old `d` behavior): stop the session, remove the worktree, release the
        // port. Move selection to the next agent in the current navigable list (or previous).
        const id = selected.id;
        const next = infos[selectedIndex + 1] ?? infos[selectedIndex - 1];
        if (next) setSelectedId(next.id);
        setNotice(`deleting ${id}…`);
        void manager.remove(id).then(() => setNotice(`deleted ${id}`));
      } else if (input === 't') {
        // Toggle the collapsible Done section.
        setShowDone((v) => !v);
      }
    },
    // Keep the handler active whenever the quit popup is up, even if an approval is pending:
    // the popup renders with priority over the ApprovalModal, so its y/Esc must stay live or
    // an approval arriving after `q` would silently freeze the popup (y no longer quits).
    { isActive: confirmingQuit || ((mode === 'list' || mode === 'preview') && !approvalPending) },
  );

  if (mode === 'new') {
    const subagentParent = subagentParentId ? manager.get(subagentParentId) : undefined;
    return (
      <NewAgentForm
        projects={manager.projects()}
        parentName={subagentParent?.name}
        parentTicket={subagentParent?.ticket}
        onCancel={() => {
          setSubagentParentId(undefined);
          setMode('list');
        }}
        onSubmit={(template, project, name, ticket, prompt, magicLink) => {
          setMode('list');
          const parentId = subagentParentId;
          setSubagentParentId(undefined);
          setNotice(
            parentId
              ? `creating ${template} "${name}" under "${subagentParent?.name ?? parentId}"…`
              : `creating ${template} "${name}" in ${project}…`,
          );
          const launched = parentId
            ? manager.createSubagent(parentId, template, name, ticket, prompt, magicLink)
            : manager.create(project, template, name, ticket, prompt, magicLink);
          launched
            .then((s) => {
              // Only move focus for top-level agents. When launching a subagent, stay on the
              // parent so the orchestrator view keeps its place instead of jumping to the child.
              if (!parentId) setSelectedId(s.id);
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
  // the "reply to" label, and the optional question line) plus one row per VISUAL
  // line of typed text. The input renders with wrap="wrap", so a logical line wider
  // than the box soft-wraps onto extra rows — we must count those wrapped rows, not
  // just the newline count, or a long/pasted line overflows the frame and the
  // terminal scrolls (the real flicker cause). We cap the input area so a very long
  // reply shrinks the log body instead of pushing the frame past the terminal.
  const inputQuestion = selected?.getInfo().question;
  const inputChrome = inputChromeFor(!!inputQuestion); // borders + label + optional question
  // Width available to the typed text inside the InputBar: full terminal width minus
  // the box border (2) + its paddingX (2) + the input's marginLeft (2). Mirror
  // InputBar.tsx / MultilineInput.tsx; keep in sync if that chrome changes.
  const inputWidth = inputWidthFor(stdout?.columns ?? 80);
  // Keep the log body usable; whatever rows remain can host the input text.
  const maxInputLines = Math.max(1, rows - 2 - 1 - inputChrome - 6);
  const inputLines = Math.min(maxInputLines, visualRows(replyValue, inputWidth));

  // Rows reserved for the bottom overlay. This MUST equal the occupant's real rendered
  // height, and the overlay Box below is pinned to exactly this height so the two can
  // never disagree: if the frame grew while an overlay was up and then shrank when it
  // closed, Ink would leave the taller frame's trailing rows uncleared on an alt-screen
  // terminal (iTerm2) — the overlay (e.g. the quit popup) would stay ghosted on screen.
  //   - QuitConfirm: bordered box, 3 text lines → 2 + 3 = 5 rows.
  //   - ApprovalModal: 6 rows.
  //   - HelpBar: one line that can soft-wrap to a second → reserve 2 so the frame height
  //     is stable whether or not the command list wraps.
  const overlayRows = overlayRowsFor(
    confirmingQuit ? { kind: 'quit' }
    : approvalPending ? { kind: 'approval' }
    : mode === 'input' ? { kind: 'input', inputChrome, inputLines }
    : { kind: 'list' },
  );
  const bodyHeight = bodyHeightFor(rows, overlayRows);

  // While previewing, build orc's "how to run/test this branch" instructions for the selected
  // agent from its project config (type, port, magic link) and worktree. Looked up by project name
  // since the session doesn't expose its ProjectConfig directly.
  const previewText =
    mode === 'preview' && selected
      ? buildPreviewInstructions(
          selected.getInfo(),
          manager.projects().find((p) => p.name === selected.project) ?? config.projects[0],
        )
      : undefined;

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text>
          <Text bold color="cyan">orc</Text>
          <Text dimColor> · {activeInfos.length + archivedInfos.length} agent(s) · {config.projects.length} project(s)</Text>
        </Text>
      </Box>

      {/* Pin the body row to bodyHeight so neither pane can grow the frame past the terminal.
          The sidebar list is unbounded (one block per agent), so without this the sidebar —
          not the log — could make the total output taller than `rows`, scrolling the real
          terminal and walking Ink's frame off the top (the "TUI moves up" bug). flexShrink=0
          keeps it from being squeezed; the Sidebar clips/scrolls internally to this height. */}
      <Box height={bodyHeight} flexShrink={0} overflow="hidden">
        <Sidebar
          active={activeInfos}
          archived={archivedInfos}
          showDone={showDone}
          selectedIndex={selectedIndex}
          height={bodyHeight}
        />
        <AgentView
          session={selected}
          manager={manager}
          height={bodyHeight}
          width={(stdout?.columns ?? 100) - 36}
          active={(mode === 'list' || mode === 'preview') && !approvalPending}
          preview={previewText}
        />
      </Box>

      <Box height={overlayRows} flexDirection="column" flexShrink={0}>
      {confirmingQuit ? (
        <QuitConfirm agentCount={infos.length} />
      ) : approvalPending && selected ? (
        <ApprovalModal
          agentName={selected.name}
          pending={approvalPending}
          onDecide={(ok) => selected.resolveApproval(ok)}
          onRedirect={() => {
            // Deny the pending tool so the agent unblocks, then open the reply box to redirect it.
            selected.resolveApproval(false);
            setReplyValue('');
            setMode('input');
          }}
        />
      ) : mode === 'input' && selected ? (
        <InputBar
          agentName={selected.name}
          question={inputQuestion}
          value={replyValue}
          onChange={setReplyValue}
          maxLines={maxInputLines}
          inputWidth={inputWidth}
          onCancel={() => setMode('list')}
          onSubmit={(text) => {
            selected.send(text);
            // Messaging an archived (done) agent resumes it, so bring it back out of Done.
            if (selected.getInfo().archived) void manager.unarchive(selected.id);
            setMode('list');
          }}
        />
      ) : (
        <HelpBar
          notice={notice}
          hasAgents={infos.length > 0}
          hasSession={!!selected}
          hasWaiting={!!manager.firstWaiting()}
          hasWorktree={!!selected?.getInfo().worktree}
          selectedStatus={selected?.getInfo().status}
          selectedArchived={!!selected?.getInfo().archived}
          hasArchived={archivedInfos.length > 0}
          showDone={showDone}
          previewing={mode === 'preview'}
          canMerge={
            !!selected?.getInfo().branch &&
            !selected.getInfo().archived &&
            !selected.getInfo().parentId &&
            selected.getInfo().status !== 'working' &&
            selected.getInfo().status !== 'booting'
          }
        />
      )}
      </Box>
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
        <Text color="green">y</Text> quit · <Text color="red">Esc</Text> cancel
      </Text>
    </Box>
  );
}

function HelpBar({
  notice,
  hasAgents,
  hasSession,
  hasWaiting,
  hasWorktree,
  selectedStatus,
  selectedArchived,
  hasArchived,
  showDone,
  previewing,
  canMerge,
}: {
  notice: string;
  hasAgents: boolean;
  hasSession: boolean;
  hasWaiting: boolean;
  hasWorktree: boolean;
  selectedStatus: AgentStatus | undefined;
  selectedArchived: boolean;
  hasArchived: boolean;
  showDone: boolean;
  previewing: boolean;
  canMerge: boolean;
}) {
  // An agent is "dead" (retryable) when its last turn ended; stop() only does
  // something while it is still alive. Mirror AgentSession.isDead()/stop().
  // 'needs_login' is dead too: the CLI exited on an auth failure, so the human
  // re-authenticates and then resumes it like any other ended session.
  const isDead =
    selectedStatus === 'done' ||
    selectedStatus === 'error' ||
    selectedStatus === 'stopped' ||
    selectedStatus === 'needs_login';
  // A paused agent is alive (kept-alive interrupt): r resumes its live session; X still hard-kills.
  const isPaused = selectedStatus === 'paused';

  // Only list a command when pressing its key would actually do something.
  const global: string[] = ['n:new'];
  // j/k step through the single flat list, crossing freely between parents and their subagents.
  if (hasAgents) global.push('↑↓/jk:switch');
  if (hasWaiting) global.push('w:next waiting');
  // t toggles the collapsible Done section; only useful once something has been archived.
  if (hasArchived) global.push(showDone ? 't:hide done' : 't:done');
  if (hasSession) global.push('J/K:scroll', 'p:pause/resume scroll');
  global.push('q:quit tui');

  const agent: string[] = [];
  // i (ask/reply) and c (launch a subagent) work for any selected agent regardless of state.
  if (hasSession) agent.push('i:ask', 'c:subagent');
  // r resumes both a dead agent (retry) and a paused one (continue its live session).
  if (isDead || isPaused) agent.push('r:resume');
  if (canMerge) agent.push('m:integrate');
  // C spawns a cleanup worker to remove the agent's worktree + branch; only useful once it has one.
  if (hasWorktree) agent.push('C:cleanup');
  // x pauses a live, non-paused agent (keep-alive); X hard-kills any live agent (incl. paused).
  if (hasSession && !isDead && !isPaused) agent.push('x:pause');
  if (hasSession && !isDead) agent.push('X:kill');
  // P shows orc's generated "how to run/test this branch" instructions inside the agent window.
  if (hasSession) agent.push(previewing ? 'P:close preview' : 'P:preview');
  // d archives (non-destructive, into Done); Shift+D is the old destructive delete. Messaging an
  // archived agent (i:ask) resumes it and brings it back out of Done automatically.
  if (hasSession && !selectedArchived) agent.push('d:archive');
  if (hasSession) agent.push('D:delete');

  // Render each "key:description" entry with the key highlighted in yellow and
  // the description dimmed. Entries are space-separated.
  const renderCommands = (commands: string[]) =>
    commands.map((cmd, index) => {
      const sep = cmd.indexOf(':');
      const key = sep === -1 ? cmd : cmd.slice(0, sep);
      const desc = sep === -1 ? '' : cmd.slice(sep);
      return (
        <Text key={cmd}>
          {index > 0 ? ' ' : ''}
          <Text color="yellow">{key}</Text>
          <Text dimColor>{desc}</Text>
        </Text>
      );
    });

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text>
        <Text bold dimColor>
          global
        </Text>{' '}
        {renderCommands(global)}
        {agent.length > 0 ? (
          <>
            <Text dimColor>{'  ·  '}</Text>
            <Text bold dimColor>
              agent
            </Text>{' '}
            {renderCommands(agent)}
          </>
        ) : null}
      </Text>
      {notice ? (
        <Text color="yellow" wrap="truncate">
          {notice.replace(/\s+/g, ' ').trim()}
        </Text>
      ) : null}
    </Box>
  );
}
