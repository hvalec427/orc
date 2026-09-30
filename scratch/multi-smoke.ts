import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { AgentManager } from '../src/agent/AgentManager.js';

function sh(cwd: string, cmd: string, args: string[]) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

function makeRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `orc-${label}-`));
  sh(repo, 'git', ['init', '-q']);
  sh(repo, 'git', ['config', 'user.email', 'smoke@test.local']);
  sh(repo, 'git', ['config', 'user.name', 'Smoke']);
  writeFileSync(join(repo, 'README.md'), `# ${label}\n`);
  sh(repo, 'git', ['add', '.']);
  sh(repo, 'git', ['commit', '-q', '-m', 'init']);
  return repo;
}

function assert(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${msg}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  const repoA = makeRepo('projA');
  const repoB = makeRepo('projB');

  const configDir = mkdtempSync(join(tmpdir(), 'orc-cfg-'));
  const configPath = join(configDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      model: 'claude-sonnet-5', // global default
      basePort: 8400,
      projects: [
        { name: 'Alpha', path: repoA }, // inherits global model
        { name: 'Beta', path: repoB, model: 'claude-opus-4-8' }, // overrides model
      ],
    }),
  );

  // --- config resolution (free) ---
  const config = loadConfig({ config: configPath, noMaestro: true });
  const [a, b] = config.projects;
  assert(config.projects.length === 2, 'two projects resolved');
  assert(a.repo === repoA && b.repo === repoB, 'project paths resolved to their repos');
  assert(a.model === 'claude-sonnet-5', 'Alpha inherits global model');
  assert(b.model === 'claude-opus-4-8', 'Beta overrides model');
  assert(a.maestroMcp === undefined && b.maestroMcp === undefined, '--no-maestro applied to all');
  assert(config.basePort === 8400, 'basePort from config');

  // --- end-to-end launch in the SECOND project only ---
  const manager = new AgentManager(config);
  assert(manager.projects().length === 2, 'manager exposes projects');

  const session = await manager.create(
    'Beta',
    'b',
    'PROJ-1',
    "Create a file named hello.txt containing exactly the word 'hi'. Commit it with git. Do NOT build, install deps, or create simulators. Then finish.",
  );
  assert(session.repo === repoB, 'agent routed to Beta repo');
  assert(session.worktree === join(repoB, '.worktrees', 'b'), 'worktree placed under Beta repo');
  assert(session.metroPort >= 8400, 'port allocated from basePort');
  assert(session.getInfo().project === 'Beta', 'agent tagged with project name');

  const ok = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 240_000);
    session.on('update', () => {
      const s = session.getInfo().status;
      if (s === 'done' || s === 'error' || s === 'needs_input') {
        clearTimeout(timer);
        resolve(s !== 'error');
      }
    });
  });

  assert(ok, 'Beta agent reached a non-error terminal state');
  assert(existsSync(join(session.worktree, 'hello.txt')), 'hello.txt created in Beta worktree');
  assert(!existsSync(join(repoA, '.worktrees')), 'Alpha repo untouched');

  console.log('final status:', session.getInfo().status, '· cost $' + session.getInfo().totalCostUsd.toFixed(3));

  await manager.stopAll();
  for (const d of [repoA, repoB, configDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
