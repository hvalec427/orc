import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * A tool definition on the in-process "orc" MCP server. `tool()` returns a `SdkMcpToolDefinition`
 * keyed to its specific input schema; `createSdkMcpServer({ tools })` accepts an array of these with
 * mixed schemas. We let the builders infer their concrete element types and only widen here, at the
 * single composition point, by accepting the same array type the SDK does.
 */
export type OrcTool = Parameters<typeof buildOrcServer>[0][number];

/**
 * The orchestration channel every agent gets so a group can work together without the human relaying
 * messages by hand. A group is one top-level agent (the ORCHESTRATOR) plus its direct subagents, all
 * sharing one worktree/branch. These callbacks are supplied by the AgentSession (closures into the
 * AgentManager) so the MCP tools can reach the other sessions in the same group.
 */

/** One subagent as seen by its orchestrator: who it is, its state, and its latest hand-off summary. */
export interface SubagentInfo {
  id: string;
  name: string;
  template: string;
  status: string;
  /** The subagent's most recent final-turn text (its hand-off summary, or its last question). */
  summary: string;
}

/** List the orchestrator's direct subagents (empty when it has none yet). */
export type ListSubagents = () => SubagentInfo[];

/**
 * Ask one subagent a question and WAIT for its answer. Delivers the question into the subagent's
 * session and blocks until it finishes its turn, returning its final hand-off text. If the subagent
 * is already finished, returns its last summary immediately. Times out rather than hanging forever.
 */
export type AskSubagent = (args: {
  childId: string;
  question: string;
}) => Promise<{ status: string; answer: string }>;

/**
 * Answer a subagent that is waiting on its orchestrator (it called `ask_orchestrator`). Resolves the
 * subagent's pending question with this text so it can continue. If the subagent is not currently
 * waiting, the answer is delivered to it as a normal message instead.
 */
export type AnswerSubagent = (args: {
  childId: string;
  answer: string;
}) => Promise<{ delivered: boolean }>;

/**
 * Ask the orchestrator (this subagent's parent) a question and WAIT for its answer. Blocks until the
 * orchestrator answers (via `answer_subagent`) or the human answers directly, then returns the text.
 * Falls back to a "no response" answer on timeout / dead orchestrator so the subagent never hangs.
 */
export type AskOrchestrator = (args: { question: string }) => Promise<{ answer: string }>;

/**
 * Post a one-line progress note to the orchestrator's log. Fire-and-forget: it does not block the
 * subagent and does not drive the orchestrator's turn — it only surfaces the note in the parent's
 * view so the human can track the whole group by watching the orchestrator. Returns whether the note
 * reached a parent (false for a top-level agent with no orchestrator).
 */
export type ReportToOrchestrator = (args: { note: string }) => { delivered: boolean };

/**
 * The agent templates any agent may spawn as a subagent on its own. These are the self-contained,
 * standalone kinds that make sense to delegate a chunk of work to: a full-access `feature` agent for
 * new work, a surgical `fix` agent for a bug, a read-only `explorer` for investigation, or a
 * general-purpose `worker`. Orchestrator-internal templates (merge, launcher, pipeline) and the seven
 * pipeline role templates are intentionally excluded — those are driven by their own machinery.
 */
export const SPAWNABLE_TEMPLATES = ['feature', 'fix', 'explorer', 'worker'] as const;

/** One of the templates an agent may spawn as a subagent; the `template` arg of `spawn_subagent`. */
export type SpawnableTemplate = (typeof SPAWNABLE_TEMPLATES)[number];

/**
 * Spawn ONE subagent in this agent's group and return its final (uniquified) id + name. Supplied by
 * the AgentSession (a closure into the AgentManager) so the tool can create a nested agent that shares
 * the group's worktree/branch and shows up in the TUI beneath this agent.
 */
export type SpawnSubagent = (args: {
  template: SpawnableTemplate;
  name: string;
  prompt: string;
  ticket: string;
}) => Promise<{ id: string; name: string }>;

