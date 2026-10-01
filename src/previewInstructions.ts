/**
 * Builds the human-facing "how to run/test this feature" instructions shown inside an agent's
 * window when you press `P`. orc already knows everything needed to tell you how to preview a
 * branch — the project type, the agent's worktree path, its allocated port, the simulator name
 * (the agent name, by convention) and the optional magic sign-in link — so it generates the
 * steps itself rather than asking the agent to write them down.
 *
 * The exact dev command is project-specific and NOT known to orc (the agent CLAUDE.md templates
 * tell agents to use "the project's existing commands"), so we scaffold `npm run dev` and let the
 * reader adjust. The type-specific extras (open URL for web, simulator for react-native) are the
 * useful part.
 */
import type { AgentInfo, ProjectConfig } from './types.js';

/** Produce the multi-line instruction text for previewing/testing the given agent's branch. */
export function buildPreviewInstructions(info: AgentInfo, project: ProjectConfig): string {
  const lines: string[] = [];

  lines.push(`Preview ${info.name} (${project.name} · ${project.type})`);
  lines.push(info.branch ? `branch: ${info.branch}` : 'no branch (read-only agent)');
  lines.push('');

  if (!info.worktree) {
    // Read-only templates (merge/launcher/pipeline/role investigators) run in the base repo with no
    // worktree, so there is nothing isolated to check out and preview.
    lines.push('This agent has no worktree, so there is nothing to preview.');
    lines.push('It runs read-only in the base repo.');
    return lines.join('\n');
  }

  lines.push('Run it locally:');
  lines.push('');
  lines.push(`  cd "${info.worktree}"`);
  lines.push('  npm install');
  lines.push('  npm run dev');

  if (project.type === 'web') {
    lines.push('');
    if (info.metroPort !== undefined) {
      lines.push(`Then open the site in your browser:`);
      lines.push(`  http://localhost:${info.metroPort}`);
    } else {
      lines.push('Then open the dev server URL printed by `npm run dev` in your browser.');
    }
    if (project.magicLink) {
      lines.push('');
      lines.push('Sign in with the magic link:');
      lines.push(`  ${project.magicLink}`);
    }
  } else if (project.type === 'react-native') {
    lines.push('');
    if (info.metroPort !== undefined) {
      lines.push(`Metro runs on port ${info.metroPort} (set as METRO_PORT).`);
    }
    lines.push(`Build and launch the app on the simulator named "${info.name}".`);
    if (project.magicLink) {
      lines.push('');
      lines.push('Sign in by opening the magic link on that simulator:');
      lines.push(`  xcrun simctl openurl "${info.name}" "${project.magicLink}"`);
    }
  }

  return lines.join('\n');
}
