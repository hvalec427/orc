import { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { MultilineInput } from './MultilineInput.js';
import {
  readRawConfig,
  writeRawConfig,
  displayPath,
  expandPath,
  type RawConfig,
  type RawProject,
} from '../config.js';
import { hasClaudeMd, installClaudeMd } from '../claudeMd.js';
import {
  type Draft,
  type SettingSource,
  emptyDraft,
  draftFromProject,
  draftFromGlobals,
  upsertProject,
  applyGlobals,
  validatePortRange,
  PROJECT_TYPES,
  PERMISSION_MODES,
  MERGE_STRATEGIES,
  SETTING_SOURCES,
} from '../setupEdit.js';

type Screen = 'menu' | 'apply' | 'add' | 'edit' | 'remove' | 'global';

/**
 * `orc setup` — a standalone wizard for preparing ~/.orc/config.json and installing the
 * per-project CLAUDE.md. It edits the config file in place and never mutates the running
 * orchestrator. The add/edit/global screens cover every option the config schema supports.
 */
export function SetupApp({ configPath }: { configPath: string }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>('menu');
  // Load once; each action re-reads/writes so external edits between actions are respected.
  const [config, setConfig] = useState<RawConfig>(() => readRawConfig(configPath));
  const [notice, setNotice] = useState('');

  const reload = () => setConfig(readRawConfig(configPath));
  const back = (msg?: string) => {
    reload();
    if (msg !== undefined) setNotice(msg);
    setScreen('menu');
  };

  if (screen === 'menu') {
    return (
      <Menu
        configPath={configPath}
        config={config}
        notice={notice}
        onQuit={exit}
        onChoose={(s) => {
          setNotice('');
          setScreen(s);
        }}
      />
    );
  }
  if (screen === 'apply') return <ApplyClaudeMd config={config} onDone={back} />;
  if (screen === 'add') return <AddProject configPath={configPath} onDone={back} />;
  if (screen === 'edit') return <EditProject configPath={configPath} config={config} onDone={back} />;
  if (screen === 'global') return <GlobalSettings configPath={configPath} onDone={back} />;
  return <RemoveProject configPath={configPath} onDone={back} />;
}

function Menu({
  configPath,
  config,
  notice,
  onChoose,
  onQuit,
}: {
  configPath: string;
  config: RawConfig;
  notice: string;
  onChoose: (s: Exclude<Screen, 'menu'>) => void;
  onQuit: () => void;
}) {
  const items: Array<{ key: Exclude<Screen, 'menu'>; label: string; hint: string }> = [
    { key: 'add', label: 'Add project', hint: 'append a new project, configuring all options' },
    { key: 'edit', label: 'Edit project', hint: 'change any option of an existing project' },
    { key: 'global', label: 'Global settings', hint: 'edit the defaults shared by all projects' },
    { key: 'apply', label: 'Apply CLAUDE.md', hint: 'write the type-matched template into a project repo' },
    { key: 'remove', label: 'Remove project', hint: 'delete a project entry from the config' },
  ];
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      onQuit();
      return;
    }
    if (key.upArrow || input === 'k') setCursor((c) => (c - 1 + items.length) % items.length);
    else if (key.downArrow || input === 'j') setCursor((c) => (c + 1) % items.length);
    else if (key.return) onChoose(items[cursor].key);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">orc setup</Text>
      <Text dimColor>
        {displayPath(configPath)} · {config.projects.length} project(s)
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {items.map((it, i) => (
          <Text key={it.key} color={i === cursor ? 'cyan' : undefined}>
            {i === cursor ? '❯ ' : '  '}
            {it.label} <Text dimColor>— {it.hint}</Text>
          </Text>
        ))}
      </Box>

      <Text dimColor>
        ↑↓/jk: choose · Enter: select · q/Esc: quit{notice ? `   ·   ${notice}` : ''}
      </Text>
    </Box>
  );
}

