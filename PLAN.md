# Plan: per-agent interactive shell panes (side-by-side, focus-stays-on-orc)

## Goal (confirmed with user: 1a + 2a + 3a + layout A)

Replace the single shared "viewer" pane + respawn-driver model with **one persistent
interactive shell pane per agent**, shown side-by-side with the always-visible orc TUI:

1. **1a** – each agent's pane is a REAL interactive `bash -i` in that agent's worktree; the
   user can type into it, and it also shows the agent's own injected commands + output.
2. **2a** – selecting an agent in the TUI REVEALS that agent's shell on the right but keeps
   keyboard focus on the orc TUI pane (the user grabs the shell with a tmux key to type).
3. **3a** – each agent's shell is long-lived and never respawned/killed on switch, so its
   scrollback is preserved. Switching agents swaps WHICH shell occupies the right slot.
4. **Layout A** – TUI left, selected agent's shell right, swapped via `break-pane`/`join-pane`.

The agent tool `mcp__orc__run` must still inject a command into the agent's shell and capture
its combined output + exit code, coexisting with user typing.

## Root cause of the three current bugs

All in the single shared viewer pane that runs a FIFO driver loop, respawned per switch:
- **Shell not usable**: `buildDriverScript` (`paneRun.ts:48`) does `while :; do read -r id b64 <
  "$FIFO"` — the loop owns stdin reading the FIFO, so the user can never type a shell command.
- **Focus on orc**: `showAgent` (`TmuxController.ts:244`) deliberately `select-pane`s back to
  orc after each respawn, so focus never reaches the viewer (commit `ea16dc3`, by design).
- **Cleared on switch**: `showAgent` uses `respawn-pane -k` (`TmuxController.ts:241`), killing +
  restarting the pane each switch, wiping scrollback.

## Layout strategy (tmux)

- Window `orc:0`: pane 0 = orc TUI (left), pane 1 = the reusable "stage" right slot where the
  currently selected agent's shell is joined.
- Each agent owns a **background window** `orc-agent-<slug>` running a single long-lived
  `bash -i` in its worktree cwd, created on `registerAgent`, killed on `unregisterAgent`. A
  separate window keeps the shell running + scrollback intact while not shown.
- `showAgent(id)` swaps the stage:
  1. If another agent currently occupies the right stage pane, `break-pane -d` it back to its
     own background window (preserves the shell + scrollback).
  2. `join-pane -h -s <agent-window-pane> -t <orc-tui-pane>` to pull the selected agent's shell
     into the right slot beside the TUI.
  3. `select-pane -t <orc-tui-pane>` LAST so focus returns to the TUI (requirement 2a).
- Nothing is respawned/cleared on switch → scrollback preserved (3a). `respawn-pane` removed.

Rationale vs alternatives: a separate window per agent is the only way tmux keeps N shells
alive without showing them all; `break-pane`/`join-pane` relocate a *live* pane between windows
without restarting it, giving TUI+shell side-by-side AND preservation.

## Command capture while interactive (send-keys + sentinels + pipe-pane)

The shell stays interactive (`bash -i`), so we cannot own its stdin with a FIFO `read` loop.
Instead:

- On agent-window creation, start capturing that pane to a per-agent file:
  `pipe-pane -o -t <pane> "cat >> <capturePath>"`.
