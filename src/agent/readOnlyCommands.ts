/**
 * Classify a shell command as read-only (pure investigation, no state changes) or not.
 *
 * Shared by the read-only-agent permission guard (AgentSession) and the custom `mcp__orc__run`
 * pane tool (orchestratorTools). It lives in its own module so both can import it without creating
 * a circular dependency between AgentSession and orchestratorTools.
 */

/**
 * Read-only binaries a read-only agent may run: investigation/inspection only, never anything that
 * writes files, changes git state, installs packages, or launches long-lived servers. A command is
 * allowed only when EVERY simple command in it (split on pipes and &&/||/;) is in this set — see
 * {@link isReadOnlyBashCommand}.
 */
const READONLY_BASH_COMMANDS = new Set([
  // Filesystem inspection
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'tree', 'pwd', 'realpath', 'basename',
  'dirname', 'readlink',
  // Search
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'locate',
  // Text viewing / transforms that don't write (no redirection is allowed anyway)
  'echo', 'printf', 'sort', 'uniq', 'cut', 'tr', 'column', 'diff', 'comm', 'nl', 'tee', 'xargs',
  'date', 'env', 'whoami', 'hostname', 'uname', 'which', 'type', 'command', 'true', 'false',
  'jq', 'yq',
  // Package/tooling introspection (read-only subcommands only; see per-command checks)
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'pip', 'cargo', 'go', 'make',
]);

/**
 * Whether a Bash command is safe for a read-only agent: pure investigation, no state changes.
 *
 * Conservative by design — when in doubt it returns false so the agent is told to delegate. It
 * rejects any output redirection (`>`/`>>`), command substitution (`$(…)` or backticks), process
 * substitution, and here-strings, then requires every simple command (across pipes and `&&`/`||`/`;`)
 * to be a known read-only binary. `git` is allowed only for read-only subcommands; `npm`/`yarn`/etc.
 * only for their read-only subcommands (test/lint/typecheck/run script inspection) — never install/add.
 */
export function isReadOnlyBashCommand(raw: string): boolean {
  const cmd = raw.trim();
  if (!cmd) return false;

  // Command substitution can smuggle in an arbitrary writer (e.g. `echo $(rm -rf x)` / `ls \`touch y\``),
  // and we don't classify its inner command, so reject it outright.
  if (cmd.includes('$(') || cmd.includes('`')) return false;
  // Any output redirection or file-descriptor write is a mutation. (`2>&1` is fine; `>`/`>>` are not.)
  if (/(^|[^0-9&])>>?/.test(cmd)) return false;
  // Process substitution and here-docs can smuggle in writes.
  if (/<\(|>\(|<<</.test(cmd)) return false;
  // Backgrounding would leave a process running past the turn.
  if (/(^|[^&])&\s*$/.test(cmd)) return false;

  // Split into simple commands across pipes and sequencing operators. Each segment must be read-only.
  const segments = cmd.split(/\|\||&&|[;|]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;

  return segments.every(isReadOnlySimpleCommand);
}

/** Classify one simple command (already split off its pipeline) as read-only or not. */
function isReadOnlySimpleCommand(segment: string): boolean {
  // Strip leading VAR=val environment assignments.
  let rest = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '').trim();
  if (!rest) return false;

  const tokens = rest.split(/\s+/);
  const name = tokens[0].replace(/^.*\//, ''); // drop any leading path
  const args = tokens.slice(1);

  switch (name) {
    case 'git':
      return isReadOnlyGit(args);
    case 'sed':
      // Only `sed -n` (print mode) with no in-place `-i` is read-only.
      return args.includes('-n') && !args.some((a) => a === '-i' || a.startsWith('-i'));
    case 'awk':
      // awk that doesn't write to files is fine; redirection is already rejected above.
      return true;
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return isReadOnlyPackageScript(args);
    case 'npx':
      // Allow running local tooling (tsc/eslint/jest/vitest) read-only; reject obvious installers.
      return !args.some((a) => /^(i|install|add|create|init)$/.test(a));
    case 'node':
      // `node --version`, `node -e "..."` read-only snippets, running a script that only reads — we
      // can't fully prove the script is read-only, so only allow explicit version/eval/print flags.
      return args.length === 0 || args.some((a) => /^(-v|--version|-e|--eval|-p|--print|--help|-h)$/.test(a));
    case 'python':
    case 'python3':
      return args.some((a) => /^(-V|--version|-c|-m|--help|-h)$/.test(a)) || args.length === 0;
    case 'pip':
      return args[0] === 'list' || args[0] === 'show' || args[0] === 'freeze' || args.includes('--version');
    case 'cargo':
      return ['check', 'test', 'tree', 'metadata', 'fmt', 'clippy', '--version'].includes(args[0] ?? '');
    case 'go':
      return ['test', 'vet', 'list', 'version', 'env', 'doc'].includes(args[0] ?? '');
    case 'make':
      // Only the dry-run / list targets are provably read-only.
      return args.some((a) => a === '-n' || a === '--dry-run' || a === '-p' || a === '--print-data-base');
    default:
      return READONLY_BASH_COMMANDS.has(name);
  }
}

/** git subcommands that only read repository state. */
const READONLY_GIT_SUBCOMMANDS = new Set([
  'log', 'diff', 'show', 'status', 'blame', 'ls-files', 'ls-tree', 'cat-file', 'rev-parse',
  'rev-list', 'branch', 'tag', 'describe', 'shortlog', 'reflog', 'grep', 'whatchanged',
  'remote', 'config', 'show-ref', 'symbolic-ref', 'merge-base', 'name-rev', 'for-each-ref',
  'count-objects',
]);

function isReadOnlyGit(args: string[]): boolean {
  // Skip leading global flags like `-C <path>`, `--no-pager`, `-c key=val`.
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C' || args[i] === '-c') i += 2;
    else i += 1;
  }
  const sub = args[i];
  if (!sub) return true; // bare `git` / `git --version`
  // `git config` is read-only only when not setting a value: a set has a value arg after the key.
  if (sub === 'config') {
    const after = args.slice(i + 1).filter((a) => !a.startsWith('-'));
    return after.length <= 1 || args.slice(i + 1).some((a) => a === '--get' || a === '--list' || a === '-l');
  }
  // `git branch`/`git tag`/`git remote` mutate when given a create/delete action.
  if (sub === 'branch' || sub === 'tag') {
    return !args.slice(i + 1).some((a) => /^-(d|D|m|M|f)$/.test(a)) && args.slice(i + 1).filter((a) => !a.startsWith('-')).length === 0;
  }
  if (sub === 'remote') return ['', '-v', 'show', 'get-url'].includes(args[i + 1] ?? '');
  return READONLY_GIT_SUBCOMMANDS.has(sub);
}

/** npm/pnpm/yarn invocations that run read-only scripts (test/lint/typecheck) or inspect, never install. */
function isReadOnlyPackageScript(args: string[]): boolean {
  const sub = args[0] ?? '';
  if (/^(install|i|add|remove|rm|uninstall|update|up|ci|link|unlink|publish|exec|dlx|create|init)$/.test(sub)) {
    return false;
  }
  if (sub === 'ls' || sub === 'list' || sub === 'outdated' || sub === 'why' || sub === 'view' || sub === 'info') {
    return true;
  }
  if (sub === '--version' || sub === '-v') return true;
  // `npm run <script>` / `npm test` / `yarn test` etc. Only allow clearly read-only script names.
  const script = sub === 'run' || sub === 'run-script' ? args[1] ?? '' : sub;
  return /^(test|tests|lint|typecheck|type-check|tsc|check|coverage)$/.test(script);
}
