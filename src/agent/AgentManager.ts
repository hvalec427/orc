import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentTemplate, OrcConfig, ProjectConfig } from '../types.js';
import { PortAllocator } from '../ports.js';
import { assertGitRepo, createWorktree, removeWorktree, slugify } from '../worktree.js';
import { AgentSession } from './AgentSession.js';

const STATE_PATH = join(homedir(), '.orc', 'state.json');

/** Owns all agent sessions (across projects) plus their worktree/port lifecycle. Emits 'update'. */
export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, AgentSession>();
  /** One port allocator per project that defines a range (keyed by project name). */
  private readonly ports = new Map<string, PortAllocator>();

  constructor(private readonly config: OrcConfig) {
    super();
    for (const project of config.projects) {
      if (project.portRange) this.ports.set(project.name, new PortAllocator(project.portRange));
    }
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

  /**
   * Create and launch an agent in the named project.
   *
   * `feature` agents get their own git worktree + branch and an allocated port. `question`
   * and `merge` agents run directly in the project's base repo with no worktree, branch, or
   * port (a question agent is additionally locked to read-only tools inside AgentSession).
   */
  async create(
    projectName: string,
    template: AgentTemplate,
    name: string,
    ticket: string,
    prompt: string,
    magicLink?: string,
  ): Promise<AgentSession> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw new Error(`Unknown project: ${projectName}`);

    await assertGitRepo(project.repo);

    // Merge agents aren't named by the human; auto-name them "merger N", incrementing
    // across the mergers created this session.
    if (template === 'merge') name = this.nextMergerName();

    const id = this.uniqueId(slugify(name));

    // Only feature agents get an isolated worktree/branch/port; question & merge agents
    // operate on the base repo itself.
    const isFeature = template === 'feature';
    const worktree = isFeature
      ? await createWorktree(project.repo, project.worktreeDir, id)
      : undefined;
    const allocator = isFeature ? this.ports.get(project.name) : undefined;
    const metroPort = allocator ? await allocator.allocate() : undefined;

    const session = new AgentSession({
      id,
      name,
      template,
      ticket,
      prompt,
      magicLink: magicLink ?? project.magicLink,
      branch: worktree?.branch,
      worktree: worktree?.path,
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
    if (session.metroPort !== undefined) {
      this.ports.get(session.project)?.release(session.metroPort);
    }
    // Question/merge agents have no worktree to clean up.
    if (session.worktree) {
      try {
        await removeWorktree(session.repo, session.worktree);
      } catch (err) {
        // Non-fatal: a dirty/locked worktree may need manual cleanup.
        this.emit('log', `worktree cleanup failed for ${id}: ${(err as Error).message}`);
      }
    }
    this.persist();
    this.emit('update');
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((a) => a.stop()));
  }

  /** Next sequential "merger N" name, counting existing merge agents this session. */
  private nextMergerName(): string {
    const mergers = this.list().filter((a) => a.template === 'merge').length;
    return `merger ${mergers + 1}`;
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
          template: info.template,
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
