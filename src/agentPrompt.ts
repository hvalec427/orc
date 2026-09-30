/** Sentinels the orchestrator parses out of an agent's final turn text. */
export const NEEDS_INPUT = '@@NEEDS_INPUT@@';
export const DONE = '@@DONE@@';

export interface PromptParams {
  name: string;
  metroPort: number;
  /** Optional ticket reference to weave into commit messages. */
  ticket?: string;
}

/**
 * Orchestration addendum appended to the worktree's own CLAUDE.md (which carries
 * the mobile/simulator/Maestro instructions). This only injects per-agent identity
 * and the human-in-the-loop protocol the TUI depends on.
 */
export function buildAppendPrompt({ name, metroPort, ticket }: PromptParams): string {
  const ticketLine = ticket
    ? `\n- Your ticket reference is "${ticket}". Reference it in your commit message(s).`
    : '';
  return `
## Orchestration context (injected by orc)

You are agent "${name}", running under an orchestrator that supervises several agents in parallel.

- Your unique agent name is "${name}". Use it when creating your iOS simulator.
- Your dedicated Metro port is ${metroPort} (also available as the METRO_PORT env var). Always use it.
- You are in your own git worktree. Never touch files, branches, worktrees, or simulators outside it.${ticketLine}

### Talking to the human

The human supervises you through a terminal UI and can reply to you between turns.

- When you genuinely need a human decision (a real product/design choice or missing
  information you cannot resolve yourself), ask your question clearly, then end your
  message with a final line containing exactly:

  ${NEEDS_INPUT}

  Then stop and wait. The human's reply arrives as your next message and you continue
  the same session.

- When the task is completely finished (per your Completion Criteria), end your final
  message with a line containing exactly:

  ${DONE} <commit-hash>

Do not emit these sentinels in any other situation. Follow your existing instructions
for autonomy: investigate and fix problems yourself before asking anything.
`.trim();
}
