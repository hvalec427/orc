# orc

A terminal UI for orchestrating several **Claude Code agents in parallel**, each building one
feature/ticket of a mobile (React Native) app. Every agent gets its own identity:

- a **name** (also used to name its iOS simulator),
- a **ticket** (the task it works on),
- a dedicated **git worktree** + branch,
- its own **Metro port**, and
- its own **iOS simulator**, driven via the **Maestro MCP** server.

One `orc` instance knows about several **projects** (from a central config mapping nice names to repo
paths). When you start an agent you first pick its project; agents from different projects then
coexist in one sidebar. From that one screen you watch each agent's live progress, toggle between
them, and answer questions they raise — per agent, in the same session.

## How it works

Each agent is a streaming [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
session (`query()` with a push-able async input queue). For the project you pick, orc:

- creates `git worktree add <repo>/.worktrees/<name> -b agent/<name>` in that project's repo,
- allocates a free port from the project's `portRange` (if set) and injects it as `METRO_PORT`/`AGENT_PORT` plus `AGENT_NAME` into the session env,
- attaches the Maestro MCP server,
- appends an orchestration addendum to the worktree's own `CLAUDE.md` (loaded via
  `settingSources`), and streams the agent's output live into the UI.

The agent talks back to you with two sentinels (defined in the appended prompt):

- `@@NEEDS_INPUT@@` — the agent needs a decision; the sidebar flags it. Your typed reply is
  delivered into the **same** session and it continues.
- `@@DONE@@ <commit>` — the task is finished.

Put the mobile agent instructions (simulator/Metro/Maestro/completion rules) in the base repo's
`CLAUDE.md`; orc only injects per-agent identity and the human-in-the-loop protocol on top. You can
install that `CLAUDE.md` into a project from inside the TUI — press `p`, pick the project, press `c`
(it asks before overwriting an existing one). The template installed matches the project's `type`
(`react-native`, `web`, or `orc`); see `examples/{mobile,web,orc}-CLAUDE.md`.

orc **never writes your config** (`~/.orc/config.json`) — you create and edit it yourself. The only
file orc writes under `~/.orc` is `state.json` (runtime agent state).

## Install

One command — clone, build, install a version-independent `orc` launcher, and scaffold the config:

```bash
git clone git@github.com:hvalec427/orc.git ~/dev/orc && cd ~/dev/orc && ./install.sh
```

`install.sh` is idempotent and nvm-safe: it pins the launcher to the Node it finds so `orc` keeps
working even when a project switches Node versions. Then edit `~/.orc/config.json` and run `orc`.

Requires Node ≥ 20, the `claude` CLI logged in, and (for the mobile flow) `xcrun`, a React Native
app, and the Maestro MCP server on your `PATH`.

<details>
<summary>Manual install (no script)</summary>

```bash
npm install        # auto-builds via the prepare script
npm link           # global `orc` for the active Node version
# or run from source without installing:  npm run dev
```
</details>

## Setup

Create `~/.orc/config.json` listing your projects (see `examples/config.json`):

```json
{
  "model": "claude-opus-4-8",
  "permissionMode": "bypassPermissions",
  "settingSources": ["user", "project", "local"],
  "maestroMcp": { "command": "maestro", "args": ["mcp"] },
  "projects": [
    { "name": "Acme iOS", "path": "~/dev/acme-app", "portRange": "8000-8099" },
    { "name": "Beta App", "path": "~/dev/beta", "model": "claude-sonnet-5", "portRange": "8100-8199" }
  ]
}
```

Top-level keys are global defaults; each project may override `model`, `worktreeDir`,
`permissionMode`, `settingSources`, `portRange`, and `maestroMcp`. Paths may use `~`. Give each
project its own `portRange` (e.g. `8000-8099`, `8100-8199`) so parallel agents don't collide;
projects without a range get no port.

## Usage

```bash
orc                              # uses ~/.orc/config.json
orc --config ./my-config.json    # alternate config
orc --model claude-opus-4-8      # override model for all agents
orc --no-maestro                 # don't attach the Maestro MCP server
```

Press `n` to start an agent: pick a **project**, a **name**, an optional **ticket** (a reference like
`PROJ-123` that the agent weaves into its commit message), and a **prompt** (what the agent should
actually do). Steer it afterward with `i`.

### Keys

