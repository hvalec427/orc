# Plan: let agents read any pane and watch long-running commands live

## Goal
Agents should be able to:
1. **See all other panes** — read the current output buffer of any agent (across all groups).
2. **Watch long-running commands evolve in real time** — start a command non-blocking and re-read its
   growing output.

## Key facts from the codebase
- orc uses **one** shared tmux viewer pane; only the *selected* agent is live in it. Every other agent
  runs in-process (`AgentManager.runInProcess`, `AgentManager.ts:641`). **There are no N persistent
  panes.**
- BUT every agent already continuously mirrors all command output to a per-agent **pane log file** at
  `~/.orc/panes/<slug>.log` (written at `AgentManager.ts:646`; slug via `paneSlug`,
  `TmuxController.ts:24`; path via `paneLogPath`, `TmuxController.ts:29`). The live FIFO driver also
  prints to the same pane. **This log file IS the readable "pane buffer" for every agent.**
- Tools are in-process MCP tools on the "orc" server, assembled per session at `AgentSession.ts:857-887`
  and built in `src/agent/orchestratorTools.ts`.
- Read-only enforcement is template-based (`isReadOnlyTemplate`, `types.ts:90`) and enforced both in
  `buildRunTool` (`orchestratorTools.ts:374`) and the `canUseTool` guard
  (`AgentSession.decideReadOnlyTool`, `AgentSession.ts:905-932`).
- `mcp__orc__run` is currently **blocking** (`runInPaneFor` awaits the driver done-file / child close).

## Decisions (confirmed with user)
- **1A** Non-blocking run + poll the pane log (works for selected AND unselected agents).
- **2B** An agent may read ANY agent's pane log (all groups) — superset of group scope.
- **3A** Read-only agents also get the new read/list tools. Background **run** still obeys the
  read-only command filter.

## Design

### New capability A — read any agent's pane buffer
Add a manager method `readPaneLog(agentId, { tailBytes?, sinceOffset? })` on `AgentManager` that:
- Resolves the target agent from `this.agents` (returns a clear error if unknown).
- Reads `paneLogPath(join(homedir(), '.orc','panes'), agentId)`.
- Supports two read modes for polling:
  - `tailBytes` (default e.g. 8KB): return the last N bytes (a snapshot of recent output).
  - `sinceOffset`: return only bytes after a byte offset, plus the new `nextOffset`, so an agent can
    poll incrementally without re-reading the whole log.
- Caps returned text with `capOutput`.
- Returns `{ text, size, nextOffset }` (size = current file length, for offset bookkeeping).

Add a manager method `listPanes()` returning, for every agent in `this.agents`:
`{ id, name, template, status, group/parent info, logBytes }` — so an agent can discover which panes
exist and their ids before reading one.

### New capability B — non-blocking (background) run + poll
Current `runInProcess` resolves only on child `close`. Add a background mode:
- Add `startBackground(id, cmd) -> { runId }` on `AgentManager`:
  - Spawns `bash -c cmd` (same stdin=/dev/null safety as `runInProcess`), **does not await close**.
  - Streams stdout+stderr to the agent's pane log (reusing the existing append-to-log path) AND to an
    in-memory/file ring so output is pollable.
  - Tracks running jobs in a `Map<runId, { child, status, rc? }>` keyed per agent; records rc on close.
  - For the *selected* agent, still drive via the tmux pane when possible; otherwise in-process. (The
    pane-driver path is inherently blocking on the FIFO done-file, so background runs use the
    in-process streamer which already mirrors to the same pane log the human sees. Keep this simple:
    background = in-process streamer; foreground selected = existing live pane path. Output is visible
    either way because both write the pane log.)
- Add `pollBackground(id, runId) -> { status, rc?, newOutput, nextOffset }` and
  `stopBackground(id, runId)` (sends SIGINT/term, like the abort path).

### New MCP tools (in `orchestratorTools.ts`, "orc" server)
1. `mcp__orc__list_panes` — list all agents + their pane metadata (id, name, template, status, logBytes).
2. `mcp__orc__read_pane` — args `{ agentId, tailBytes?, sinceOffset? }`; returns recent/incremental
   output + `nextOffset`. For live watching, the agent calls repeatedly with the returned offset.
3. `mcp__orc__run_background` — args `{ command }`; starts a non-blocking command for THE CALLING
   agent, returns `{ runId }`. Obeys the read-only command filter (same `isReadOnlyBashCommand` gate as
   `buildRunTool`).
4. `mcp__orc__poll_background` — args `{ runId }`; returns `{ status, rc?, newOutput, nextOffset }`.
5. `mcp__orc__stop_background` — args `{ runId }`; stops the background command.

(Reading tools 1–2 are available to all agents incl. read-only; tool 3 applies the read-only command
filter; 4–5 are read/control of the caller's own jobs.)

### Wiring
- Extend the orchestration callbacks object (`AgentManager.orchestrationCallbacks`, `AgentManager.ts:677`
  and the matching type in `orchestratorTools.ts`) with: `listPanes`, `readPane`, `runBackground`,
  `pollBackground`, `stopBackground` — each a closure capturing the agent `id` where needed
  (background runs are scoped to the caller's id; read/list can target any id).
- In `AgentSession` tool assembly (`AgentSession.ts:857-887`), add the new builders to `orcTools`.
- In `AgentSession.decideReadOnlyTool` (`AgentSession.ts:905-932`): allow the new read/list/poll/stop
  tools for read-only agents (add their names to the allowed set, like `ORCHESTRATION_TOOLS`); gate
  `run_background` through `isReadOnlyBashCommand` exactly like `mcp__orc__run`.
- Add tool names to `ORCHESTRATION_TOOLS`/allowed set so the `canUseTool` guard doesn't deny them.

### Tool descriptions
Clear, self-contained descriptions explaining: read_pane shows another pane's recent output; to WATCH
a long-running command, start it with run_background, then call read_pane/poll_background repeatedly
using the returned nextOffset to see new output as it arrives.

## Files to change
- `src/agent/orchestratorTools.ts` — new tool builders + callback types.
- `src/agent/AgentManager.ts` — `readPaneLog`, `listPanes`, background job map + start/poll/stop,
  extend `orchestrationCallbacks`.
- `src/agent/AgentSession.ts` — assemble new tools; update read-only allow-list / gating.
- (Possibly) `src/tmux/TmuxController.ts` — only if we expose a helper; likely not needed since we read
  the existing pane log file directly.

## Tests (follow existing patterns in `tests/`)
- `tests/orchestratorTools.test.ts` — unit-test each new tool builder: list_panes formats agents;
  read_pane returns tail + incremental slice via offset; run_background returns runId and is refused
  for read-only state-changing commands; poll_background reports status/rc/newOutput; stop_background
  stops. Use stub callbacks like existing tool tests.
- `tests/paneRun.test.ts` or a new `tests/paneLog.test.ts` — unit-test the pure read/slice logic
  (tail by bytes, slice since offset, nextOffset bookkeeping, capping).
- `tests/agentManagerTmux.test.ts` — integration: start a background command, poll it to completion,
  read another agent's pane log by id, assert incremental offset reads only return new bytes.
- `tests/readonlyPermissions.test.ts` — assert read-only agents may call read_pane/list_pane but
  run_background obeys the command filter.

## Verification
Run the project's typecheck, lint, and full test suite; fix until green. Confirm no unrelated diff.

## Out of scope
- No new persistent tmux panes; no `tmux capture-pane` (can't read unselected agents anyway).
- No change to the blocking semantics of the existing `mcp__orc__run` (background is a separate tool).
