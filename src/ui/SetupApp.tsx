import { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import {
  readRawConfig,
  writeRawConfig,
  displayPath,
  expandPath,
  type RawConfig,
  type RawProject,
} from '../config.js';
import { hasClaudeMd, installClaudeMd } from '../claudeMd.js';
import type { ProjectType } from '../types.js';

type Screen = 'menu' | 'apply' | 'add' | 'remove';
const PROJECT_TYPES: ProjectType[] = ['react-native', 'web', 'orc'];

/**
 * `orc setup` — a standalone wizard for preparing ~/.orc/config.json and installing the
 * per-project CLAUDE.md. It edits the config file in place (adding/removing whole project
 * entries only) and never mutates the running orchestrator.
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
  if (screen === 'apply') {
    return <ApplyClaudeMd config={config} onDone={back} />;
  }
  if (screen === 'add') {
    return <AddProject configPath={configPath} onDone={back} />;
  }
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
    { key: 'apply', label: 'Apply CLAUDE.md', hint: 'write the type-matched template into a project repo' },
    { key: 'add', label: 'Add project', hint: 'append a new project to the config' },
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

type AddStep = 'name' | 'path' | 'type';

function AddProject({
  configPath,
  onDone,
}: {
  configPath: string;
  onDone: (msg?: string) => void;
}) {
  const [step, setStep] = useState<AddStep>('name');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [typeCursor, setTypeCursor] = useState(0);
  const [error, setError] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onDone();
      return;
    }
    if (step !== 'type') return;
    if (key.upArrow || input === 'k')
      setTypeCursor((c) => (c - 1 + PROJECT_TYPES.length) % PROJECT_TYPES.length);
    else if (key.downArrow || input === 'j')
      setTypeCursor((c) => (c + 1) % PROJECT_TYPES.length);
    else if (key.return) save();
  });

  const save = () => {
    // Re-read at save time so we append to the current file, not a stale snapshot.
    const current = readRawConfig(configPath);
    const trimmedName = name.trim();
    if (current.projects.some((p) => p.name === trimmedName)) {
      setError(`A project named "${trimmedName}" already exists.`);
      return;
    }
    const entry: RawProject = {
      name: trimmedName,
      path: path.trim(),
      type: PROJECT_TYPES[typeCursor],
    };
    writeRawConfig(configPath, { ...current, projects: [...current.projects, entry] });
    onDone(`added ${trimmedName}`);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Add project</Text>
      <Text dimColor>Appends a new entry to {displayPath(configPath)} (nothing existing is changed).</Text>

      <Box marginTop={1}>
        <Text>{step === 'name' ? '› ' : '  '}name : </Text>
        {step === 'name' ? (
          <TextInput
            value={name}
            onChange={setName}
            onSubmit={(v) => {
              if (v.trim()) setStep('path');
            }}
            placeholder="e.g. Acme iOS"
          />
        ) : (
          <Text>{name}</Text>
        )}
      </Box>

      {(step === 'path' || step === 'type') && (
        <Box>
          <Text>{step === 'path' ? '› ' : '  '}path : </Text>
          {step === 'path' ? (
            <TextInput
              value={path}
              onChange={setPath}
              onSubmit={(v) => {
                if (v.trim()) setStep('type');
              }}
              placeholder="e.g. ~/dev/acme-app"
            />
          ) : (
            <Text>{path}</Text>
          )}
        </Box>
      )}

      {step === 'type' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>› type :</Text>
          <Box flexDirection="column" marginLeft={2}>
            {PROJECT_TYPES.map((t, i) => (
              <Text key={t} color={i === typeCursor ? 'cyan' : undefined}>
                {i === typeCursor ? '❯ ' : '  '}
                {t}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        {step === 'type'
          ? '↑↓/jk: choose type · Enter: save · Esc: back'
          : 'Enter: next · Esc: back'}
      </Text>
    </Box>
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
