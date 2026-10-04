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

## Status (Rust rewrite)

orc was rewritten from TypeScript to Rust (ratatui + crossterm). What works today:

- **Core loop**: launch the TUI, pick a project, start an agent (its own worktree + branch + port),
  watch its `claude` session stream live, answer it with `i`, resume with `r`, and
  `@@DONE@@`/`@@NEEDS_INPUT@@` drive its status. Config, ports, worktrees, persistence
  (`~/.orc/state.json`), and the human-in-the-loop protocol are all in.
- **tmux shell panes + visible agent commands**: when `tmux` is installed and you're on a TTY, orc
  bootstraps a tmux session (or adopts the one you're already in) and gives each agent its own
  long-lived interactive shell in its worktree. Selecting an agent reveals its shell beside the TUI
  (focus stays on the TUI; mouse is enabled so you can click into the pane). The agent runs **every**
  shell command through the `mcp__orc__run` tool (its built-in `Bash` is disabled), so its commands
  execute **in that visible pane** — you watch them run and can press ↑ to rerun any of them
  yourself. Run with `--no-tmux` for the plain UI (then the agent keeps `Bash` and its commands show
  in the TUI log pane instead).

Not yet wired (the `.rs` modules exist as stubs): **iOS simulator** provisioning, **merge agents**
(`m`), **pipelines**, and the `p` "install CLAUDE.md" action. Those keys report that they aren't
available yet. Everything below describes the full intended design.

## How it works

Each agent is a streaming `claude` CLI session, spawned and driven through a `ClaudeDriver` seam
(a push-able async input queue feeds your replies into the running session). For the project you
pick, orc:

- creates `git worktree add <repo>/.worktrees/<name> -b agent/<name>` in that project's repo,
- allocates a free port from the project's `portRange` (if set) and injects it as `METRO_PORT`/`AGENT_PORT` plus `AGENT_NAME` into the session env,
- attaches the Maestro MCP server,
- appends an orchestration addendum to the worktree's own `CLAUDE.md` (loaded via
  `settingSources`), and streams the agent's output live into the ratatui UI.

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

One command — clone, build the release binary, and install a version-independent `orc` launcher:

```bash
git clone git@github.com:hvalec427/orc.git ~/dev/orc && cd ~/dev/orc && ./install.sh
```

`install.sh` is idempotent: it runs `cargo build --release` and points a launcher at the built
binary. Then create `~/.orc/config.json` yourself and run `orc`.

Requires a Rust toolchain (`cargo` / edition 2021) and the `claude` CLI logged in. If `tmux` is on
your `PATH` orc uses it for the per-agent shell panes (run `--no-tmux` to opt out); for the mobile
flow you also need `xcrun`, a React Native app, and the Maestro MCP server on your `PATH`.

<details>
<summary>Manual install (no script)</summary>

```bash
cargo build --release          # produces ./target/release/orc
cargo install --path .         # or put `orc` on your PATH
# or run from source without installing:  cargo run
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
orc --tmux / --no-tmux           # force tmux panes on / off (default: on when tmux is installed)
```

Press `n` to start an agent: pick a **project**, a **name**, an optional **ticket** (a reference like
`PROJ-123` that the agent weaves into its commit message), and a **prompt** (what the agent should
actually do). Steer it afterward with `i`.

### Keys

| Key            | Action                                          |
| -------------- | ----------------------------------------------- |
| `n`            | new agent (pick project, then name + ticket)    |
| `p`            | projects: install mobile CLAUDE.md into a repo   |
| `↑`/`↓`, `Tab`, `j`/`k` | switch selected agent                  |
| `h` / `l`      | jump to parent / descend into its merge agent   |
| `J` / `K`      | scroll the log down / up · `G` jumps back to live |
| `1`–`9`        | jump to the nth agent                           |
| `w`            | jump to the next agent waiting on you           |
| `i` / `Enter`  | answer the selected agent                       |
| `r`            | resume a crashed/finished agent (same session)  |
| `m`            | merge the selected agent (spawns a nested merge agent) |
| `x`            | stop (interrupt) the selected agent             |
| `d`            | remove the agent + its worktree                 |
| `q`            | quit (stops all agents)                         |

