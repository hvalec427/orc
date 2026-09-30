import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { OrcConfig, ProjectConfig } from './types.js';

const MaestroSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const OverridableSchema = {
  model: z.string().optional(),
  worktreeDir: z.string().optional(),
  permissionMode: z.enum(['bypassPermissions', 'default', 'acceptEdits']).optional(),
  settingSources: z.array(z.enum(['user', 'project', 'local'])).optional(),
  maestroMcp: MaestroSchema.optional(),
  magicLink: z.string().optional(),
};

const ProjectSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    ...OverridableSchema,
  })
  .strict();

const GlobalConfigSchema = z
  .object({
    basePort: z.number().int().positive().optional(),
    ...OverridableSchema,
    projects: z.array(ProjectSchema).min(1),
  })
  .strict();

export interface CliFlags {
  config?: string;
  model?: string;
  noMaestro?: boolean;
}

const DEFAULTS = {
  model: 'claude-opus-4-8',
  worktreeDir: '.worktrees',
  basePort: 8100,
  permissionMode: 'bypassPermissions' as const,
  settingSources: ['user', 'project', 'local'] as Array<'user' | 'project' | 'local'>,
  maestroMcp: { command: 'maestro', args: ['mcp'] },
};

export const DEFAULT_CONFIG_PATH = join(homedir(), '.orc', 'config.json');

export const SAMPLE_CONFIG = `{
  "model": "claude-opus-4-8",
  "basePort": 8100,
  "permissionMode": "bypassPermissions",
  "settingSources": ["user", "project", "local"],
  "maestroMcp": { "command": "maestro", "args": ["mcp"] },
  "projects": [
    { "name": "Acme iOS", "path": "~/dev/acme-app" },
    { "name": "Beta App", "path": "~/dev/beta", "model": "claude-sonnet-5" }
  ]
}`;

/** Expand a leading `~` and resolve to an absolute path. */
function expandPath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/**
 * Load the central config (`--config` or ~/.orc/config.json) and resolve each project by overlaying
 * global defaults. Throws a descriptive error (with a sample) if the file is missing or invalid.
 */
export function loadConfig(flags: CliFlags): OrcConfig {
  const configPath = flags.config ? expandPath(flags.config) : DEFAULT_CONFIG_PATH;

  if (!existsSync(configPath)) {
    throw new Error(
      `No config found at ${configPath}.\n\nCreate it with your projects, e.g.:\n\n${SAMPLE_CONFIG}\n`,
    );
  }

  let parsed: z.infer<typeof GlobalConfigSchema>;
  try {
    parsed = GlobalConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (err) {
    throw new Error(`Invalid config at ${configPath}: ${(err as Error).message}`);
  }

  const globalMaestro = flags.noMaestro ? undefined : parsed.maestroMcp ?? DEFAULTS.maestroMcp;

  const projects: ProjectConfig[] = parsed.projects.map((p) => ({
    name: p.name,
    repo: expandPath(p.path),
    model: flags.model ?? p.model ?? parsed.model ?? DEFAULTS.model,
    worktreeDir: p.worktreeDir ?? parsed.worktreeDir ?? DEFAULTS.worktreeDir,
    permissionMode: p.permissionMode ?? parsed.permissionMode ?? DEFAULTS.permissionMode,
    settingSources: p.settingSources ?? parsed.settingSources ?? DEFAULTS.settingSources,
    maestroMcp: flags.noMaestro ? undefined : p.maestroMcp ?? globalMaestro,
    magicLink: p.magicLink ?? parsed.magicLink,
  }));

  const names = new Set<string>();
  for (const p of projects) {
    if (names.has(p.name)) throw new Error(`Duplicate project name in config: "${p.name}"`);
    names.add(p.name);
  }

  return { basePort: parsed.basePort ?? DEFAULTS.basePort, projects };
}
