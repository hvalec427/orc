# orc

Run Claude Code agents on feature requests for a React Native app, several at
once. Each request gets its own git worktree, branch, Metro port, iOS
simulator and agent, and you talk to all the agents from one TUI. The React
Native side (Metro, simulator, builds, logs, network) is
[metroctl](https://github.com/hvalec427/metroctl), which the agents use through
`metroctl mcp`.

```sh
orc               # open the TUI (starts the tmux session and the daemon if needed)
orc ls            # list requests
orc new --project app --title "Price screen" "Add a prices screen…"
orc send <id> "…" # message an agent
orc log <id>      # print a conversation
orc down <id>     # tear a request down (keeps the branch)
orc stop          # stop the daemon and its agents
```

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/hvalec427/orc/master/install.sh | sh
```

Or the latest build from `develop` with `… | sh -s -- dev`. Update with
`orc update` (`--stable`, `--nightly`, `--dev` to switch channels). Uninstall:

```sh
curl -fsSL https://raw.githubusercontent.com/hvalec427/orc/master/uninstall.sh | sh
```

Needs `claude` (logged in), `metroctl`, `tmux` and `git` on PATH. macOS only.

## How it works

- `orc` runs in window 0 of the tmux session `orc`. Each request also gets a
  window running `metroctl up` for manual debugging (`g` jumps there).
- The agents run under **orcd**, a background daemon. Quitting the TUI leaves
  them working, and reopening it reattaches. When orcd restarts, agents
  resume their sessions on your next message.
- New request: `git worktree add` a branch in `<root>-worktrees/<id>`, clone
  the `copy` paths from the main checkout (APFS clones, so it's instant), run
  `setup`, open the metroctl window, start the agent with your prompt.
- Tool permission prompts show up in the conversation; answer with `y`/`d`.
- State lives in `~/.config/orc/` (`ORC_HOME` overrides it).

## Config

`~/.config/orc/config.json`:

```json
{
  "projects": [{
    "name": "app",
    "root": "/Users/me/dev/app",
    "worktrees": "/Users/me/dev/app-worktrees",
    "copy": ["node_modules", "ios/Pods", ".env", "ios/.xcode.env.local"],
    "setup": "cd ios && pod install",
    "metroctl": "metroctl up --port auto --new-sim",
    "permissionMode": "acceptEdits",
    "allowedTools": ["mcp__metroctl__*", "Bash(yarn *)", "Bash(git *)"],
    "model": "opus"
  }]
}
```

Only `name` and `root` are required. `tmux_session` (top level) changes the
session name.

## Keys

| Key | |
|---|---|
| `n` | new request |
| `⏎` / `i` | write a message (`alt-⏎` newline) |
| `j` / `k` | select a request |
| `y` / `d` | allow / deny a permission prompt |
| `g` | go to the request's metroctl window |
| `ctrl-c` | interrupt the agent's turn |
| `x` | tear down (agent, simulator, worktree; branch kept) |
| `ctrl-u` / `ctrl-d`, `G` | scroll the conversation, back to the bottom |
| `q` | quit the TUI (agents keep running) |

## Contributing

Commits must follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat: …`, `fix(tui): …`) — release versions are derived from them. Enable the
local check once per clone:

```sh
git config core.hooksPath .githooks
```
