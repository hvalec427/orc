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

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(parseArgs(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  const manager = new AgentManager(config);
  const app = render(createElement(App, { manager, config }));

  await app.waitUntilExit();
  await manager.stopAll();
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
