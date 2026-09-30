import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OrcConfig, ProjectConfig } from '../types.js';
import { PortAllocator } from '../ports.js';
import { assertGitRepo, createWorktree, removeWorktree, slugify } from '../worktree.js';
import { AgentSession } from './AgentSession.js';

const STATE_PATH = join(homedir(), '.orc', 'state.json');

/** Owns all agent sessions (across projects) plus their worktree/port lifecycle. Emits 'update'. */
export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, AgentSession>();
  private readonly ports: PortAllocator;

  constructor(private readonly config: OrcConfig) {
    super();
    this.ports = new PortAllocator(config.basePort);
  }

  /** The projects agents can be launched into. */
  projects(): ProjectConfig[] {
    return this.config.projects;
  }

  list(): AgentSession[] {
    // Newest first: the most recently created agent shows at the top.
    return [...this.agents.values()].reverse();
  }

  get(id: string): AgentSession | undefined {
    return this.agents.get(id);
  }

  /** First agent currently asking for input/approval, if any. */
  firstWaiting(): AgentSession | undefined {
    return this.list().find((a) => {
      const s = a.getInfo().status;
      return s === 'needs_input' || s === 'needs_approval';
    });
  }

  /** Create a worktree + port + session in the named project and launch it. */
  async create(
    projectName: string,
    name: string,
    ticket: string,
    prompt: string,
    magicLink?: string,
  ): Promise<AgentSession> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw new Error(`Unknown project: ${projectName}`);

    await assertGitRepo(project.repo);

    const id = this.uniqueId(slugify(name));
    const { path, branch } = await createWorktree(project.repo, project.worktreeDir, id);
    const metroPort = await this.ports.allocate();

    const session = new AgentSession({
      id,
      name,
      ticket,
      prompt,
      magicLink: magicLink ?? project.magicLink,
      branch,
      worktree: path,
      metroPort,
      config: project,
    });
    session.on('update', () => this.emit('update'));
    this.agents.set(id, session);
    session.start();
    this.persist();
    this.emit('update');
    return session;
  }

  /** Stop and remove an agent, cleaning up its worktree and releasing its port. */
  async remove(id: string): Promise<void> {
    const session = this.agents.get(id);
    if (!session) return;
    await session.stop();
    this.agents.delete(id);
    this.ports.release(session.metroPort);
    try {
      await removeWorktree(session.repo, session.worktree);
    } catch (err) {
      // Non-fatal: a dirty/locked worktree may need manual cleanup.
      this.emit('log', `worktree cleanup failed for ${id}: ${(err as Error).message}`);
    }
    this.persist();
    this.emit('update');
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((a) => a.stop()));
  }

  private uniqueId(base: string): string {
    if (!this.agents.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!this.agents.has(candidate)) return candidate;
    }
  }

  private persist(): void {
    try {
      mkdirSync(join(homedir(), '.orc'), { recursive: true });
      const state = this.list().map((a) => {
        const info = a.getInfo();
        return {
          id: info.id,
          name: info.name,
          project: info.project,
          ticket: info.ticket,
          branch: info.branch,
          worktree: info.worktree,
          metroPort: info.metroPort,
          sessionId: info.sessionId,
          status: info.status,
        };
      });
      writeFileSync(STATE_PATH, JSON.stringify({ agents: state }, null, 2));
    } catch {
      /* persistence is best-effort */
    }
  }
}
