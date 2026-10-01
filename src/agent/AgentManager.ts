import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentTemplate, OrcConfig, ProjectConfig } from '../types.js';
import { needsWorktree } from '../types.js';
import { PortAllocator } from '../ports.js';
import { assertGitRepo, createWorktree, removeWorktree, slugify, type Worktree } from '../worktree.js';
import { AgentSession } from './AgentSession.js';
import type { RunPipelineStep } from './launcherTools.js';
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
    // Agents are grouped by project so the sidebar can show a distinct section per project.
    // Within a project, top-level agents are newest-first (most recently created at the top),
    // with each agent's child sessions (e.g. a merge agent) nested immediately beneath their
    // parent. This keeps a parent adjacent to its children and keeps same-project agents
    // contiguous. Projects themselves are ordered by their most recently created agent, so the
    // project you just launched into floats to the top.
    const all = [...this.agents.values()];
    const childrenOf = (parentId: string) =>
      all.filter((a) => a.parentId === parentId); // oldest-first among siblings
    const topLevel = all.filter((a) => !a.parentId).reverse(); // newest-first

    // Preserve the newest-first order of first appearance to order the project groups.
    const groups = new Map<string, AgentSession[]>();
    for (const parent of topLevel) {
      const group = groups.get(parent.project);
      if (group) group.push(parent);
      else groups.set(parent.project, [parent]);
    }

    const ordered: AgentSession[] = [];
    for (const group of groups.values()) {
      for (const parent of group) {
        ordered.push(parent);
        ordered.push(...childrenOf(parent.id));
      }
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
   * Worktree templates (feature + the full-access roles implementer/tester/refactorer — see
   * {@link needsWorktree}) get their own isolated git worktree + branch and an allocated port.
   * Read-only templates (question/launcher/pipeline + architect/explorer/planner/reviewer) and
   * merge agents run without their own worktree/branch/port and are locked to read-only tools
   * inside AgentSession (merge excepted — it runs git in the base repo).
   *
   * `sharedWorktree` overrides worktree creation: when supplied (pipeline role steps), the agent is
   * pointed at that existing worktree/branch instead of cutting a new one, so every role in a
   * pipeline operates on the SAME branch. A read-only role spawned with a shared worktree still runs
   * there (cwd = the shared worktree) so it can see the in-progress work, but gets no port and does
   * not own the worktree's cleanup (the pipeline that created it does).
   */
  async create(
    projectName: string,
    template: AgentTemplate,
    name: string,
    ticket: string,
    prompt: string,
    magicLink?: string,
    parentId?: string,
    sharedWorktree?: Worktree,
  ): Promise<AgentSession> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw new Error(`Unknown project: ${projectName}`);

    await assertGitRepo(project.repo);

    // Merge agents aren't named by the human; auto-name them "merger N", incrementing
    // across the mergers created this session.
    if (template === 'merge') name = this.nextMergerName();

    const id = this.uniqueId(slugify(name));

    // Decide this agent's worktree/branch/port. A pipeline role step reuses the pipeline's shared
    // worktree (and does not own its cleanup). Otherwise, worktree templates cut a fresh isolated
    // worktree + branch and allocate a port; everything else runs in the base repo with none.
    let worktree: Worktree | undefined;
    let ownsWorktree = false;
    let metroPort: number | undefined;
    if (sharedWorktree) {
      // Pipeline role step: point this agent at the pipeline's existing worktree/branch. Only
      // full-access roles actually write there; read-only roles just read the in-progress work.
      worktree = sharedWorktree;
      ownsWorktree = false;
    } else if (needsWorktree(template)) {
      worktree = await createWorktree(project.repo, project.worktreeDir, id);
      ownsWorktree = true;
      const allocator = this.ports.get(project.name);
      metroPort = allocator ? await allocator.allocate() : undefined;
    }

    // A launcher agent is handed a callback its in-process spawn tool uses to create feature agents.
    // Each spawned agent is nested beneath this launcher (parentId = id) so it shows up indented
    // under the launcher in the sidebar.
    const launchFeature =
      template === 'launcher'
        ? async (args: { name: string; prompt: string; ticket: string }) => {
            const child = await this.create(
              projectName,
              'feature',
              args.name,
              args.ticket,
              args.prompt,
              undefined,
              id,
            );
            return { id: child.id, name: child.name };
          }
        : undefined;

    // A pipeline agent owns ONE shared worktree/branch up front (cut here, keyed off the pipeline's
    // id) and is handed a callback its run-step tool uses to spawn role agents on it. Each role is
    // nested beneath the pipeline (parentId = id) and reuses `pipelineWorktree`, so Tester's tests,
    // Implementer's code and Refactorer's cleanup all land on the same branch. The pipeline session
    // owns the worktree's cleanup; the role children do not (ownsWorktree=false via sharedWorktree).
    let pipelineWorktree: Worktree | undefined;
    let runStep: RunPipelineStep | undefined;
    if (template === 'pipeline') {
      pipelineWorktree = await createWorktree(project.repo, project.worktreeDir, id);
      worktree = pipelineWorktree;
      ownsWorktree = true;
      runStep = async (args) => {
        const child = await this.create(
          projectName,
          args.role,
          `${args.role} ${name}`,
          args.ticket,
          args.prompt,
          undefined,
          id,
          pipelineWorktree,
        );
        // Block the pipeline's run-step tool call until the role reaches a terminal state, so the
        // sequence is genuinely sequential and the tool can hand the role's summary back for the
        // pipeline to review before deciding the next step (or going back).
        const outcome = await child.waitUntilFinished();
        return { id: child.id, name: child.name, status: outcome.status, summary: outcome.text };
      };
    }

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
      ownsWorktree,
      metroPort,
      config: project,
      launchFeature,
      runStep,
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

  /** A given agent's first child session (e.g. a launcher's first spawned feature agent), if any. */
  firstChildOf(id: string): AgentSession | undefined {
    return [...this.agents.values()].find((a) => a.parentId === id);
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
    // Clean up the worktree only if this agent owns it. Pipeline role children share their
    // pipeline's worktree (ownsWorktree=false), so they must NOT remove it — the pipeline parent
    // does, after its children are gone (children are removed first, above). Question/merge and
    // read-only-role agents have no worktree at all.
    if (session.worktree && session.ownsWorktree) {
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
