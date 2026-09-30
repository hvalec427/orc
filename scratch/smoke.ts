import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManager } from '../src/agent/AgentManager.js';
import type { OrcConfig } from '../src/types.js';

function sh(cwd: string, cmd: string, args: string[]) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

async function main() {
  const repo = mkdtempSync(join(tmpdir(), 'orc-smoke-'));
  console.log('scratch repo:', repo);
  sh(repo, 'git', ['init', '-q']);
  sh(repo, 'git', ['config', 'user.email', 'smoke@test.local']);
  sh(repo, 'git', ['config', 'user.name', 'Smoke Test']);
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  sh(repo, 'git', ['add', '.']);
  sh(repo, 'git', ['commit', '-q', '-m', 'init']);

  const config: OrcConfig = {
    repo,
    model: 'claude-opus-4-8',
    worktreeDir: '.worktrees',
    basePort: 8300,
    permissionMode: 'bypassPermissions',
    settingSources: ['project'],
    maestroMcp: undefined, // no maestro in this test
  };

  const manager = new AgentManager(config);
  const session = await manager.create(
    'smoke',
    "Create a file named hello.txt containing exactly the word 'hi'. Commit it with git. Do NOT build, install deps, or create simulators. Then finish.",
  );

  console.log('worktree:', session.worktree, 'port:', session.metroPort, 'branch:', session.branch);

  let lastLogged = 0;
  const done = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 240_000);
    session.on('update', () => {
      const events = session.getEvents();
      for (let i = lastLogged; i < events.length; i++) {
        const e = events[i];
        console.log(`[${e.kind}] ${e.text.replace(/\n/g, ' ').slice(0, 120)}`);
      }
      lastLogged = events.length;
      const s = session.getInfo().status;
      if (s === 'done' || s === 'error' || s === 'needs_input') {
        clearTimeout(timer);
        resolve(s === 'done' || s === 'needs_input');
      }
    });
  });

  const fileExists = existsSync(join(session.worktree, 'hello.txt'));
  let committed = false;
  try {
    const log = sh(session.worktree, 'git', ['log', '--oneline', '-n', '5']);
    committed = /hello|hi|add|create/i.test(log);
    console.log('git log:\n' + log);
  } catch {
    /* ignore */
  }

  console.log('\n=== RESULT ===');
  console.log('final status :', session.getInfo().status);
  console.log('reached end  :', done);
  console.log('hello.txt    :', fileExists);
  console.log('worktree add :', existsSync(session.worktree));
  console.log('committed    :', committed);
  console.log('cost usd     :', session.getInfo().totalCostUsd.toFixed(4));

  await manager.stopAll();
  // Clean up scratch repo.
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(fileExists ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
