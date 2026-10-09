# orc

orc runs Claude Code agents on feature requests for a React Native app. Each
request gets its own git worktree, Metro port, iOS simulator and agent. You
chat with every agent from one TUI. metroctl does the React Native side (see
metroctl's `docs/orchestrator-plan.md`).

## Processes

```
tmux session "orc"
├─ window 0  orc            TUI (client of orcd)
├─ window    <slug>         metroctl up … (per request; for manual debugging)
└─ …
orcd (orc daemon)           detached; owns agents, setup, state
└─ claude -p …              one per request (stream-json in/out)
   ├─ metroctl mcp          logs/network/screenshot/rebuild of its session
   └─ orc perm-mcp          permission prompts → orcd → TUI
```

- `orc` with no arguments makes sure the tmux session and orcd are running,
  then shows the TUI in window 0. Quitting the TUI leaves orcd and the agents
  running. Reopening it reattaches.
- orcd listens on `~/.config/orc/orcd.sock` (JSON lines). Clients send
  commands and can subscribe to events.

## State (`~/.config/orc/`)

- `config.json`: projects
  ```json
  { "projects": [{
      "name": "myapp",
      "root": "/Users/me/dev/myapp",
      "worktrees": "/Users/me/dev/myapp-worktree",
      "copy": ["node_modules", "ios/Pods", ".env", "ios/.xcode.env.local"],
      "setup": "cd ios && pod install",
      "metroctl": "metroctl up --port auto --new-sim",
      "permissionMode": "acceptEdits",
      "allowedTools": ["mcp__metroctl__*", "Bash(yarn *)", "Bash(git *)"]
  }] }
  ```
  `worktrees` defaults to `<root>-worktrees`.
- `requests.json`: id, project, title, branch, worktree, claude session id,
  status, created.
- `requests/<id>.jsonl`: the conversation (items below). Replayed to the TUI.

## Request lifecycle

1. `new`: project, title, prompt. The id/branch/window name is a slug of the
   title.
2. Setup (orcd thread, each step logged into the conversation):
   `git worktree add -b <slug>` → copy `copy` entries with `cp -cR` (APFS
   clones) → run `setup` → `tmux new-window -d -n <slug>` running the
   `metroctl` command.
3. The agent starts as soon as the worktree is ready. It doesn't wait for the
   app build; its metroctl tools report the session status.
4. Statuses: `setup`, `working`, `waiting` (turn finished, your move),
   `approval` (a permission prompt is open), `error`, `stopped`.
5. Teardown (`x`): stop the agent, `metroctl down` (deletes the simulator),
   kill the window, `git worktree remove --force`. The branch is kept.

## Agent

`claude -p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages` in the worktree, with:

- `--mcp-config` adding `metroctl` (`metroctl mcp`) and `orc` (`orc perm-mcp
  --request <id>`), so nothing is written into the worktree;
- `--permission-prompt-tool mcp__orc__approve` and the project's
  `permissionMode` / `allowedTools`;
- `--append-system-prompt` describing the setup (worktree, branch, metroctl
  tools, rebuild after native changes, don't push);
- `--resume <session id>` when orcd restarts or the agent process died.

Conversation items: `user`, `assistant` (text), `tool` (name + one-line
summary), `tool_result` (ok/error + short preview), `system` (setup steps,
errors), `permission` (pending/allowed/denied), `turn` (end of turn, cost).

## TUI

- Left: requests with a status badge.
- Right: the selected conversation; input line at the bottom.
- Keys: `n` new request, `i`/`⏎` write a message, `y`/`d` answer a permission
  prompt, `g` jump to the request's metroctl window, `x` tear down,
  `ctrl-c` interrupt the agent's turn, `q` quit the TUI (agents keep running).

## Milestones

1. orcd + agent driver + protocol + persistence, with CLI commands
   (`orc daemon`, `orc new`, `orc send`, `orc ls`, `orc log`).
2. TUI client.
3. Worktree setup/teardown and the metroctl window.
4. Permission prompts in the TUI.
5. tmux bootstrap and polish.
6. Device control for agents (in `metroctl mcp`): element tree, tap, swipe
   and type on iOS simulators (AXe/idb), iOS devices (WebDriverAgent) and
   Android (adb). No Maestro. See metroctl's `docs/orchestrator-plan.md`.
