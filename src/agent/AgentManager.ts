import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentTemplate, OrcConfig, ProjectConfig } from '../types.js';
import { PortAllocator } from '../ports.js';
import { assertGitRepo, createWorktree, removeWorktree, slugify } from '../worktree.js';
import { AgentSession } from './AgentSession.js';
import { NEEDS_INPUT } from '../agentPrompt.js';

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
    // Top-level agents newest-first (most recently created at the top), with each agent's
    // child sessions (e.g. a merge agent) nested immediately beneath their parent. This fixes
    // the display/navigation order so a parent is always adjacent to its children.
    const all = [...this.agents.values()];
    const childrenOf = (parentId: string) =>
      all.filter((a) => a.parentId === parentId); // oldest-first among siblings
    const topLevel = all.filter((a) => !a.parentId).reverse();
    const ordered: AgentSession[] = [];
    for (const parent of topLevel) {
      ordered.push(parent);
      ordered.push(...childrenOf(parent.id));
    }
    return ordered;
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
    parentId?: string,
  ): Promise<AgentSession> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw new Error(`Unknown project: ${projectName}`);

    await assertGitRepo(project.repo);

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
      parentId,
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

  /** A given agent's child merge session, if one has already been spawned. */
  mergeChildOf(id: string): AgentSession | undefined {
    return [...this.agents.values()].find((a) => a.parentId === id && a.template === 'merge');
  }

  /**
   * Spawn a merge agent nested under the given feature agent to integrate its branch into the
   * project's base branch. The merge agent is a child session (shown indented beneath its parent
   * in the sidebar) that runs in the base repo — NOT in the parent's worktree — so it can safely
   * delete the parent's branch and worktree once the merge lands, which the parent can't do to
   * itself without destroying its own working directory. The branch name is woven into the
   * prompt so the child starts merging immediately. Only one merge child is kept per parent: a
   * repeat request reselects the existing child instead of spawning a duplicate.
   */
  async mergeAgent(id: string): Promise<AgentSession> {
    const source = this.agents.get(id);
    if (!source) throw new Error(`Unknown agent: ${id}`);
    const branch = source.branch;
    if (!branch) {
      throw new Error(`Agent "${source.name}" has no branch to merge (not a feature agent).`);
    }
    const existing = this.mergeChildOf(id);
    if (existing) return existing;
    const project = this.config.projects.find((p) => p.name === source.project);
    const baseBranch = project?.baseBranch;
    const worktreeNote = source.worktree ? `Its worktree is at \`${source.worktree}\`. ` : '';
    const cleanupNote = `After the merge lands cleanly and you've verified it, delete the \`${branch}\` branch${
      source.worktree ? ` and remove its worktree` : ''
    }.`;
    // With a configured base branch, merge straight into it. Without one, the agent must figure
    // out the target (preferring develop/development, then master/main) and confirm with the human
    // before merging, since we don't want to guess the integration branch.
    const target = baseBranch
      ? `Merge the branch \`${branch}\` into \`${baseBranch}\` (the project's configured base branch). `
      : `Merge the branch \`${branch}\` into the project's base branch. No base branch is configured, so ` +
        `determine the target yourself: prefer \`develop\` or \`development\` if either exists, otherwise ` +
        `\`master\` or \`main\`. Once you've picked the target, confirm it with the human (ending your turn ` +
        `with ${NEEDS_INPUT}) BEFORE running the merge. `;
    const prompt = `${target}${worktreeNote}${cleanupNote}`;
    return this.create(source.project, 'merge', `merge ${branch}`, '', prompt, undefined, id);
  }

  /** Stop and remove an agent, cleaning up its worktree and releasing its port. */
  async remove(id: string): Promise<void> {
    const session = this.agents.get(id);
    if (!session) return;

    // Removing a parent also removes its nested children (e.g. a merge agent): they only exist
    // in service of the parent, so leaving them orphaned in the sidebar would be confusing.
    const children = [...this.agents.values()].filter((a) => a.parentId === id);
    for (const child of children) await this.remove(child.id);

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
          parentId: info.parentId,
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
