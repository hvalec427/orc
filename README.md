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
- allocates a free `METRO_PORT` and injects it plus `AGENT_NAME` into the session env,
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
(it asks before overwriting an existing one).

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
  "basePort": 8100,
  "permissionMode": "bypassPermissions",
  "settingSources": ["user", "project", "local"],
  "maestroMcp": { "command": "maestro", "args": ["mcp"] },
  "projects": [
    { "name": "Acme iOS", "path": "~/dev/acme-app" },
    { "name": "Beta App", "path": "~/dev/beta", "model": "claude-sonnet-5" }
  ]
}
```

Top-level keys are global defaults; each project may override `model`, `worktreeDir`,
`permissionMode`, `settingSources`, and `maestroMcp`. Paths may use `~`. `basePort` is global
(Metro ports are unique machine-wide).

## Usage

```bash
orc                              # uses ~/.orc/config.json
orc --config ./my-config.json    # alternate config
orc --model claude-opus-4-8      # override model for all agents
orc --no-maestro                 # don't attach the Maestro MCP server
```

Press `n` to start an agent: pick a **project**, then enter a **name** and **ticket**.

### Keys

| Key            | Action                                          |
| -------------- | ----------------------------------------------- |
| `n`            | new agent (pick project, then name + ticket)    |
| `p`            | projects: install mobile CLAUDE.md into a repo   |
| `↑`/`↓`, `Tab` | switch selected agent                           |
| `1`–`9`        | jump to the nth agent                           |
| `w`            | jump to the next agent waiting on you           |
| `i` / `Enter`  | answer the selected agent                       |
| `x`            | stop (interrupt) the selected agent             |
| `d`            | remove the agent + its worktree                 |
| `q`            | quit (stops all agents)                         |

When an agent is in `default` permission mode and a tool needs approval, press `y`/`n`.

## Config reference

Config lives in `~/.orc/config.json` (or `--config <path>`). Fields:

- `projects` (required): `[{ name, path, ...overrides }]` — the projects you can launch agents into.
- `permissionMode`: `bypassPermissions` (default, fully autonomous per the mobile CLAUDE.md),
  `acceptEdits`, or `default` (routes tool approvals to the UI via `y`/`n`). Overridable per project.
- `settingSources` **must include `project`** for the worktree's `CLAUDE.md` to load. Overridable.
- `model`, `worktreeDir`, `maestroMcp`: global defaults, overridable per project.
- `basePort`: global only. `maestroMcp`: adjust to however your server launches; omit / `--no-maestro`.

Agent metadata (tagged with project) is mirrored to `~/.orc/state.json`.

## Notes / limits

- Live agent sessions run in-process; they don't survive an `orc` restart (a stored `sessionId`
  makes future re-attach via `resume` possible — not yet wired into the UI).
- The log pane shows a bounded tail; very long assistant messages are truncated in view (the full
  text still reaches the model).

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