| Key            | Action                                          |
| -------------- | ----------------------------------------------- |
| `n`            | new agent (pick project, then name + ticket)    |
| `p`            | projects: install mobile CLAUDE.md into a repo   |
| `↑`/`↓`, `Tab`, `hjkl` | switch selected agent                   |
| `J` / `K`      | scroll the log down / up · `G` jumps back to live |
| `1`–`9`        | jump to the nth agent                           |
| `w`            | jump to the next agent waiting on you           |
| `i` / `Enter`  | answer the selected agent                       |
| `r`            | resume a crashed/finished agent (same session)  |
| `x`            | stop (interrupt) the selected agent             |
| `d`            | remove the agent + its worktree                 |
| `q`            | quit (stops all agents)                         |

When an agent is in `default` permission mode and a tool needs approval, press `y`/`n`.

### Merging an agent

Merging is done by a dedicated **merge agent**, not a keybinding. When an agent reports `@@DONE@@`,
start a new agent with `n`, pick the **Merge** template, and tell it which branches to merge (e.g.
`merge agent/foo into master`). The merge agent runs directly in the base repo (no worktree), so it
can't delete the directory it's running in. (A feature agent asked to merge *itself* would
`git worktree remove` its own working directory mid-command and permanently break its shell; that's
why feature agents are told never to self-merge.)

- If a merge hits a **conflict** it can't safely resolve, the merge agent runs `git merge --abort`,
  leaves the repo clean, and asks you how to proceed — nothing is left half-merged.
- After a branch merges cleanly, the merge agent removes its worktree and deletes the now-merged
  branch.
- The merge agent won't push to any remote unless you explicitly ask.

## Config reference

Config lives in `~/.orc/config.json` (or `--config <path>`). Fields:

- `projects` (required): `[{ name, path, type, ...overrides }]` — the projects you launch agents into.
- `type` (per project): `react-native` (default), `web`, or `orc`. Only used to pick which CLAUDE.md
  template the `p` action installs.
- `permissionMode`: `bypassPermissions` (default, fully autonomous per the mobile CLAUDE.md),
  `acceptEdits`, or `default` (routes tool approvals to the UI via `y`/`n`). Overridable per project.
- `settingSources` **must include `project`** for the worktree's `CLAUDE.md` to load. Overridable.
- `model`, `worktreeDir`, `maestroMcp`: global defaults, overridable per project.
- `magicLink` (per project, optional): a sign-in deep link. If set, the new-agent form offers a step
  to accept it (Enter) or type a different one for that agent; the link is passed as `MAGIC_LINK` and
  the agent opens it on its simulator to log in. Projects without one skip that step.
- `portRange` (per project, optional): a `"start-end"` range like `"8000-8099"`. orc allocates a free
  port from it per agent and injects `METRO_PORT`/`AGENT_PORT`. Give each project a distinct range.
  Omit it for projects whose agents don't need a port; if such an agent needs one, it asks you to add
  a range. Can also be set globally as a fallback.
- `maestroMcp`: adjust to however your server launches; omit / `--no-maestro`.

Agent metadata (tagged with project) is mirrored to `~/.orc/state.json`.

## Notes / limits

- If an agent's `claude` subprocess crashes (status `error`), the session isn't lost: press `r` (or
  just answer it with `i`) to **resume the same Claude session** via `resume: <sessionId>` and
  continue with full history. The same works to reopen a `done` agent.
- Live agent sessions run in-process; they don't survive an `orc` restart (the `sessionId` is
  persisted to `~/.orc/state.json`, so resuming across restarts is a small future addition).
- orc runs in the terminal's alternate screen buffer (like vim/htop): it owns a full-screen
  viewport and restores your shell (with scrollback intact) on exit.
- The log pane is a fixed-height viewport (the layout never jumps as text streams). It follows the
  live tail by default; press `K`/`J` to scroll up/down and `G` to jump back to live.

## Project layout

```
src/
  index.tsx              CLI entry + Ink render
  config.ts              config load/validate (zod)
  ports.ts               Metro port allocator
  worktree.ts            git worktree add/remove
  agentPrompt.ts         orchestration addendum + sentinels
  types.ts               shared domain types
  agent/
    InputQueue.ts        push-able async input stream
    AgentSession.ts      one query() session: streaming, status, sentinels
    AgentManager.ts      registry + worktree/port lifecycle + persistence
  ui/                    App, Sidebar, AgentView, InputBar, NewAgentForm, ApprovalModal
```
