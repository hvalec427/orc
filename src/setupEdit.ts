// Pure helpers for the `orc setup` wizard's add/edit/global flows.
//
// These keep the config-editing logic (which fields to write, how to parse the compound
// maestroMcp/settingSources/args fields, and validation) out of the Ink UI so it can be unit-tested
// without rendering. The UI in src/ui/SetupApp.tsx builds a `Draft` from text inputs and calls these.

import type { RawConfig, RawProject } from './config.js';
import type { ProjectType, MergeStrategy } from './types.js';

export const PROJECT_TYPES: ProjectType[] = ['react-native', 'web', 'orc'];
export const PERMISSION_MODES = ['bypassPermissions', 'default', 'acceptEdits'] as const;
export const MERGE_STRATEGIES: MergeStrategy[] = ['merge', 'rebase', 'squash-merge', 'squash-rebase'];
export const SETTING_SOURCES = ['user', 'project', 'local'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type SettingSource = (typeof SETTING_SOURCES)[number];

/**
 * The editable, all-strings form of an overridable settings block as typed in the UI. Blank strings
 * (and empty arrays) mean "unset" — they are omitted when converting to the raw config so the value
 * is inherited from globals/defaults. Used for both a project (with name/path) and the globals (both
 * blank).
 */
export interface Draft {
  name: string;
  path: string;
  type: string;
  model: string;
  worktreeDir: string;
  permissionMode: string;
  settingSources: SettingSource[];
  /** Whether settingSources has been explicitly set (distinguishes "unset" from "cleared to []"). */
  settingSourcesSet: boolean;
  baseBranch: string;
  mergeStrategy: string;
  portRange: string;
  maestroCommand: string;
  /** Space-separated args, as typed. */
  maestroArgs: string;
  /** One `KEY=value` per line, as typed. */
  maestroEnv: string;
  magicLink: string;
}

/** An empty draft (all fields unset). */
export function emptyDraft(): Draft {
  return {
    name: '',
    path: '',
    type: '',
    model: '',
    worktreeDir: '',
    permissionMode: '',
    settingSources: [],
    settingSourcesSet: false,
    baseBranch: '',
    mergeStrategy: '',
    portRange: '',
    maestroCommand: '',
    maestroArgs: '',
    maestroEnv: '',
    magicLink: '',
  };
}

/** Build a Draft from an existing raw project (for the edit flow). Unknown keys are ignored here. */
export function draftFromProject(p: RawProject): Draft {
  return { ...emptyDraft(), ...draftFromOverridable(p), name: p.name ?? '', path: p.path ?? '' };
}

/** Build a Draft from the top-level globals block (name/path left blank). */
export function draftFromGlobals(cfg: RawConfig): Draft {
  return { ...emptyDraft(), ...draftFromOverridable(cfg) };
}

/** Shared mapping of an overridable settings object (project or globals) into draft fields. */
function draftFromOverridable(src: Record<string, unknown>): Partial<Draft> {
  const d: Partial<Draft> = {};
  if (typeof src.type === 'string') d.type = src.type;
  if (typeof src.model === 'string') d.model = src.model;
  if (typeof src.worktreeDir === 'string') d.worktreeDir = src.worktreeDir;
  if (typeof src.permissionMode === 'string') d.permissionMode = src.permissionMode;
  if (Array.isArray(src.settingSources)) {
    d.settingSources = src.settingSources.filter(
      (s): s is SettingSource => (SETTING_SOURCES as readonly string[]).includes(s as string),
    );
    d.settingSourcesSet = true;
  }
  if (typeof src.baseBranch === 'string') d.baseBranch = src.baseBranch;
  if (typeof src.mergeStrategy === 'string') d.mergeStrategy = src.mergeStrategy;
  if (typeof src.portRange === 'string') d.portRange = src.portRange;
  if (typeof src.magicLink === 'string') d.magicLink = src.magicLink;
  const m = src.maestroMcp;
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const mm = m as Record<string, unknown>;
    if (typeof mm.command === 'string') d.maestroCommand = mm.command;
    if (Array.isArray(mm.args)) d.maestroArgs = mm.args.filter((a) => typeof a === 'string').join(' ');
    if (mm.env && typeof mm.env === 'object' && !Array.isArray(mm.env)) {
      d.maestroEnv = Object.entries(mm.env as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => `${k}=${v as string}`)
        .join('\n');
    }
  }
  return d;
}

/** Parse "KEY=value" lines into an env record; ignores blank lines and lines without `=`. */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

