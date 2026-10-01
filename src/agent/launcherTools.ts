import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Result the launcher's spawn callback returns for one feature agent, so the tool can report
 * back to the launcher what actually got created (its final, uniquified name).
 */
export interface LaunchResult {
  id: string;
  name: string;
}

/** Spawns one feature agent; supplied by the AgentSession so the tool can call back into the manager. */
export type LaunchFeature = (args: {
  name: string;
  prompt: string;
  ticket: string;
}) => Promise<LaunchResult>;

/**
 * Build the in-process MCP server that backs the launcher agent's single power: spawning feature
 * agents. The tool name is `launch_feature_agents` on server `orc`, so the fully-qualified tool the
 * model calls is `mcp__orc__launch_feature_agents` (see LAUNCH_TOOL in agentPrompt.ts). Each call
 * creates exactly one feature agent via the supplied `launch` callback and returns its final name.
 */
export function buildLauncherMcpServer(launch: LaunchFeature) {
  return createSdkMcpServer({
    name: 'orc',
    version: '0.1.0',
    tools: [
      tool(
        'launch_feature_agents',
        'Spawn ONE feature agent to carry out a group of tasks. Call this once per feature agent ' +
          'you want to create. Each agent gets its own git worktree + branch and runs independently. ' +
          'The prompt must be self-contained: the feature agent does not see the human\u2019s original message.',
        {
          name: z
            .string()
            .min(1)
            .describe(
              'Short, nice, kebab-case feature name (e.g. "login-flow", "dark-mode"). ' +
                'Becomes the agent name and its git branch. Keep it unique across this batch.',
            ),
          prompt: z
            .string()
            .min(1)
            .describe(
              'Complete, self-contained instructions for this feature agent covering every task in ' +
                'the group. Include all context needed to do the work end-to-end.',
            ),
          ticket: z
            .string()
            .default('')
            .describe(
              'Ticket reference for this work (e.g. "PROJ-123") if the human provided one; ' +
                'otherwise an empty string.',
            ),
        },
        async (args) => {
          try {
            const res = await launch({
              name: args.name,
              prompt: args.prompt,
              ticket: args.ticket ?? '',
            });
            return {
              content: [
                {
                  type: 'text',
                  text: `Launched feature agent "${res.name}" (id: ${res.id}).`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Failed to launch feature agent "${args.name}": ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
