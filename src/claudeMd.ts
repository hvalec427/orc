import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectType } from './types.js';
import { templateForType } from './instructions.js';

export type InstallResult = 'created' | 'overwritten' | 'exists';

export function claudeMdPath(repo: string): string {
  return join(repo, 'CLAUDE.md');
}

export function hasClaudeMd(repo: string): boolean {
  return existsSync(claudeMdPath(repo));
}

/** Write the CLAUDE.md template for `type` into <repo>/CLAUDE.md. Refuses to overwrite unless asked. */
export function installClaudeMd(
  repo: string,
  type: ProjectType,
  opts: { overwrite: boolean },
): InstallResult {
  const path = claudeMdPath(repo);
  const existed = existsSync(path);
  if (existed && !opts.overwrite) return 'exists';
  writeFileSync(path, templateForType(type));
  return existed ? 'overwritten' : 'created';
}