/** Validate a "start-end" port range string. Returns an error message, or null if valid/blank. */
export function validatePortRange(s: string): string | null {
  const v = s.trim();
  if (!v) return null;
  if (!/^\d+-\d+$/.test(v)) return 'portRange must look like "8000-8099"';
  const [start, end] = v.split('-').map(Number);
  if (!(start > 0 && end > 0 && start <= end)) {
    return 'portRange must be "start-end" with 0 < start <= end';
  }
  return null;
}

/**
 * Turn a Draft into the overridable fields of a raw config entry, omitting anything left blank so it
 * inherits globals/defaults. Does not include name/path (callers add those for projects).
 */
export function overridableFromDraft(d: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: string) => {
    const v = value.trim();
    if (v) out[key] = v;
  };
  put('type', d.type);
  put('model', d.model);
  put('worktreeDir', d.worktreeDir);
  put('permissionMode', d.permissionMode);
  if (d.settingSourcesSet) out.settingSources = [...d.settingSources];
  put('baseBranch', d.baseBranch);
  put('mergeStrategy', d.mergeStrategy);
  put('portRange', d.portRange);

  // maestroMcp and magicLink only apply to react-native projects. A blank type inherits the
  // react-native default, so keep them unless another type is explicitly chosen.
  const type = d.type.trim();
  const isReactNative = !type || type === 'react-native';
  if (isReactNative) {
    put('magicLink', d.magicLink);

    const command = d.maestroCommand.trim();
    if (command) {
      const maestro: { command: string; args?: string[]; env?: Record<string, string> } = { command };
      const args = d.maestroArgs.trim().split(/\s+/).filter(Boolean);
      if (args.length) maestro.args = args;
      const env = parseEnvLines(d.maestroEnv);
      if (Object.keys(env).length) maestro.env = env;
      out.maestroMcp = maestro;
    }
  }
  return out;
}

/** Build a raw project entry from a draft (name/path + omitted-when-blank overridable fields). */
export function draftToRawProject(d: Draft): RawProject {
  return { name: d.name.trim(), path: d.path.trim(), ...overridableFromDraft(d) } as RawProject;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  config?: RawConfig;
}

/** Validate shared fields (name/path/portRange). Returns an error message or null. */
function validateProjectDraft(d: Draft): string | null {
  if (!d.name.trim()) return 'name is required';
  if (!d.path.trim()) return 'path is required';
  return validatePortRange(d.portRange);
}

/**
 * Insert or replace a project in the raw config from a draft. `originalName` is the name of the entry
 * being edited (null when adding). Preserves unknown keys on the edited entry. Enforces unique name.
 */
export function upsertProject(
  current: RawConfig,
  originalName: string | null,
  draft: Draft,
): SaveResult {
  const err = validateProjectDraft(draft);
  if (err) return { ok: false, error: err };

  const name = draft.name.trim();
  const clash = current.projects.some((p) => p.name === name && p.name !== originalName);
  if (clash) return { ok: false, error: `A project named "${name}" already exists.` };

  const built = draftToRawProject(draft);
  let projects: RawProject[];
  if (originalName === null) {
    projects = [...current.projects, built];
  } else {
    projects = current.projects.map((p) => {
      if (p.name !== originalName) return p;
      // Preserve unknown keys we don't edit, but drop any managed keys the draft cleared.
      const preserved = stripManagedKeys(p);
      return { ...preserved, ...built };
    });
  }
  return { ok: true, config: { ...current, projects } };
}

/** Keys the editor fully owns; on edit these are re-derived from the draft, so drop stale ones. */
const MANAGED_PROJECT_KEYS = [
  'name',
  'path',
  'type',
  'model',
  'worktreeDir',
  'permissionMode',
  'settingSources',
  'baseBranch',
  'mergeStrategy',
  'portRange',
  'maestroMcp',
  'magicLink',
];

function stripManagedKeys(p: RawProject): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!MANAGED_PROJECT_KEYS.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Apply a globals draft to the top-level config, omitting blank fields (and removing any managed
 * global keys the draft cleared). Preserves `projects` and any unknown top-level keys.
 */
export function applyGlobals(current: RawConfig, draft: Draft): SaveResult {
  const err = validatePortRange(draft.portRange);
  if (err) return { ok: false, error: err };

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) {
    if (k === 'projects') continue;
    if (!MANAGED_PROJECT_KEYS.includes(k)) out[k] = v; // keep unknown top-level keys
  }
  Object.assign(out, overridableFromDraft(draft));
  return { ok: true, config: { ...out, projects: current.projects } };
}
