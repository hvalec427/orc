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

export interface MergeResult {
  /** The branch that was merged into (usually `master`/`main`). */
  into: string;
  /** Short hash of the resulting merge commit. */
  commit: string;
}

/** The name of the repo's default branch (the HEAD the main checkout is on). */
async function currentBranch(repo: string): Promise<string> {
  return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * Merge an agent's `agent/<slug>` branch into the main repo's current branch.
 *
 * Runs ENTIRELY from the main repo via `git -C <repo>`, never from inside the
 * agent worktree — so merging can't sever the caller's working directory (the
 * self-deletion trap that strands the session). On conflict it aborts cleanly
 * and leaves the branch + worktree untouched for manual resolution; on success
 * it leaves them in place too, so the agent stays usable for follow-ups. Cleanup
 * is the caller's job (orc removes the worktree when you remove the agent).
 */
export async function mergeAgentBranch(
  repo: string,
  branch: string,
  ticket?: string,
): Promise<MergeResult> {
  await assertGitRepo(repo);

  // Refuse to merge on top of uncommitted tracked changes — a conflicting merge
  // over unrelated local edits is a mess to untangle. Ignore untracked files:
  // agent worktrees live under `.worktrees/` inside the repo and would otherwise
  // always read as "dirty". `--porcelain -uno` is empty iff no tracked changes.
  const dirty = await git(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    throw new Error(
      `main repo has uncommitted changes; commit or stash them in ${repo} before merging.`,
    );
  }

  const into = await currentBranch(repo);
  if (into === branch) {
    throw new Error(`the main repo is on ${branch}; check out the target branch before merging.`);
  }

  const ref = ticket ? ` (${ticket})` : '';
  const message = `Merge ${branch}${ref}`;
  try {
    await git(repo, ['merge', '--no-ff', '-m', message, branch]);
  } catch (err) {
    // Leave nothing half-merged: reset the target back to its pre-merge state.
    await git(repo, ['merge', '--abort']).catch(() => {});
    throw new Error(
      `merge of ${branch} into ${into} hit conflicts and was aborted — resolve manually. ` +
        `(${(err as Error).message.split('\n')[0]})`,
    );
  }

  const commit = await git(repo, ['rev-parse', '--short', 'HEAD']);
  return { into, commit };
}
