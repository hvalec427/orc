# `config.json` reference

`orc` reads a single JSON config that lists the **projects** you can launch agents into, plus
optional defaults. You can edit it by hand, or run `orc setup` to add/edit projects and the global
defaults through a wizard (it preserves any keys it doesn't manage).

- **Default location:** `~/.orc/config.json`
- **Override:** `orc --config <path>`
- **Wizard:** `orc setup` (Add / Edit project, Global settings, Apply CLAUDE.md, Remove project)

If the file is missing or invalid, `orc` exits with an error and prints a sample config. The schema
is validated with [zod](https://zod.dev) in `src/config.ts`; unknown keys are rejected (`.strict()`).

---

## Structure at a glance

```json
{
  "model": "claude-opus-4-8",
  "permissionMode": "bypassPermissions",
  "settingSources": ["user", "project", "local"],
  "maestroMcp": { "command": "maestro", "args": ["mcp"] },
  "projects": [
    { "name": "Acme iOS", "type": "react-native", "path": "~/dev/acme-app", "portRange": "8000-8099", "baseBranch": "develop" },
    { "name": "Acme Web", "type": "web",          "path": "~/dev/acme-web", "portRange": "8100-8199", "model": "claude-sonnet-5" },
    { "name": "Acme API", "type": "orc",          "path": "~/dev/acme-api", "permissionMode": "default" }
  ]
}
```

The config has exactly one **required** top-level key: `projects`. Everything else at the top level
is a **global default**. Every global default may be overridden on an individual project.

### Resolution order

For each project, a setting is resolved by taking the first value that exists:

```
project-level value  →  top-level (global) value  →  built-in default
```

A few settings are also influenced by CLI flags (see [CLI flags](#cli-flags)).

---

## Top-level keys

| Key              | Type                | Required | Default              | Overridable per project |
| ---------------- | ------------------- | -------- | -------------------- | ----------------------- |
| `projects`       | array of project    | **Yes**  | —                    | n/a                     |
| `type`           | enum                | No       | `react-native`       | Yes                     |
| `model`          | string              | No       | `claude-opus-4-8`    | Yes                     |
| `worktreeDir`    | string              | No       | `.worktrees`         | Yes                     |
| `permissionMode` | enum                | No       | `bypassPermissions`  | Yes                     |
| `settingSources` | array of enum       | No       | `["user","project","local"]` | Yes             |
| `baseBranch`     | string              | No       | *(auto-detected)*    | Yes                     |
| `mergeStrategy`  | enum                | No       | `rebase`             | Yes                     |
| `portRange`      | string `"a-b"`      | No       | *(none)*             | Yes                     |
| `maestroMcp`     | object              | No       | `{ "command": "maestro", "args": ["mcp"] }` | Yes (react-native only) |
| `magicLink`      | string              | No       | *(none)*             | Yes (react-native only)  |

`projects` is the only key that is **not** overridable (it is the list itself). All the others may
appear at the top level as a default and/or inside any project entry as an override.

`maestroMcp` and `magicLink` apply only to `react-native` projects; the setup UI hides them for
other project types.

---

## `projects` (required)

A non-empty array. Each entry maps a human-friendly name to a git repo and may override any global
default. `name` and `path` are the only per-project **required** fields.

| Key    | Type   | Required | Description                                                     |
| ------ | ------ | -------- | --------------------------------------------------------------- |
| `name` | string | **Yes**  | Human-facing project name (shown when you pick a project). Must be unique across the config. |
| `path` | string | **Yes**  | Path to the base git repo worktrees are cut from. Supports `~`; relative paths resolve against the current directory. |

Plus any of the overridable keys documented below.

```json
"projects": [
  { "name": "Acme iOS", "path": "~/dev/acme-app" }
]
```

> Duplicate `name` values cause a load error.

---

## Overridable settings (global default **or** per project)

### `type`

- **Type:** `"react-native"` | `"web"` | `"orc"`
- **Default:** `react-native`

Only used to pick which `CLAUDE.md` template the `p` ("projects") action installs into a repo. See
`examples/{mobile,web,orc}-CLAUDE.md`. Has no other runtime effect.

### `model`

- **Type:** string
- **Default:** `claude-opus-4-8`

The Claude model id passed to every agent session for the project. The `--model` CLI flag overrides
this for all projects.

### `worktreeDir`

- **Type:** string
- **Default:** `.worktrees`

Directory, relative to the repo root, where per-agent git worktrees are created
(`<repo>/<worktreeDir>/<name>`).

### `permissionMode`

- **Type:** `"bypassPermissions"` | `"default"` | `"acceptEdits"`
- **Default:** `bypassPermissions`

Controls how agent tool use is approved:

| Value               | Behavior                                                                      |
| ------------------- | ----------------------------------------------------------------------------- |
| `bypassPermissions` | Fully autonomous — all tools auto-approved (relies on the repo's `CLAUDE.md`). |
| `default`           | Tool calls that need approval are routed to the UI; approve/deny with `y`/`n`. |
| `acceptEdits`       | Passed through to the Claude Agent SDK's `acceptEdits` mode.                   |

Group coordination tools (inter-agent messaging) are always auto-allowed because they never touch the
codebase.

### `settingSources`

- **Type:** array of `"user"` | `"project"` | `"local"`
- **Default:** `["user", "project", "local"]`

Where the agent loads `CLAUDE.md` / settings from:

- `user` — your global `~/.claude/CLAUDE.md`
- `project` — the worktree's own `CLAUDE.md`
- `local` — the project's local `.claude/` settings

> **Must include `"project"`** for the worktree's `CLAUDE.md` (where orc appends the orchestration
> addendum) to load. Dropping it means agents won't see the per-agent protocol.

### `baseBranch`

- **Type:** string (non-empty)
- **Default:** *(none — auto-detected)*

The branch a **merge agent** integrates into.

- **Set:** pressing `m` merges straight into this branch.
- **Omitted:** the merge agent detects the target (preferring `develop`/`development`, then
  `master`/`main`) and **confirms with you before merging**.

### `mergeStrategy`

- **Type:** `"merge"` | `"rebase"` | `"squash-merge"` | `"squash-rebase"`
- **Default:** `rebase`

How a merge agent integrates a branch into `baseBranch`:

| Value            | Result                                                      |
| ---------------- | ---------------------------------------------------------- |
| `merge`          | Standard merge commit.                                     |
| `rebase`         | Linear history, individual commits preserved (fast-forward). |
| `squash-merge`   | Single squashed commit via `git merge --squash`.          |
| `squash-rebase`  | Single commit via interactive autosquash rebase.          |

### `portRange`

- **Type:** string in the form `"start-end"` (e.g. `"8000-8099"`)
- **Default:** *(none)*
- **Validation:** must match `^\d+-\d+$`, with `0 < start <= end`.

An inclusive range agents allocate a free port from. The allocated port is injected into the agent's
environment as both `METRO_PORT` and `AGENT_PORT`.

- Give each project a **distinct** range so parallel agents don't collide.
- Omit it for projects whose agents don't need a port. If such an agent later needs one, it asks you
  to add a range.

### `maestroMcp`

- **Type:** object `{ command, args?, env? }`
- **Default:** `{ "command": "maestro", "args": ["mcp"] }`
- **Applies to:** `react-native` projects only.

The Maestro MCP server attached to every agent (drives the iOS simulator). Only relevant for
`react-native` projects; the setup UI hides this option for other project types.

| Field     | Type                      | Required | Description                               |
| --------- | ------------------------- | -------- | ----------------------------------------- |
| `command` | string                    | **Yes**  | Executable that launches the MCP server.  |
| `args`    | array of string           | No       | Arguments passed to `command`.            |
| `env`     | object (string → string)  | No       | Extra environment variables for the server. |

Omit the key, or pass `--no-maestro`, to disable the server entirely.

```json
"maestroMcp": { "command": "maestro", "args": ["mcp"], "env": { "FOO": "bar" } }
```

### `magicLink`

- **Type:** string
- **Default:** *(none)*
- **Applies to:** `react-native` projects only.

A sign-in deep link (e.g. `acme://login?token=...`). If set, the new-agent form offers a step to
accept it (Enter) or type a different one per agent; the chosen value is passed to the agent as the
`MAGIC_LINK` env var, which it opens on its simulator to log in. Projects without one skip that step.

---

## CLI flags

These override config at load time:

| Flag              | Effect                                                     |
| ----------------- | ---------------------------------------------------------- |
| `--config <path>` | Load config from `<path>` instead of `~/.orc/config.json`. |
| `--model <id>`    | Override `model` for **all** projects.                     |
| `--no-maestro`    | Disable the Maestro MCP server even if configured.         |

---

## Full annotated example

```json
{
  "model": "claude-opus-4-8",
  "permissionMode": "bypassPermissions",
  "settingSources": ["user", "project", "local"],
  "mergeStrategy": "rebase",
  "maestroMcp": { "command": "maestro", "args": ["mcp"] },
  "projects": [
    {
      "name": "Acme iOS",
      "type": "react-native",
      "path": "~/dev/acme-app",
      "portRange": "8000-8099",
      "baseBranch": "develop",
      "magicLink": "acme://login?token=REPLACE_ME"
    },
    {
      "name": "Acme Web",
      "type": "web",
      "path": "~/dev/acme-web",
      "model": "claude-sonnet-5",
      "portRange": "8100-8199"
    },
    {
      "name": "Acme API",
      "type": "orc",
      "path": "~/dev/acme-api",
      "permissionMode": "default",
      "mergeStrategy": "squash-merge"
    }
  ]
}
```

In this example:

- `Acme iOS` inherits the global `model`, `permissionMode`, and `mergeStrategy`; sets its own
  `baseBranch`, `portRange`, and `magicLink`.
- `Acme Web` overrides `model`; everything else is global/default.
- `Acme API` runs with UI tool approvals (`default`) and squash merges.

---

## Validation rules & common errors

- The top-level document must be a JSON object with a non-empty `projects` array.
- Unknown keys are rejected (both top level and per project).
- Project `name` must be unique; duplicates fail to load.
- `path` must be non-empty.
- `portRange` must be `"start-end"` with `0 < start <= end`.
- `settingSources` without `"project"` is allowed but the worktree `CLAUDE.md` won't load.

Agent runtime metadata (tagged per project) is mirrored to `~/.orc/state.json`; that file is managed
by orc and is **not** part of `config.json`.
