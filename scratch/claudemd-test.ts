import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasClaudeMd, installClaudeMd } from '../src/claudeMd.js';
import { MOBILE_CLAUDE_MD } from '../src/mobileInstructions.js';

function assert(c: boolean, m: string) {
  console.log(`${c ? 'ok  ' : 'FAIL'} — ${m}`);
  if (!c) process.exitCode = 1;
}

const repo = mkdtempSync(join(tmpdir(), 'orc-cmd-'));

// fresh install
assert(!hasClaudeMd(repo), 'no CLAUDE.md initially');
const r1 = installClaudeMd(repo, { overwrite: false });
assert(r1 === 'created', 'first install returns created');
assert(hasClaudeMd(repo), 'CLAUDE.md now exists');
assert(readFileSync(join(repo, 'CLAUDE.md'), 'utf8') === MOBILE_CLAUDE_MD, 'content matches template');

// refuse overwrite
writeFileSync(join(repo, 'CLAUDE.md'), 'custom content');
const r2 = installClaudeMd(repo, { overwrite: false });
assert(r2 === 'exists', 'refuses to overwrite without overwrite flag');
assert(readFileSync(join(repo, 'CLAUDE.md'), 'utf8') === 'custom content', 'existing content untouched');

// explicit overwrite
const r3 = installClaudeMd(repo, { overwrite: true });
assert(r3 === 'overwritten', 'overwrite returns overwritten');
assert(readFileSync(join(repo, 'CLAUDE.md'), 'utf8') === MOBILE_CLAUDE_MD, 'content replaced with template');

rmSync(repo, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
