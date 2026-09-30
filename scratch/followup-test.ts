import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManager } from '../src/agent/AgentManager.js';
import type { OrcConfig } from '../src/types.js';

function sh(cwd: string, cmd: string, args: string[]) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

async function waitFor(session: any, statuses: string[], ms: number): Promise<string> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    const check = () => {
      const s = session.getInfo().status;
      if (statuses.includes(s)) {
        clearTimeout(t);
        session.off('update', check);
        resolve(s);
      }
    };
    session.on('update', check);
    check();
  });
}

async function main() {
  const repo = mkdtempSync(join(tmpdir(), 'orc-followup-'));
  sh(repo, 'git', ['init', '-q']);
  sh(repo, 'git', ['config', 'user.email', 't@t.local']);
  sh(repo, 'git', ['config', 'user.name', 'T']);
  writeFileSync(join(repo, 'README.md'), '# t\n');
  sh(repo, 'git', ['add', '.']);
  sh(repo, 'git', ['commit', '-q', '-m', 'init']);

  const config: OrcConfig = {
    basePort: 8500,
    projects: [
      {
        name: 'P',
        repo,
        model: 'claude-opus-4-8',
        worktreeDir: '.worktrees',
        permissionMode: 'bypassPermissions',
        settingSources: ['project'],
      },
    ],
  };

  const manager = new AgentManager(config);
  const session = await manager.create(
    'P',
    'f',
    '',
    "Reply with exactly the word READY and nothing else, then end your message with a final line containing @@NEEDS_INPUT@@. Do not use any tools.",
  );

  const s1 = await waitFor(session, ['needs_input', 'error', 'done'], 120_000);
  console.log('after turn 1:', s1);
  logTail(session);

  if (s1 !== 'needs_input') {
    console.log('did not reach needs_input; aborting follow-up test');
  } else {
    console.log('\n>>> sending follow-up reply...');
    session.send("Create a file done.txt containing 'ok', commit it, then end your message with @@DONE@@ <hash>.");
    const s2 = await waitFor(session, ['done', 'error'], 120_000);
    console.log('after follow-up:', s2);
    logTail(session);

    // Resume-after-terminal: this drives the same code path crash-recovery uses.
    console.log('\n>>> resuming after done (send on a terminal session)...');
    const before = session.getInfo().sessionId;
    session.send('Append a line "second" to done.txt and commit it, then end with @@DONE@@ <hash>.');
    const s3 = await waitFor(session, ['done', 'error'], 120_000);
    console.log('after resume:', s3, '· sessionId stable:', session.getInfo().sessionId === before);
    logTail(session);
    const commits = sh(session.worktree, 'git', ['log', '--oneline']).trim().split('\n').length;
    console.log('commit count in worktree:', commits, '(expect >= 3)');
  }

  await manager.stopAll();
  rmSync(repo, { recursive: true, force: true });
  process.exit(0);
}

function logTail(session: any) {
  const ev = session.getEvents().slice(-8);
  for (const e of ev) console.log(`  [${e.kind}] ${e.text.replace(/\n/g, ' ').slice(0, 160)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
