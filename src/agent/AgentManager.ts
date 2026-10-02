import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentTemplate, OrcConfig, ProjectConfig } from '../types.js';
import { needsWorktree, isWorkerTemplate } from '../types.js';
import { PortAllocator } from '../ports.js';
import { assertGitRepo, createWorktree, removeWorktree, slugify, type Worktree } from '../worktree.js';
import { AgentSession } from './AgentSession.js';
import type { LaunchTemplate, RunPipelineStep, EnsureWorktree } from './launcherTools.js';
import type {
  AskOrchestrator,
  AskSubagent,
  AnswerSubagent,
  ListSubagents,
  SubagentInfo,
} from './orchestratorTools.js';
import { NEEDS_INPUT } from '../agentPrompt.js';

/** How long a cross-agent orchestration request waits before giving up (ms). */
const ORCHESTRATION_TIMEOUT_MS = 10 * 60 * 1000;

const STATE_PATH = join(homedir(), '.orc', 'state.json');

/** Owns all agent sessions (across projects) plus their worktree/port lifecycle. Emits 'update'. */
export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, AgentSession>();
  /** One port allocator per project that defines a range (keyed by project name). */
  private readonly ports = new Map<string, PortAllocator>();
  /**
   * Subagents currently blocked in `ask_orchestrator`, keyed by the asking child's id. The value
   * resolves the child's pending promise with the orchestrator's (or human's) answer text. A child
   * can only have one question outstanding at a time; a new ask supersedes the old (resolved with a
   * note) so the bus never leaks a dangling waiter.
   */
  private readonly pendingParentAsks = new Map<string, (answer: string) => void>();

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

  /** Non-archived agents, in sidebar order. The active list the human navigates by default. */
  active(): AgentSession[] {
    return this.list().filter((a) => !a.getInfo().archived);
  }

  /** Archived agents, in sidebar order. Shown collapsed in the sidebar's "Done" section. */
  archived(): AgentSession[] {
    return this.list().filter((a) => a.getInfo().archived);
  }

  /** First active agent currently asking for input/approval, if any (archived agents are skipped). */
  firstWaiting(): AgentSession | undefined {
    return this.active().find((a) => {
      const s = a.getInfo().status;
      return s === 'needs_input' || s === 'needs_approval';
    });
  }

  /**
   * Create and launch an agent in the named project.
   *
   * Worktree templates (feature + the full-access roles implementer/tester/refactorer — see
   * {@link needsWorktree}) get their own isolated git worktree + branch and an allocated port.
   * Read-only templates (launcher/pipeline + architect/explorer/planner/reviewer) and
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

    // Integrate agents aren't named by the human; auto-name them "integrator N", incrementing
    // across the integrators created this session.
    if (template === 'merge') name = this.nextIntegratorName();

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

    // A launcher agent is handed a callback its in-process spawn tool uses to create agents. The
    // launcher chooses the template per group (feature/fix/explorer/pipeline); create() then applies
    // that template's own worktree/port rules. Each spawned agent is nested beneath this launcher
    // (parentId = id) so it shows up indented under the launcher in the sidebar.
    const launchFeature =
      template === 'launcher'
        ? async (args: { template: LaunchTemplate; name: string; prompt: string; ticket: string }) => {
            const child = await this.create(
              projectName,
              args.template,
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

    // A general-purpose worker starts with no worktree and cuts+adopts one ON DEMAND the first time
    // a task needs code changes. Its `create_worktree` tool calls back here: we cut a worktree keyed
    // off the worker's id (branch `agent/<id>`), allocate a port if the project has a range, and have
    // the session adopt it so its NEXT launch runs inside it. Idempotent — a repeat call just reports
    // the worktree it already has. `session` is assigned just below, before the session starts, so by
    // the time the worker could invoke the tool (during a turn) the closure's reference is set.
    let session: AgentSession;
    const cutWorktreeOnDemand: EnsureWorktree | undefined = isWorkerTemplate(template)
      ? async () => {
          if (session.worktree && session.branch) {
            return { branch: session.branch, path: session.worktree, port: session.metroPort, alreadyHad: true };
          }
          const wt = await createWorktree(project.repo, project.worktreeDir, id);
          const allocator = this.ports.get(project.name);
          const port = allocator ? await allocator.allocate() : undefined;
          session.adoptWorktree(wt, port, true);
          this.persist();
          return { branch: wt.branch, path: wt.path, port, alreadyHad: false };
        }
      : undefined;

    // Every agent gets the group orchestration callbacks (scoped to its own id): as a parent it can
    // list/ask/answer its subagents; as a child it can ask its orchestrator. They are harmless no-ops
    // for an agent with no subagents and no parent, so they're wired unconditionally.
    const orchestration = this.orchestrationCallbacks(id);

    session = new AgentSession({
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
      cutWorktreeOnDemand,
      orchestration,
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

  /** A given agent's child cleanup session, if one has already been spawned. */
  cleanupChildOf(id: string): AgentSession | undefined {
    return [...this.agents.values()].find((a) => a.parentId === id && a.template === 'worker');
  }

  /** A given agent's first child session (e.g. a launcher's first spawned feature agent), if any. */
  firstChildOf(id: string): AgentSession | undefined {
    return [...this.agents.values()].find((a) => a.parentId === id);
  }

  /** All of a given agent's direct child sessions, oldest-first. */
  childrenOf(id: string): AgentSession[] {
    return [...this.agents.values()].filter((a) => a.parentId === id);
  }

  /**
   * Top-level agents in sidebar order (same ordering as {@link list}, children filtered out). This is
   * the row of "main" agents j/k steps through while the selection is on a parent.
   */
  topLevel(): AgentSession[] {
    return this.list().filter((a) => !a.parentId && !a.getInfo().archived);
  }

  /**
   * The top-level agent `delta` steps from the given agent, clamped to the ends (no wrap). `id` may be
   * a child: it resolves to that child's group root first, so pressing j/k while nested still lands on
   * the adjacent PARENT. Returns the agent itself when there is nowhere to move.
   */
  topLevelSibling(id: string, delta: number): AgentSession | undefined {
    const tops = this.topLevel();
    if (tops.length === 0) return undefined;
    const root = this.groupRootOf(id);
    const idx = tops.findIndex((a) => a.id === root.id);
    if (idx === -1) return root;
    const next = Math.max(0, Math.min(idx + delta, tops.length - 1));
    return tops[next];
  }

  /**
   * The child `delta` steps from the given child among its parent's children, clamped to the ends (no
   * wrap). Returns undefined if the agent is not a child. Used by j/k once the selection has descended
   * into a parent's subagents, so navigation stays within that group.
   */
  siblingOf(id: string, delta: number): AgentSession | undefined {
    const agent = this.agents.get(id);
    if (!agent?.parentId) return undefined;
    const siblings = this.childrenOf(agent.parentId);
    const idx = siblings.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    const next = Math.max(0, Math.min(idx + delta, siblings.length - 1));
    return siblings[next];
  }

  /**
   * The group root (top-level orchestrator) for an agent: walk up parentId links to the agent with
   * no parent. The hierarchy is at most two levels deep — a top-level agent and its direct children —
   * so this resolves a child to its parent and a parent to itself.
   */
  groupRootOf(id: string): AgentSession {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    if (!agent.parentId) return agent;
    return this.agents.get(agent.parentId) ?? agent;
  }

  /**
   * Launch a subagent under an agent's group. The new agent is nested directly beneath the group ROOT
   * (so every subagent is one flat level under a single orchestrator parent — children never have
   * children of their own), and shares the group's ONE worktree/branch:
   *   - If the group root already has a worktree, the subagent reuses it (ownsWorktree=false).
   *   - If the group root has none (e.g. an explorer/launcher parent running in the base repo), a
   *     worktree is created now and the ROOT adopts it, so the parent and all its subagents operate
   *     on the same branch from then on.
   * Read-only subagents can safely run in parallel with an editing sibling (they are denied mutating
   * tools); editing subagents should be sequenced by the orchestrator to avoid clobbering the tree.
   */
  async createSubagent(
    parentId: string,
    template: AgentTemplate,
    name: string,
    ticket: string,
    prompt: string,
    magicLink?: string,
  ): Promise<AgentSession> {
    const root = this.groupRootOf(parentId);
    const project = this.config.projects.find((p) => p.name === root.project);
    if (!project) throw new Error(`Unknown project: ${root.project}`);

    // Resolve the shared worktree: reuse the root's, or create one and have the root adopt it.
    let shared: Worktree;
    if (root.worktree && root.branch) {
      shared = { path: root.worktree, branch: root.branch };
    } else {
      shared = await createWorktree(project.repo, project.worktreeDir, root.id);
      root.adoptWorktree(shared);
    }

    return this.create(root.project, template, name, ticket, prompt, magicLink, root.id, shared);
  }

  // ---- orchestration message bus ------------------------------------------
  //
  // A group (one top-level orchestrator + its direct subagents) coordinates through three callbacks
  // the AgentSession exposes as in-process MCP tools, so agents work together without the human
  // relaying every message:
  //   - listSubagentsOf  → the orchestrator's `list_subagents`
  //   - askChild         → the orchestrator's `ask_subagent`   (parent → child, blocks for a result)
  //   - answerChild      → the orchestrator's `answer_subagent`(parent → a child waiting on it)
  //   - askParent        → a subagent's `ask_orchestrator`     (child → parent, blocks for an answer)
  // Each is built per-agent in {@link create} and scoped to that agent's place in its group.

  /** The hand-off view of one agent (its latest final-turn text) for a parent's `list_subagents`. */
  private subagentInfo(a: AgentSession): SubagentInfo {
    const info = a.getInfo();
    return {
      id: info.id,
      name: info.name,
      template: info.template,
      status: info.status,
      summary: a.lastSummary(),
    };
  }

  /** The direct subagents of `parentId`, as the parent sees them (for `list_subagents`). */
  private listSubagentsOf(parentId: string): SubagentInfo[] {
    return this.childrenOf(parentId).map((a) => this.subagentInfo(a));
  }

  /**
   * Parent → child: deliver `question` into the subagent's session and WAIT for it to finish its
   * turn, returning its final hand-off text. Rejects when the child isn't a direct subagent of the
   * asking parent (scoping), resolves immediately with the child's last summary if it's already
   * finished. Times out rather than hanging forever.
   */
  private async askChild(parentId: string, childId: string, question: string): Promise<{ status: string; answer: string }> {
    const child = this.agents.get(childId);
    if (!child || child.parentId !== parentId) {
      throw new Error(`"${childId}" is not one of your subagents.`);
    }
    // If the child is waiting on the human (needs_input), that turn is reserved for the human —
    // sending now would hijack it. Refuse so only the human answers the subagent's question.
    if (child.getInfo().status === 'needs_input') {
      const pending = child.getInfo().question?.trim();
      throw new Error(
        `Subagent "${child.name}" is waiting for human input and cannot be asked right now` +
          (pending ? `; it asked the human: ${pending}` : '') +
          '. Wait for the human to answer it before asking again.',
      );
    }
    // Deliver the question (continues a live turn or resumes a finished child), then wait for the
    // turn to reach a terminal state so we can hand its summary back to the asking parent.
    child.send(question);
    const outcome = await this.withTimeout(
      child.waitUntilFinished(),
      `subagent "${child.name}" did not respond in time`,
    );
    return { status: outcome.status, answer: outcome.text };
  }

  /**
   * Parent → child: answer a subagent that is blocked in `ask_orchestrator`. If the child is waiting,
   * resolve its pending promise so it continues; otherwise deliver the answer as an ordinary message.
   * Rejects when the child isn't a direct subagent of the answering parent (scoping).
   */
  private answerChild(parentId: string, childId: string, answer: string): { delivered: boolean } {
    const child = this.agents.get(childId);
    if (!child || child.parentId !== parentId) {
      throw new Error(`"${childId}" is not one of your subagents.`);
    }
    const waiter = this.pendingParentAsks.get(childId);
    if (waiter) {
      this.pendingParentAsks.delete(childId);
      waiter(answer);
      return { delivered: true };
    }
    // Not currently waiting — treat the answer as a normal reply into its session.
    child.send(answer);
    return { delivered: false };
  }

  /**
   * Child → parent: block until the orchestrator (or the human on its behalf) answers. The question
   * is surfaced on the parent via {@link AgentSession.receiveSubagentQuestion} so the orchestrator's
   * next turn sees it and can call `answer_subagent`; the human can also answer directly. Falls back
   * to a "no response" answer on timeout or a missing/dead parent so the child never hangs forever.
   */
  private askParent(childId: string, question: string): Promise<{ answer: string }> {
    const child = this.agents.get(childId);
    const parent = child?.parentId ? this.agents.get(child.parentId) : undefined;
    if (!parent) {
      // A top-level agent (or an orphaned child) has no orchestrator to ask.
      return Promise.resolve({
        answer:
          'You have no orchestrator to ask — you are a top-level agent. Decide yourself, or end your ' +
          `turn with ${NEEDS_INPUT} to ask the human directly.`,
      });
    }
    // Supersede any previous outstanding ask from this child so we never leak a waiter.
    const prior = this.pendingParentAsks.get(childId);
    if (prior) {
      this.pendingParentAsks.delete(childId);
      prior('(superseded by a newer question)');
    }
    const answer = new Promise<string>((resolve) => {
      this.pendingParentAsks.set(childId, resolve);
    });
    // Let the parent's session (and the TUI) know a subagent is waiting on it.
    parent.receiveSubagentQuestion(child!.name, child!.id, question);
    return this.withTimeout(
      answer.then((text) => ({ answer: text })),
      `orchestrator "${parent.name}" did not answer in time`,
    ).catch((err) => {
      this.pendingParentAsks.delete(childId);
      return { answer: `(no response: ${(err as Error).message})` };
    });
  }

  /** Reject a promise if it doesn't settle within the orchestration timeout. */
  private withTimeout<T>(p: Promise<T>, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ORCHESTRATION_TIMEOUT_MS);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /** Build the orchestration callbacks a session at `id` exposes as its in-process MCP tools. */
  private orchestrationCallbacks(id: string): {
    listSubagents: ListSubagents;
    askSubagent: AskSubagent;
    answerSubagent: AnswerSubagent;
    askOrchestrator: AskOrchestrator;
  } {
    return {
      listSubagents: () => this.listSubagentsOf(id),
      askSubagent: (args) => this.askChild(id, args.childId, args.question),
      answerSubagent: (args) => Promise.resolve(this.answerChild(id, args.childId, args.answer)),
      askOrchestrator: (args) => this.askParent(id, args.question),
    };
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
      throw new Error(`Agent "${source.name}" has no branch to integrate (not a feature agent).`);
    }
    const existing = this.mergeChildOf(id);
    if (existing) return existing;
    const project = this.config.projects.find((p) => p.name === source.project);
    const baseBranch = project?.baseBranch;
    const worktreeNote = source.worktree ? `Its worktree is at \`${source.worktree}\`. ` : '';
    const cleanupNote = `After the branch lands cleanly and you've verified it, delete the \`${branch}\` branch${
      source.worktree ? ` and remove its worktree` : ''
    }.`;
    // With a configured base branch, integrate straight into it. Without one, the agent must figure
    // out the target (preferring develop/development, then master/main) and confirm with the human
    // before integrating, since we don't want to guess the integration branch. The actual
    // strategy (merge/rebase/squash) comes from the injected merge-agent prompt.
    const target = baseBranch
      ? `Integrate the branch \`${branch}\` into \`${baseBranch}\` (the project's configured base branch). `
      : `Integrate the branch \`${branch}\` into the project's base branch. No base branch is configured, so ` +
        `determine the target yourself: prefer \`develop\` or \`development\` if either exists, otherwise ` +
        `\`master\` or \`main\`. Once you've picked the target, confirm it with the human (ending your turn ` +
        `with ${NEEDS_INPUT}) BEFORE integrating. `;
    const prompt = `${target}${worktreeNote}${cleanupNote}`;
    return this.create(source.project, 'merge', `merge ${branch}`, '', prompt, undefined, id);
  }

  /**
   * Spawn a cleanup worker nested under the given agent to tear down its worktree and branch. Like a
   * merge agent, the cleanup worker is a child session that runs in the base repo — NOT in the source
   * agent's worktree — because an agent can't remove its own working directory without killing its own
   * session. A `worker` template starts with no worktree of its own, so it stays in the base repo and
   * can safely run `git worktree remove` / `git branch -D` against the source. The source's branch and
   * worktree path are woven into the prompt so the worker acts immediately. Only one cleanup child is
   * kept per parent: a repeat request reselects the existing child instead of spawning a duplicate.
   */
  async cleanupAgent(id: string): Promise<AgentSession> {
    const source = this.agents.get(id);
    if (!source) throw new Error(`Unknown agent: ${id}`);
    const branch = source.branch;
    const worktree = source.worktree;
    if (!branch || !worktree) {
      throw new Error(`Agent "${source.name}" has no worktree to clean up.`);
    }
    const existing = this.cleanupChildOf(id);
    if (existing) return existing;
    const prompt =
      `Clean up the worktree and branch left behind by another agent. Its worktree is at ` +
      `\`${worktree}\` on branch \`${branch}\`. You are running in the base repository, NOT inside that ` +
      `worktree, so you can safely remove it. Remove the worktree with \`git worktree remove ${worktree} ` +
      `--force\`, then delete the branch with \`git branch -D ${branch}\`. Never touch any other agent's ` +
      `worktree or branch, and never remove your own working directory. Confirm both are gone ` +
      `(\`git worktree list\` / \`git branch\`) and report what you removed.`;
    return this.create(source.project, 'worker', `cleanup ${branch}`, '', prompt, undefined, id);
  }

  /**
   * Archive an agent: hide it in the sidebar's "Done" section and exclude it from integrate. This is
   * non-destructive — it does NOT stop the session, nor touch/move/remove the worktree or branch, nor
   * release the port. The session keeps running and can still be resumed and read. Archiving a parent
   * cascades to its nested children (mirrors {@link remove}), so a whole group collapses together.
   */
  async archive(id: string): Promise<void> {
    const session = this.agents.get(id);
    if (!session) return;
    session.setArchived(true);
    for (const child of this.childrenOf(id)) child.setArchived(true);
    this.persist();
    this.emit('update');
  }

  /** Unarchive an agent, returning it to the active list. Does not touch its children. */
  async unarchive(id: string): Promise<void> {
    const session = this.agents.get(id);
    if (!session) return;
    session.setArchived(false);
    this.persist();
    this.emit('update');
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
    // If this child was blocked on its orchestrator, release the waiter so nothing dangles.
    const waiter = this.pendingParentAsks.get(id);
    if (waiter) {
      this.pendingParentAsks.delete(id);
      waiter('(the subagent was removed)');
    }
    if (session.metroPort !== undefined) {
      this.ports.get(session.project)?.release(session.metroPort);
    }
    // Clean up the worktree only if this agent owns it. Pipeline role children share their
    // pipeline's worktree (ownsWorktree=false), so they must NOT remove it — the pipeline parent
    // does, after its children are gone (children are removed first, above). Merge and
    // read-only (launcher/pipeline/role) agents have no worktree at all.
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

  /** Next sequential "integrator N" name, counting existing integrate agents this session. */
  private nextIntegratorName(): string {
    const integrators = this.list().filter((a) => a.template === 'merge').length;
    return `integrator ${integrators + 1}`;
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
          archived: info.archived,
        };
      });
      writeFileSync(STATE_PATH, JSON.stringify({ agents: state }, null, 2));
    } catch {
      /* persistence is best-effort */
    }
  }
}