- `runInPane(agentId, cmd, signal)`:
  1. Generate a `runId`. Record current capture-file size as `startOffset`.
  2. Inject via `send-keys`, bracketing with sentinels + an rc marker. The injected line:
     `printf '\n<<<ORC-BEGIN runId>>>\n'; ( <cmd> ); printf '\n<<<ORC-END runId %s>>>\n' "$?"`
     sent as `send-keys -t <pane> -l '<line>'` then `send-keys -t <pane> Enter`.
     (`-l` sends text literally so tmux doesn't interpret shell metacharacters.)
  3. Wait (fs.watch + 100ms poll + abort) until the capture file contains the matching
     `<<<ORC-END runId RC>>>` past `startOffset`.
  4. Extract bytes between the BEGIN and END sentinels, strip sentinel lines, `capOutput`,
     parse RC, return `{ output, rc }`.
  5. On abort: `send-keys -t <pane> C-c`, read captured-so-far, rc 130.
- The command runs in the user's own interactive shell so they see it run; the user's own
  typing interleaves naturally; sentinels keep the agent's run unambiguously parseable.

## Files & changes

### `src/tmux/paneRun.ts`
- REMOVE: `buildDriverScript`, `encodeRunLine`, `decodeRunLine`, `writeRunLine`,
  `decidePaneVsFallback`, `sleepSync` (FIFO-specific).
- ADD:
  - `encodeInjectedCommand(runId, cmd): string` – the bracketed shell line above.
  - `beginSentinel(runId)`, `endSentinelRe(runId)` – pure helpers.
  - `parseCapturedRun(buf, runId, fromOffset): { output; rc } | null` – pure; finds BEGIN/END
    for `runId` after `fromOffset`, returns extracted output + rc, or null if END absent.
  - `waitForCapture(capturePath, runId, fromOffset, signal): Promise<{output; rc}>` – fs.watch
    on the file's dir + 100ms poll + abort (same shape as today's `waitForDone`), resolving via
    `parseCapturedRun` once END appears.
- KEEP unchanged: `capOutput`, `slicePaneText`. Remove `parseDoneRc`/`waitForDone` if dead.

### `src/tmux/TmuxController.ts`
- Path helpers: KEEP `paneSlug`, `paneLogPath`. REMOVE `paneFifoPath`, `paneDoneDir`,
  `paneIdsDir`. ADD `paneCapturePath(logsDir, id)`.
- argv builders:
  - REMOVE `argvRespawnViewer` (and `argvSplitRight` if unused). KEEP `argvSplitRightPrint`.
  - ADD `argvNewWindow(session, name, cwd, cmd)` →
    `['new-window','-d','-P','-F','#{pane_id}','-t',session,'-c',cwd,'-n',name,cmd]`.
  - ADD `argvBreakPane(srcPaneId)` → `['break-pane','-d','-s',srcPaneId]`.
  - ADD `argvJoinPane(srcPaneId, dstPaneId)` → `['join-pane','-h','-s',srcPaneId,'-t',dstPaneId]`.
  - ADD `argvKillWindow(target)`.
  - ADD `argvSendKeysLiteral(paneId, text)` → `['send-keys','-t',paneId,'-l',text]`;
    `argvSendKeysEnter(paneId)` → `['send-keys','-t',paneId,'Enter']`.
  - KEEP `argvPipePane`, `argvSendInterrupt`, `argvSelectPane`, `argvKillPane`, session builders.
- State: replace `viewPaneId` with:
  - `orcPaneId?: string`, `stagePaneId?: string` (right pane joined to orc:0),
  - `agentPanes: Map<agentId, { paneId; window }>`, `selectedId?: string`.
- `registerAgent(id, name, template, cwd)`:
  - Create a background window `orc-agent-<slug>` running `bash -i` in `cwd` via `argvNewWindow`,
    capture its pane id into `agentPanes`.
  - Start capture `argvPipePane(paneId, "cat >> <paneCapturePath>")`.
  - Best-effort: on failure leave agent paneless (runInPane falls back in-process).
- `unregisterAgent(id)`: `argvKillWindow` the agent's window, remove capture file + map entry.
- `showAgent(id)`: the break/join/select-pane swap above; no-op until panes known; records
  `selectedId`.
- `runInPane(agentId, cmd, signal)`: only when `selectedId === agentId` and the agent occupies
  the stage; inject + `waitForCapture`; return `{output, rc}` or null to fall back; C-c on abort.
- `adopt()`/`adoptInside()`/`bootstrapAndReexec()`: set `orcPaneId`, establish a reusable empty
  `stagePaneId` (one split right of the TUI); keep "never touch the user's own pane" guarantee
  in `adoptInside`. First `showAgent` joins the first agent's shell into the stage slot.