function ApplyClaudeMd({
  config,
  onDone,
}: {
  config: RawConfig;
  onDone: (msg?: string) => void;
}) {
  const projects = config.projects;
  const [cursor, setCursor] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const project = projects[cursor];

  useInput((input, key) => {
    if (confirming) {
      if (input === 'y' && project) {
        const repo = expandPath(project.path);
        const r = installClaudeMd(repo, project.type ?? 'react-native', { overwrite: true });
        onDone(`${r} CLAUDE.md in ${project.name}`);
      } else if (input === 'n' || key.escape) {
        setConfirming(false);
      }
      return;
    }
    if (key.escape) {
      onDone();
      return;
    }
    if (projects.length === 0) return;
    if (key.upArrow || input === 'k') setCursor((c) => (c - 1 + projects.length) % projects.length);
    else if (key.downArrow || input === 'j') setCursor((c) => (c + 1) % projects.length);
    else if (input === 'c' || key.return) {
      if (!project) return;
      const repo = expandPath(project.path);
      if (hasClaudeMd(repo)) {
        setConfirming(true);
      } else {
        const r = installClaudeMd(repo, project.type ?? 'react-native', { overwrite: false });
        onDone(`${r} CLAUDE.md in ${project.name}`);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Apply CLAUDE.md</Text>
      <Text dimColor>Writes the CLAUDE.md template matching each project's type into its repo.</Text>

      <Box flexDirection="column" marginTop={1}>
        {projects.length === 0 ? (
          <Text dimColor>No projects yet — add one first.</Text>
        ) : (
          projects.map((p, i) => {
            const repo = expandPath(p.path);
            const has = hasClaudeMd(repo);
            return (
              <Text key={p.name} color={i === cursor ? 'cyan' : undefined}>
                {i === cursor ? '❯ ' : '  '}
                {p.name} <Text dimColor>({p.type ?? 'react-native'})</Text>{' '}
                <Text dimColor>{p.path}</Text>{' '}
                {has ? <Text color="green">[has CLAUDE.md]</Text> : <Text dimColor>[none]</Text>}
              </Text>
            );
          })
        )}
      </Box>

      {confirming ? (
        <Text color="yellow">{project?.name}: CLAUDE.md already exists — overwrite? y/n</Text>
      ) : (
        <Text dimColor>↑↓/jk: choose · c/Enter: install · Esc: back</Text>
      )}
    </Box>
  );
}

// --- Shared field-list editor (used by Add project, Edit project, Global settings) ---

type FieldKind = 'text' | 'select' | 'multiselect' | 'multiline';

interface FieldDef {
  key: keyof Draft;
  label: string;
  kind: FieldKind;
  /** For select fields. */
  options?: readonly string[];
  placeholder?: string;
}

/** Overridable fields shared by projects and globals. */
function overridableFields(): FieldDef[] {
  return [
    { key: 'type', label: 'type', kind: 'select', options: PROJECT_TYPES, placeholder: 'inherit (react-native)' },
    { key: 'model', label: 'model', kind: 'text', placeholder: 'inherit (claude-opus-4-8)' },
    { key: 'worktreeDir', label: 'worktreeDir', kind: 'text', placeholder: 'inherit (.worktrees)' },
    { key: 'permissionMode', label: 'permissionMode', kind: 'select', options: PERMISSION_MODES, placeholder: 'inherit (bypassPermissions)' },
    { key: 'settingSources', label: 'settingSources', kind: 'multiselect', options: SETTING_SOURCES, placeholder: 'inherit (user, project, local)' },
    { key: 'baseBranch', label: 'baseBranch', kind: 'text', placeholder: 'auto-detect (develop/main)' },
    { key: 'mergeStrategy', label: 'mergeStrategy', kind: 'select', options: MERGE_STRATEGIES, placeholder: 'inherit (rebase)' },
    { key: 'portRange', label: 'portRange', kind: 'text', placeholder: 'e.g. 8000-8099 (none)' },
    { key: 'maestroCommand', label: 'maestro.command', kind: 'text', placeholder: 'inherit (maestro); blank disables' },
    { key: 'maestroArgs', label: 'maestro.args', kind: 'text', placeholder: 'space-separated, e.g. mcp' },
    { key: 'maestroEnv', label: 'maestro.env', kind: 'multiline', placeholder: 'KEY=value per line' },
    { key: 'magicLink', label: 'magicLink', kind: 'text', placeholder: 'sign-in deep link (none)' },
  ];
}

/** Fields shown for a project: required name/path first, then all overridable options. */
const PROJECT_FIELDS: FieldDef[] = [
  { key: 'name', label: 'name', kind: 'text', placeholder: 'e.g. Acme iOS (required)' },
  { key: 'path', label: 'path', kind: 'text', placeholder: 'e.g. ~/dev/acme-app (required)' },
  ...overridableFields(),
];

const GLOBAL_FIELDS: FieldDef[] = overridableFields();

/** Human-readable current value of a field, or null when unset (renders as the placeholder). */
function fieldValue(draft: Draft, f: FieldDef): string | null {
  if (f.kind === 'multiselect') {
    return draft.settingSourcesSet ? draft.settingSources.join(', ') || '(none)' : null;
  }
  const raw = (draft[f.key] as string).trim();
  if (!raw) return null;
  if (f.kind === 'multiline') {
    const lines = raw.split('\n').filter(Boolean);
    return lines.length <= 1 ? (lines[0] ?? '') : `${lines.length} vars`;
  }
  return raw;
}

/**
 * A scrollable list of fields the user can edit in any order, plus a Save row. Shared by the add,
 * edit and global screens. `fields` controls which rows appear; `onSave` validates + writes.
 */
function FieldEditor({
  title,
  subtitle,
  fields,
  initial,
  onSave,
  onCancel,
}: {
  title: string;
  subtitle: string;
  fields: FieldDef[];
  initial: Draft;
  onSave: (draft: Draft) => { ok: boolean; error?: string };
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  // cursor indexes [...fields, SAVE].
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [multiCursor, setMultiCursor] = useState(0);
  const [error, setError] = useState('');

  const total = fields.length + 1;
  const onSaveRow = cursor === fields.length;
  const current = onSaveRow ? undefined : fields[cursor];

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const beginEdit = (f: FieldDef) => {
    setError('');
    if (f.kind === 'multiselect') setMultiCursor(0);
    setEditing(true);
  };

  const doSave = () => {
    const pErr = validatePortRange(draft.portRange);
    if (pErr) {
      setError(pErr);
      const i = fields.findIndex((f) => f.key === 'portRange');
      if (i >= 0) setCursor(i);
      setEditing(false);
      return;
    }
    const res = onSave(draft);
    if (!res.ok) {
      setError(res.error ?? 'could not save');
      setEditing(false);
    }
  };

  useInput((input, key) => {
    // Text/multiline fields are edited by their own input components; they handle Enter (done) and
    // we only need to catch Esc here to leave edit mode.
    if (editing && current && (current.kind === 'text' || current.kind === 'multiline')) {
      if (key.escape) setEditing(false);
      return;
    }

    if (!editing) {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow || input === 'k') {
        setError('');
        setCursor((c) => (c - 1 + total) % total);
      } else if (key.downArrow || input === 'j') {
        setError('');
        setCursor((c) => (c + 1) % total);
      } else if (input === 's') {
        doSave();
      } else if (key.return) {
        if (onSaveRow) doSave();
        else if (current) beginEdit(current);
      }
      return;
    }

    // Editing a select or multiselect (these are driven from here).
    if (key.escape) {
      setEditing(false);
      return;
    }
    if (current?.kind === 'select') {
      const opts = current.options!;
      const cur = (draft[current.key] as string) || '';
      const idx = Math.max(0, opts.indexOf(cur));
      if (key.upArrow || input === 'k') set({ [current.key]: opts[(idx - 1 + opts.length) % opts.length] } as Partial<Draft>);
      else if (key.downArrow || input === 'j') set({ [current.key]: opts[(idx + 1) % opts.length] } as Partial<Draft>);
      else if (input === 'x') set({ [current.key]: '' } as Partial<Draft>);
      else if (key.return) setEditing(false);
    } else if (current?.kind === 'multiselect') {
      const opts = current.options as readonly SettingSource[];
      if (key.upArrow || input === 'k') setMultiCursor((c) => (c - 1 + opts.length) % opts.length);
      else if (key.downArrow || input === 'j') setMultiCursor((c) => (c + 1) % opts.length);
      else if (input === ' ') {
        const opt = opts[multiCursor];
        const has = draft.settingSources.includes(opt);
        set({
          settingSources: has
            ? draft.settingSources.filter((s) => s !== opt)
            : [...draft.settingSources, opt],
          settingSourcesSet: true,
        });
      } else if (input === 'x') {
        set({ settingSources: [], settingSourcesSet: false });
      } else if (key.return) {
        setEditing(false);
      }
    }
  });

  const warnNoProject =
    draft.settingSourcesSet && !draft.settingSources.includes('project')
      ? 'settingSources omits "project": the worktree CLAUDE.md will not load.'
      : '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      <Text dimColor>{subtitle}</Text>

      <Box flexDirection="column" marginTop={1}>
        {fields.map((f, i) => {
          const focused = i === cursor;
          const isEditing = focused && editing;
          const value = fieldValue(draft, f);
          return (
            <Box key={String(f.key)} flexDirection="column">
              <Box>
                <Text color={focused ? 'cyan' : undefined}>
                  {focused ? '❯ ' : '  '}
                  {f.label.padEnd(16)}
                </Text>
                {isEditing && f.kind === 'text' ? (
                  <TextInput
                    value={draft[f.key] as string}
                    onChange={(v) => set({ [f.key]: stripBreaks(v) } as Partial<Draft>)}
                    onSubmit={() => setEditing(false)}
                    placeholder={f.placeholder}
                  />
                ) : isEditing && f.kind === 'multiline' ? (
                  <Box flexGrow={1}>
                    <MultilineInput
                      value={draft[f.key] as string}
                      onChange={(v) => set({ [f.key]: v } as Partial<Draft>)}
                      onSubmit={() => setEditing(false)}
                      placeholder={f.placeholder}
                    />
                  </Box>
                ) : value !== null ? (
                  <Text>{value}</Text>
                ) : (
                  <Text dimColor>{f.placeholder}</Text>
                )}
              </Box>

              {isEditing && f.kind === 'select' && (
                <Box flexDirection="column" marginLeft={4}>
                  {f.options!.map((opt) => {
                    const sel = (draft[f.key] as string) === opt;
                    return (
                      <Text key={opt} color={sel ? 'cyan' : undefined}>
                        {sel ? '❯ ' : '  '}
                        {opt}
                      </Text>
                    );
                  })}
                  <Text dimColor>↑↓/jk: choose · x: clear/inherit · Enter: done</Text>
                </Box>
              )}

              {isEditing && f.kind === 'multiselect' && (
                <Box flexDirection="column" marginLeft={4}>
                  {(f.options as readonly SettingSource[]).map((opt, oi) => {
                    const on = draft.settingSources.includes(opt);
                    const focus = oi === multiCursor;
                    return (
                      <Text key={opt} color={focus ? 'cyan' : undefined}>
                        {focus ? '❯ ' : '  '}
                        [{on ? 'x' : ' '}] {opt}
                      </Text>
                    );
                  })}
                  <Text dimColor>↑↓/jk: move · Space: toggle · x: clear/inherit · Enter: done</Text>
                </Box>
              )}
            </Box>
          );
        })}

        <Box marginTop={1}>
          <Text color={onSaveRow ? 'green' : undefined} bold={onSaveRow}>
            {onSaveRow ? '❯ ' : '  '}
            Save
          </Text>
        </Box>
      </Box>

      {warnNoProject ? <Text color="yellow">{warnNoProject}</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        {editing
          ? current?.kind === 'text' || current?.kind === 'multiline'
            ? 'Enter: done · Esc: stop editing'
            : 'Esc: stop editing'
          : '↑↓/jk: move · Enter: edit/Save · s: save · Esc: back'}
      </Text>
    </Box>
  );
}

function AddProject({
  configPath,
  onDone,
}: {
  configPath: string;
  onDone: (msg?: string) => void;
}) {
  return (
    <FieldEditor
      title="Add project"
      subtitle={`Appends a new entry to ${displayPath(configPath)}. Blank fields inherit globals/defaults.`}
      fields={PROJECT_FIELDS}
      initial={emptyDraft()}
      onCancel={() => onDone()}
      onSave={(draft) => {
        const current = readRawConfig(configPath);
        const res = upsertProject(current, null, draft);
        if (!res.ok) return res;
        writeRawConfig(configPath, res.config!);
        onDone(`added ${draft.name.trim()}`);
        return { ok: true };
      }}
    />
  );
}

function EditProject({
  configPath,
  config,
  onDone,
}: {
  configPath: string;
  config: RawConfig;
  onDone: (msg?: string) => void;
}) {
  const projects = config.projects;
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<RawProject | null>(null);

  useInput(
    (input, key) => {
      if (key.escape) {
        onDone();
        return;
      }
      if (projects.length === 0) return;
      if (key.upArrow || input === 'k') setCursor((c) => (c - 1 + projects.length) % projects.length);
      else if (key.downArrow || input === 'j') setCursor((c) => (c + 1) % projects.length);
      else if (key.return) setChosen(projects[cursor]);
    },
    { isActive: chosen === null },
  );

  if (chosen) {
    const originalName = chosen.name;
    return (
      <FieldEditor
        title={`Edit project — ${originalName}`}
        subtitle="Change any option, then Save. Blank fields inherit globals/defaults."
        fields={PROJECT_FIELDS}
        initial={draftFromProject(chosen)}
        onCancel={() => onDone()}
        onSave={(draft) => {
          const current = readRawConfig(configPath);
          const res = upsertProject(current, originalName, draft);
          if (!res.ok) return res;
          writeRawConfig(configPath, res.config!);
          onDone(`updated ${draft.name.trim()}`);
          return { ok: true };
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Edit project</Text>
      <Text dimColor>Pick a project to edit its options.</Text>
      <Box flexDirection="column" marginTop={1}>
        {projects.length === 0 ? (
          <Text dimColor>No projects yet — add one first.</Text>
        ) : (
          projects.map((p, i) => (
            <Text key={p.name} color={i === cursor ? 'cyan' : undefined}>
              {i === cursor ? '❯ ' : '  '}
              {p.name} <Text dimColor>({p.type ?? 'react-native'})</Text> <Text dimColor>{p.path}</Text>
            </Text>
          ))
        )}
      </Box>
      <Text dimColor>↑↓/jk: choose · Enter: edit · Esc: back</Text>
    </Box>
  );
}

function GlobalSettings({
  configPath,
  onDone,
}: {
  configPath: string;
  onDone: (msg?: string) => void;
}) {
  const [initial] = useState<Draft>(() => draftFromGlobals(readRawConfig(configPath)));
  return (
    <FieldEditor
      title="Global settings"
      subtitle="Defaults applied to every project (each project can still override them)."
      fields={GLOBAL_FIELDS}
      initial={initial}
      onCancel={() => onDone()}
      onSave={(draft) => {
        const current = readRawConfig(configPath);
        const res = applyGlobals(current, draft);
        if (!res.ok) return res;
        writeRawConfig(configPath, res.config!);
        onDone('updated global settings');
        return { ok: true };
      }}
    />
  );
}

function RemoveProject({
  configPath,
  onDone,
}: {
  configPath: string;
  onDone: (msg?: string) => void;
}) {
  const [config] = useState<RawConfig>(() => readRawConfig(configPath));
  const projects = config.projects;
  const [cursor, setCursor] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const project = projects[cursor];

  useInput((input, key) => {
    if (confirming) {
      if (input === 'y' && project) {
        // Re-read so we only drop the chosen entry from the current file.
        const current = readRawConfig(configPath);
        const remaining = current.projects.filter((p) => p.name !== project.name);
        writeRawConfig(configPath, { ...current, projects: remaining });
        onDone(`removed ${project.name}`);
      } else if (input === 'n' || key.escape) {
        setConfirming(false);
      }
      return;
    }
    if (key.escape) {
      onDone();
      return;
    }
    if (projects.length === 0) return;
    if (key.upArrow || input === 'k') setCursor((c) => (c - 1 + projects.length) % projects.length);
    else if (key.downArrow || input === 'j') setCursor((c) => (c + 1) % projects.length);
    else if (key.return) {
      if (project) setConfirming(true);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Remove project</Text>
      <Text dimColor>Deletes only the selected entry from {displayPath(configPath)}. The repo is untouched.</Text>

      <Box flexDirection="column" marginTop={1}>
        {projects.length === 0 ? (
          <Text dimColor>No projects to remove.</Text>
        ) : (
          projects.map((p, i) => (
            <Text key={p.name} color={i === cursor ? 'cyan' : undefined}>
              {i === cursor ? '❯ ' : '  '}
              {p.name} <Text dimColor>({p.type ?? 'react-native'})</Text> <Text dimColor>{p.path}</Text>
            </Text>
          ))
        )}
      </Box>

      {confirming ? (
        <Text color="yellow">Remove {project?.name} from the config? y/n</Text>
      ) : (
        <Text dimColor>↑↓/jk: choose · Enter: remove · Esc: back</Text>
      )}
    </Box>
  );
}

// Replace line breaks (from pasted multiline text) with spaces so the
// single-line inputs never wrap and break the bordered form layout.
function stripBreaks(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ');
}