When an agent is in `default` permission mode and a tool needs approval, press `y`/`n`.

### Merging an agent

When a feature agent reports `@@DONE@@`, press `m` on it to merge its branch. This spawns a dedicated
**merge agent** nested under that feature agent in the sidebar (shown indented with a `└` connector).
Press `l` to descend from the feature agent into its merge agent and `h` to jump back to the parent.
The merge agent is pre-prompted with the parent's branch, so it starts merging straight away — you
don't have to name the branch yourself.

You can also start a merge agent manually with `n` → **Merge** template if you want to merge arbitrary
branches; in that case tell it which branches to merge (e.g. `merge agent/foo into master`).

Either way, the merge agent runs directly in the base repo, **not** in the feature agent's worktree,
so it can't delete the directory it's running in and it *can* clean up the parent's worktree. (A
feature agent asked to merge *itself* would `git worktree remove` its own working directory
mid-command and permanently break its shell; that's why feature agents never self-merge — the nested
merge agent does it from the base repo instead.)

- The target is the project's configured `baseBranch`. If none is configured, the merge agent detects
  it (preferring `develop`/`development`, then `master`/`main`) and confirms with you before merging.
- Before merging, the merge agent makes sure the working tree is clean.
- If a merge hits a **conflict** it can't safely resolve, the merge agent runs `git merge --abort`,
  leaves the repo clean, and asks you how to proceed — nothing is left half-merged.
- After a branch merges cleanly, the merge agent verifies it actually landed on the target branch,
  then deletes the now-merged branch and removes its worktree.
- The merge agent won't push to any remote unless you explicitly ask.
- Removing a feature agent with `d` also removes its nested merge agent.

## Config reference

For a full field-by-field reference see [CONFIG.md](CONFIG.md). Quick summary — config lives in
`~/.orc/config.json` (or `--config <path>`). Fields:

- `projects` (required): `[{ name, path, type, ...overrides }]` — the projects you launch agents into.
- `type` (per project): `react-native` (default), `web`, or `orc`. Only used to pick which CLAUDE.md
  template the `p` action installs.
- `permissionMode`: `bypassPermissions` (default, fully autonomous per the mobile CLAUDE.md),
  `acceptEdits`, or `default` (routes tool approvals to the UI via `y`/`n`). Overridable per project.
- `settingSources` **must include `project`** for the worktree's `CLAUDE.md` to load. Overridable.
- `model`, `worktreeDir`, `maestroMcp`: global defaults, overridable per project.
- `baseBranch` (per project, optional): the branch merge agents integrate into (e.g. `master`, `main`,
  `develop`). If set, pressing `m` merges straight into it. If omitted, the merge agent detects the
  target (preferring `develop`/`development`, then `master`/`main`) and **confirms with you before
  merging**. Can also be set globally as a fallback.
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
  main.rs                CLI entry (clap) + ratatui render
  config.rs              config load/validate (serde)
  ports.rs               Metro port allocator
  worktree.rs            git worktree add/remove
  persist.rs             ~/.orc/state.json persistence
  simulators.rs          iOS simulator naming/boot
  types.rs               shared domain types
  agent/
    input_queue.rs       push-able async input stream
    driver.rs            ClaudeDriver seam: spawn + stream a `claude` CLI session
    session.rs           one agent session: streaming, status, sentinels
    stream.rs            parse the streamed session output
    manager.rs           registry + worktree/port lifecycle + persistence
    prompt.rs            orchestration addendum + sentinels
    instructions.rs      CLAUDE.md templates
    tools.rs             orchestrator / launcher MCP tools
    read_only.rs         read-only command classifier
  tmux/
    controller.rs        per-agent tmux shell panes (break/join stage)
    pane_run.rs          inject commands into an agent's shell
  ui/                    app, sidebar, agent_view, input_bar, forms, layout, log_format
```
