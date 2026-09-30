import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { OrcConfig, PortRange, ProjectConfig, ProjectType } from './types.js';

const MaestroSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

/** A port range like "8000-8099". Validated to 0 < start <= end. */
const PortRangeSchema = z
  .string()
  .regex(/^\d+-\d+$/, 'portRange must look like "8000-8099"')
  .refine(
    (s) => {
      const [start, end] = s.split('-').map(Number);
      return start > 0 && end > 0 && start <= end;
    },
    { message: 'portRange must be "start-end" with 0 < start <= end' },
  );

const OverridableSchema = {
  type: z.enum(['react-native', 'web', 'orc']).optional(),
  model: z.string().optional(),
  worktreeDir: z.string().optional(),
  permissionMode: z.enum(['bypassPermissions', 'default', 'acceptEdits']).optional(),
  settingSources: z.array(z.enum(['user', 'project', 'local'])).optional(),
  portRange: PortRangeSchema.optional(),
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
  permissionMode: 'bypassPermissions' as const,
  settingSources: ['user', 'project', 'local'] as Array<'user' | 'project' | 'local'>,
  maestroMcp: { command: 'maestro', args: ['mcp'] },
};

/** Parse a validated "start-end" string into a PortRange. */
function parsePortRange(range: string): PortRange {
  const [start, end] = range.split('-').map(Number);
  return { start, end };
}

export const DEFAULT_CONFIG_PATH = join(homedir(), '.orc', 'config.json');

export const SAMPLE_CONFIG = `{
  "model": "claude-opus-4-8",
  "permissionMode": "bypassPermissions",
  "settingSources": ["user", "project", "local"],
  "maestroMcp": { "command": "maestro", "args": ["mcp"] },
  "projects": [
    { "name": "Acme iOS", "path": "~/dev/acme-app", "portRange": "8000-8099" },
    { "name": "Beta App", "path": "~/dev/beta", "model": "claude-sonnet-5", "portRange": "8100-8199" }
  ]
}`;

/** Collapse the home dir back to `~` for friendlier messages. */
export function displayPath(p: string): string {
  const home = homedir();
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/** Expand a leading `~` and resolve to an absolute path. */
export function expandPath(p: string): string {
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
      `No config found at ${displayPath(configPath)}.\n\nCreate it with your projects, e.g.:\n\n${SAMPLE_CONFIG}\n`,
    );
  }

  let parsed: z.infer<typeof GlobalConfigSchema>;
  try {
    parsed = GlobalConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (err) {
    throw new Error(`Invalid config at ${displayPath(configPath)}: ${(err as Error).message}`);
  }

  const globalMaestro = flags.noMaestro ? undefined : parsed.maestroMcp ?? DEFAULTS.maestroMcp;

  const projects: ProjectConfig[] = parsed.projects.map((p) => {
    const range = p.portRange ?? parsed.portRange;
    return {
      name: p.name,
      type: p.type ?? parsed.type ?? 'react-native',
      repo: expandPath(p.path),
      model: flags.model ?? p.model ?? parsed.model ?? DEFAULTS.model,
      worktreeDir: p.worktreeDir ?? parsed.worktreeDir ?? DEFAULTS.worktreeDir,
      permissionMode: p.permissionMode ?? parsed.permissionMode ?? DEFAULTS.permissionMode,
      settingSources: p.settingSources ?? parsed.settingSources ?? DEFAULTS.settingSources,
      portRange: range ? parsePortRange(range) : undefined,
      maestroMcp: flags.noMaestro ? undefined : p.maestroMcp ?? globalMaestro,
      magicLink: p.magicLink ?? parsed.magicLink,
    };
  });

  const names = new Set<string>();
  for (const p of projects) {
    if (names.has(p.name)) throw new Error(`Duplicate project name in config: "${p.name}"`);
    names.add(p.name);
  }

  return { projects };
}

// --- Raw config editing (used by `orc setup`) ---
//
// The setup wizard edits ~/.orc/config.json directly. Unlike loadConfig it must tolerate a
// missing file and must never drop fields it doesn't understand, so it round-trips the parsed
// JSON object instead of reconstructing it from the resolved shape.

/** A single project entry as written in config.json (the raw, unresolved form). */
export interface RawProject {
  name: string;
  path: string;
  type?: ProjectType;
  [key: string]: unknown;
}

/** The config.json document as-is; extra keys are preserved on read/write. */
export interface RawConfig {
  projects: RawProject[];
  [key: string]: unknown;
}

/** Resolve the config path from flags (defaults to ~/.orc/config.json). */
export function resolveConfigPath(flags: CliFlags): string {
  return flags.config ? expandPath(flags.config) : DEFAULT_CONFIG_PATH;
}

/**
 * Read config.json for editing. Returns an empty document (`{ projects: [] }`) if the file does
 * not exist yet so setup can create it. Throws only when the file exists but is unreadable/invalid.
 */
export function readRawConfig(configPath: string): RawConfig {
  if (!existsSync(configPath)) return { projects: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON at ${displayPath(configPath)}: ${(err as Error).message}`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error(`Config at ${displayPath(configPath)} is not a JSON object`);
  }
  const obj = doc as Record<string, unknown>;
  const projects = Array.isArray(obj.projects) ? (obj.projects as RawProject[]) : [];
  return { ...obj, projects };
}

/** Write config.json, creating the parent directory if needed. Pretty-printed with a trailing newline. */
export function writeRawConfig(configPath: string, config: RawConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}
