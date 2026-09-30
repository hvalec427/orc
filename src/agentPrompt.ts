/** Sentinels the orchestrator parses out of an agent's final turn text. */
export const NEEDS_INPUT = '@@NEEDS_INPUT@@';
export const DONE = '@@DONE@@';

export interface PromptParams {
  name: string;
  /** Allocated port, or undefined when the project has no port range. */
  metroPort?: number;
  /** Optional ticket reference to weave into commit messages. */
  ticket?: string;
  /** Optional magic sign-in link the agent opens on its simulator to log in. */
  magicLink?: string;
}

/**
 * Orchestration addendum appended to the worktree's own CLAUDE.md (which carries
 * the mobile/simulator/Maestro instructions). This only injects per-agent identity
 * and the human-in-the-loop protocol the TUI depends on.
 */
export function buildAppendPrompt({ name, metroPort, ticket, magicLink }: PromptParams): string {
  const ticketLine = ticket
    ? `\n- Your ticket reference is "${ticket}". Reference it in your commit message(s).`
    : '';
  const portLine =
    metroPort !== undefined
      ? `\n- Your dedicated port is ${metroPort} (env: METRO_PORT and AGENT_PORT). Use it for Metro / your dev server / any local service.`
      : `\n- No port was allocated for you. If your task genuinely needs a local port (dev server, Metro, etc.), stop and ask the human to add a \`portRange\` for this project in the orc config, using the ${NEEDS_INPUT} sentinel.`;
  const magicSection = magicLink
    ? `

### Signing in

A magic sign-in link is available in the MAGIC_LINK env var. Use it to authenticate before verifying
any signed-in views. See your project's CLAUDE.md for how to open a link on your target (e.g.
\`xcrun simctl openurl\` on iOS, or opening it in the browser).`
    : '';
  return `
## Orchestration context (injected by orc)

You are agent "${name}", running under an orchestrator that supervises several agents in parallel.

- Your unique agent name is "${name}". Use it when creating your iOS simulator.${portLine}
- You are in your own git worktree. Never touch files, branches, worktrees, or simulators outside it.
- Do NOT merge your branch into master, delete your own branch, or remove your own worktree. Merging is the orchestrator's job, run from the main repo — doing it yourself would delete the directory you're running in and break your session. Just commit and report ${DONE}; the human merges you with the \`m\` key.${ticketLine}${magicSection}

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