export interface OrchestratorCallbacks {
  listSubagents: ListSubagents;
  askSubagent: AskSubagent;
  answerSubagent: AnswerSubagent;
}

/**
 * Build the parent-side orchestration tools (server name "orc" so tools are `mcp__orc__*`). Given to
 * every agent; when the agent has no subagents yet, `list_subagents` just returns an empty list and
 * `ask_subagent`/`answer_subagent` report that the target isn't one of its subagents.
 */
export function buildOrchestratorTools(cb: OrchestratorCallbacks) {
  return [
    tool(
      'list_subagents',
      'List YOUR subagents (the agents you launched in this group), with each one\u2019s id, ' +
        'template, current status and latest hand-off summary. Use this to see what your group is ' +
        'doing before you ask one of them for details or coordinate their work.',
      {},
      async () => {
        const subs = cb.listSubagents();
        const text = subs.length
          ? subs
              .map(
                (s) =>
                  `- ${s.name} (id: ${s.id}, ${s.template}, ${s.status})` +
                  `${s.summary ? `: ${s.summary}` : ''}`,
              )
              .join('\n')
          : '(you have no subagents yet — launch one from the TUI with "c")';
        return { content: [{ type: 'text', text }] };
      },
    ),
    tool(
      'ask_subagent',
      'Ask ONE of your subagents a question and WAIT for its answer. Use this to find out what ' +
        'another agent in your group did, or to tell it what to do next, without the human relaying ' +
        'messages. Identify the subagent by its id (see list_subagents). Returns the subagent\u2019s ' +
        'final answer / hand-off summary.',
      {
        childId: z.string().min(1).describe('The id of the subagent to ask (from list_subagents).'),
        question: z
          .string()
          .min(1)
          .describe('The question or instruction to send the subagent. Be self-contained.'),
      },
      async (args) => {
        try {
          const res = await cb.askSubagent({ childId: args.childId, question: args.question });
          return {
            content: [
              { type: 'text', text: `Subagent (${res.status}) answered:\n${res.answer || '(no answer text)'}` },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Failed to ask subagent: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    ),
    tool(
      'answer_subagent',
      'Answer a subagent that is waiting on you (it asked you a question via ask_orchestrator). ' +
        'Provide the subagent\u2019s id and your answer so it can continue.',
      {
        childId: z.string().min(1).describe('The id of the subagent to answer.'),
        answer: z.string().min(1).describe('Your answer to the subagent\u2019s question.'),
      },
      async (args) => {
        try {
          const res = await cb.answerSubagent({ childId: args.childId, answer: args.answer });
          return {
            content: [
              {
                type: 'text',
                text: res.delivered
                  ? 'Answer delivered to the subagent.'
                  : 'The subagent was not waiting; your answer was sent to it as a message.',
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Failed to answer subagent: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    ),
  ];
}

/**
 * Build the child-side orchestration tools (server name "orc"). Given to every subagent so it can
 * ask its orchestrator for a decision/data (`ask_orchestrator`, blocks for an answer) and post
 * fire-and-forget progress notes to the orchestrator's log (`report_to_orchestrator`).
 */
export function buildSubagentTools(
  askOrchestrator: AskOrchestrator,
  reportToOrchestrator: ReportToOrchestrator,
) {
  return [
    tool(
      'ask_orchestrator',
      'Ask your ORCHESTRATOR (the agent that launched you) a question and WAIT for its answer. Use ' +
        'this when you need a decision, context, or data that your orchestrator or a sibling agent ' +
        'has. Returns the orchestrator\u2019s answer.',
      {
        question: z.string().min(1).describe('The question to ask your orchestrator. Be specific.'),
      },
      async (args) => {
        try {
          const res = await askOrchestrator({ question: args.question });
          return {
            content: [
              { type: 'text', text: `Orchestrator answered:\n${res.answer || '(no answer text)'}` },
            ],
          };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `Failed to ask orchestrator: ${(err as Error).message}` },
            ],
            isError: true,
          };
        }
      },
    ),
    tool(
      'report_to_orchestrator',
      'Post a SHORT progress note (one line) to your orchestrator\u2019s log so the human can track ' +
        'your work by watching the orchestrator. Fire-and-forget: it does NOT block you and expects ' +
        'no answer. Call it at each important milestone and when you finish. For a question you need ' +
        'answered, use ask_orchestrator instead.',
      {
        note: z
          .string()
          .min(1)
          .describe('A short, self-contained progress note (e.g. "tests green, starting refactor").'),
      },
      async (args) => {
        const res = reportToOrchestrator({ note: args.note });
        return {
          content: [
            {
              type: 'text',
              text: res.delivered
                ? 'Reported to your orchestrator.'
                : 'You have no orchestrator — the note was not delivered (you are a top-level agent).',
            },
          ],
        };
      },
    ),
  ];
}

/**
 * Build the self-service spawn tool (server name "orc"). Given to EVERY agent so it can delegate a
 * chunk of work to a fresh subagent on its own — either because the human asked it to, or because the
 * work is better suited to a different kind of agent (e.g. a read-only explorer for deep investigation,
 * a surgical fix agent for a bug). The spawned subagent joins this agent's group (nested beneath its
 * group root, sharing the group's worktree/branch) and appears in the TUI so the human can follow it.
 */
export function buildSpawnSubagentTool(spawn: SpawnSubagent) {
  return [
    tool(
      'spawn_subagent',
      'Spawn ONE subagent to carry out a chunk of work, and get back its id + name. Use this when ' +
        'the human asks you to start another agent, OR when a task is better handled by a different ' +
        'kind of agent than you (e.g. a read-only "explorer" for deep investigation, a surgical "fix" ' +
        'agent for a bug, a "feature" agent for a separate piece of work). The subagent joins your ' +
        'group (it shares your worktree/branch) and shows up in the TUI nested beneath you, so the ' +
        'human can follow its progress. After spawning, use list_subagents / ask_subagent to ' +
        'coordinate it. The subagent does NOT see your conversation, so the prompt must be ' +
        'self-contained.',
      {
        template: z
          .enum(SPAWNABLE_TEMPLATES)
          .default('feature')
          .describe(
            'Which kind of subagent fits this work: "feature" (full-access task agent, the default ' +
              'for new work), "fix" (surgical bug-fix agent: reproduce, find root cause, minimal fix), ' +
              '"explorer" (read-only investigation / "how does X work?", no code changes) or "worker" ' +
              '(general-purpose; cuts a worktree only if it needs to edit code).',
          ),
        name: z
          .string()
          .min(1)
          .describe(
            'Short, nice, kebab-case subagent name (e.g. "login-flow", "dark-mode"). Becomes the ' +
              'agent name; keep it descriptive and unique.',
          ),
        prompt: z
          .string()
          .min(1)
          .describe(
            'Complete, self-contained instructions for the subagent. It does not see your ' +
              'conversation, so include all the context it needs to do the work end-to-end.',
          ),
        ticket: z
          .string()
          .default('')
          .describe(
            'Ticket reference for this work (e.g. "PROJ-123") if there is one; otherwise an empty ' +
              'string.',
          ),
      },
      async (args) => {
        const template = args.template ?? 'feature';
        try {
          const res = await spawn({
            template,
            name: args.name,
            prompt: args.prompt,
            ticket: args.ticket ?? '',
          });
          return {
            content: [
              {
                type: 'text',
                text:
                  `Spawned ${template} subagent "${res.name}" (id: ${res.id}). It is running in your ` +
                  `group and shown in the TUI. Use ask_subagent with its id to coordinate it.`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to spawn ${template} subagent "${args.name}": ${(err as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  ];
}

/**
 * Compose a single in-process MCP server named "orc" from the given tool lists. The launcher/pipeline
 * tools and the orchestration tools all live on this one server, so an agent can have several at once
 * (e.g. a launcher that is also an orchestrator of its spawned features).
 */
export function buildOrcServer(tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>) {
  return createSdkMcpServer({ name: 'orc', version: '0.1.0', tools });
}
