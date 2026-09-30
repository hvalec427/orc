#!/usr/bin/env node
import { render } from 'ink';
import { createElement } from 'react';
import { loadConfig, DEFAULT_CONFIG_PATH, type CliFlags } from './config.js';
import { AgentManager } from './agent/AgentManager.js';
import { App } from './ui/App.js';

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') flags.config = argv[++i];
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--no-maestro') flags.noMaestro = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(
    [
      'orc — TUI orchestrator for parallel Claude Code mobile agents',
      '',
      'Usage: orc [--config <path>] [--model <id>] [--no-maestro]',
      '',
      `  --config <path>  Central config file (default: ${DEFAULT_CONFIG_PATH})`,
      '  --model <id>     Override the model for all agents',
      '  --no-maestro     Do not attach the Maestro MCP server',
      '',
      'The config lists your projects (nice name + repo path). Pick a project when',
      'starting each agent. See examples/config.json.',
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
// Always restore the normal screen, even on crash/kill. Ctrl+C (SIGINT) is left to Ink so
// it can unmount and let main() stop agents gracefully before we restore the screen.
process.on('exit', leaveAltScreen);
for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    leaveAltScreen();
    process.exit(0);
  });
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(parseArgs(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  enterAltScreen();
  const manager = new AgentManager(config);
  const app = render(createElement(App, { manager, config }));

  await app.waitUntilExit();
  await manager.stopAll();
  leaveAltScreen();
}

main().catch((err) => {
  leaveAltScreen();
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
