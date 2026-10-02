#!/usr/bin/env node
import { render } from 'ink';
import { createElement } from 'react';
import { loadConfig, resolveConfigPath, DEFAULT_CONFIG_PATH, type CliFlags } from './config.js';
import { AgentManager } from './agent/AgentManager.js';
import { App } from './ui/App.js';
import { SetupApp } from './ui/SetupApp.js';
import { TmuxController, detectMode, buildReexecArgv } from './tmux/TmuxController.js';

type Command = 'run' | 'setup';

function parseArgs(argv: string[]): { command: Command; flags: CliFlags } {
  const flags: CliFlags = {};
  let command: Command = 'run';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'setup') command = 'setup';
    else if (a === '--config') flags.config = argv[++i];
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--no-maestro') flags.noMaestro = true;
    else if (a === '--no-tmux') flags.noTmux = true;
    else if (a === '--tmux-child') flags.tmuxChild = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return { command, flags };
}

function printHelp(): void {
  process.stdout.write(
    [
      'orc — TUI orchestrator for parallel Claude Code mobile agents',
      '',
      'Usage: orc [command] [--config <path>] [--model <id>] [--no-maestro] [--no-tmux]',
      '',
      'Commands:',
      '  (default)        Launch the orchestrator TUI',
      '  setup            Prepare the config and install per-project CLAUDE.md',
      '',
      'Options:',
      `  --config <path>  Central config file (default: ${DEFAULT_CONFIG_PATH})`,
      '  --model <id>     Override the model for all agents',
      '  --no-maestro     Do not attach the Maestro MCP server',
      '  --no-tmux        Do not drive the tmux viewer pane (plain TUI)',
      '',
      'The config lists your projects (nice name + repo path). Run `orc setup` to add',
      'projects and install CLAUDE.md, then pick a project when starting each agent.',
      '',
    ].join('\n'),
  );
}

// Alternate screen buffer: the app owns a full-screen viewport (like vim/htop) and the
// terminal's own scrollback is left untouched and restored on exit.
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
let altActive = false;
function enterAltScreen(): void {
  if (altActive || !process.stdout.isTTY) return;
  altActive = true;
  process.stdout.write(ALT_ON);
}
function leaveAltScreen(): void {
  if (!altActive) return;
  altActive = false;
  process.stdout.write(ALT_OFF);
}
// Tear the tmux session/viewer pane down on any exit path (set once a controller is attached).
let tmuxForSignals: TmuxController | undefined;

// Always restore the normal screen, even on crash/kill. Ctrl+C (SIGINT) is left to Ink so
// it can unmount and let main() stop agents gracefully before we restore the screen.
process.on('exit', () => {
  tmuxForSignals?.shutdownSync();
  leaveAltScreen();
});
for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    tmuxForSignals?.shutdownSync();
    leaveAltScreen();
    process.exit(0);
  });
}

// The Claude Agent SDK runs work detached from our awaited message loop — notably its
// telemetry exporter and internal command queue. A failure there (e.g. "1P event logging:
// N events failed to export", or "only prompt commands are supported in streaming mode")
// surfaces as an unhandled rejection/exception, which by default would kill the whole
// orchestrator and take every other agent down with it. Keep orc alive: a single session's
// SDK crash is already reflected as that agent's 'error' status via AgentSession.runLoop.
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`[orc] ignored unhandled rejection: ${detail.split('\n')[0]}\n`);
});
process.on('uncaughtException', (err) => {
  process.stderr.write(`[orc] ignored uncaught exception: ${err.stack ?? err.message}\n`);
});

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === 'setup') {
    // Setup tolerates a missing config (it can create one), so it does not go through loadConfig.
    enterAltScreen();
    const app = render(createElement(SetupApp, { configPath: resolveConfigPath(flags) }));
    await app.waitUntilExit();
    leaveAltScreen();
    return;
  }

  let config;
  try {
    config = loadConfig(flags);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  // Decide whether to drive tmux BEFORE touching the alt-screen: a bootstrap re-exec must happen on
  // the plain terminal so attaching tmux owns the screen cleanly.
  const disabled = config.tmux === false || flags.noTmux === true;
  const binaryAvailable = await TmuxController.isAvailable();
  const mode = detectMode({
    disabled,
    isTTY: !!process.stdout.isTTY,
    binaryAvailable,
    inTmux: !!process.env.TMUX,
    isChild: !!flags.tmuxChild,
  });

  let tmux: TmuxController | undefined;
  if (mode === 'bootstrap' && !flags.tmuxChild) {
    // Launch our own tmux session and re-exec orc inside its left pane; this process is replaced.
    await new TmuxController().bootstrapAndReexec(buildReexecArgv(process.argv, process.argv[1]));
    return;
  } else if (mode === 'inside' || (mode === 'bootstrap' && flags.tmuxChild)) {
    try {
      tmux = new TmuxController();
      await tmux.adopt();
    } catch {
      // A tmux hiccup must never stop orc from coming up — fall back to the plain UI.
      tmux = undefined;
    }
    tmuxForSignals = tmux;
  }

  enterAltScreen();
  const manager = new AgentManager(config, tmux);
  // Reload agents persisted by the previous run as paused, resumable sessions before the UI renders,
  // so a quit-and-relaunch shows the prior agents (as 'stopped') instead of starting empty.
  manager.restore();
  const app = render(createElement(App, { manager, config }));

  await app.waitUntilExit();
  await manager.stopAll();
  await tmux?.shutdown();
  leaveAltScreen();
}

main().catch((err) => {
  leaveAltScreen();
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