- `shutdown()`/`shutdownSync()`: kill all agent windows + the stage pane (bootstrap) or just our
  own panes/windows (inside); clean capture files.

### `src/agent/AgentManager.ts`
- `registerAgent` call site (~396): pass the agent's cwd to `tmux.registerAgent` — use
  `session.worktree` when present, else the project base repo path. (If an agent adopts a
  worktree later, v1 keeps the base-repo cwd; a follow-up can inject a `cd`.)
- `runInPaneFor` (~645): unchanged in shape (tries `tmux.runInPane` for selected agent, else
  `runInProcess`). In-process fallback for unselected agents / tmux-off stays as-is.
- `Tmux` interface: `registerAgent` gains a `cwd` param; `runInPane`/`showAgent`/`unregisterAgent`
  unchanged.

### `src/index.tsx`
- No mode-detection change. `adopt`/`adoptInside` now also establish the stage pane. Restore,
  render, shutdown unchanged.

### `src/ui/App.tsx`
- No change: the existing `useEffect` → `manager.showAgentInPane(selectedId)` already drives
  `showAgent`; all behavior change is inside the controller.

## Tests

### `tests/paneRun.test.ts` (new unit tests, pure)
- `encodeInjectedCommand` yields a single line containing BEGIN+END sentinels with runId, the
  `$?` marker, and the verbatim cmd.
- `parseCapturedRun`: null when END absent; extracts exactly between BEGIN/END stripping
  sentinel lines; parses rc (0, non-zero, non-numeric → sentinel); respects `fromOffset`;
  tolerates interleaved user text.
- Retain `capOutput` / `slicePaneText` tests.

### `tests/tmuxController.test.ts` (rewrite)
- DELETE old-design groups: `argvRespawnViewer`, "showAgent respawns the DRIVER", fifo/done/ids
  path builders, FIFO + dir lifecycle, "pulls focus back after respawn", the dynamic-import RED
  block referencing fifo/done/ids + driver.
- KEEP + ADAPT: `paneSlug`, `paneLogPath`, `detectMode`, `buildReexecArgv`, `parsePanes`, generic
  argv builders.
- ADD with the fake runner:
  - argv shape tests for new-window/break-pane/join-pane/kill-window/send-keys-literal.
  - `registerAgent` issues `new-window` (captures pane id) + `pipe-pane` capture; `unregisterAgent`
    issues `kill-window`.
  - `showAgent` swap sequence A→B: `break-pane` A, `join-pane` B into the stage, then
    `select-pane` the ORC pane LAST (focus stays on orc; never selects the shell).
  - `runInPane` returns null when not selected / no stage pane.
- Capture-parsing integration (bash, no tmux): append BEGIN/…/END to a capture file; assert
  `waitForCapture` resolves with correct output+rc and aborts cleanly.

### `tests/paneRunDriver.test.ts`
- Replace FIFO-driver integration with capture-file integration exercising
  `encodeInjectedCommand` + `parseCapturedRun` + `waitForCapture` against real bash appending
  sentinel-wrapped output to a file (no tmux). Keep abort + "second run parses independently".

## Verification
1. `npm run typecheck` (tsc --noEmit) – clean.
2. `npm run lint` – clean.
3. `npm test` – all green.
4. Manual E2E in tmux: bootstrap orc on a plain TTY, create 2 agents, confirm:
   - each agent has its own right-hand shell you can focus (tmux key) and type into;
   - selecting A then B swaps the right pane WITHOUT clearing A's scrollback (back to A shows
     prior output intact);
   - after selecting, focus is on the orc TUI (j/k navigates the list, not the shell);
   - an agent `run` tool call shows the command in that agent's pane and returns correct output
     + exit code.

## Out of scope / follow-ups
- Re-`cd`ing an agent's shell on later worktree adoption (v1 uses the known-at-register cwd).
- Many-agent window clutter beyond the single stage slot (background windows hidden; fine).
