import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const exec = promisify(execFile);

/** Turn an agent name into a filesystem/branch-safe slug. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  );
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** Verify the path is the top level of a git working tree. */
export async function assertGitRepo(repo: string): Promise<void> {
  try {
    await git(repo, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error(`${repo} is not a git repository (run 'git init' there first).`);
  }
}

export interface Worktree {
  path: string;
  branch: string;
}

/**
 * Create a git worktree + branch for an agent.
 * Branch: `agent/<slug>`, path: `<repo>/<worktreeDir>/<slug>`.
 * If the branch already exists, checks it out into the new worktree instead.
 */
export async function createWorktree(
  repo: string,
  worktreeDir: string,
  slug: string,
): Promise<Worktree> {
  const branch = `agent/${slug}`;
  const path = join(repo, worktreeDir, slug);

  const branchExists = await git(repo, ['branch', '--list', branch]).then((o) => o.length > 0);

  const args = branchExists
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', path, '-b', branch];

  await git(repo, args);
  return { path, branch };
}

/** Remove an agent's worktree. Leaves the branch (it holds the agent's commits). */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', path, '--force']);
}
