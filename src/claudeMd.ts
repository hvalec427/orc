import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOBILE_CLAUDE_MD } from './mobileInstructions.js';

export type InstallResult = 'created' | 'overwritten' | 'exists';

export function claudeMdPath(repo: string): string {
  return join(repo, 'CLAUDE.md');
}

export function hasClaudeMd(repo: string): boolean {
  return existsSync(claudeMdPath(repo));
}

/** Write the mobile instructions into <repo>/CLAUDE.md. Refuses to overwrite unless asked. */
export function installClaudeMd(repo: string, opts: { overwrite: boolean }): InstallResult {
  const path = claudeMdPath(repo);
  const existed = existsSync(path);
  if (existed && !opts.overwrite) return 'exists';
  writeFileSync(path, MOBILE_CLAUDE_MD);
  return existed ? 'overwritten' : 'created';
}
