import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ProjectConfig } from '../types.js';
import { hasClaudeMd, installClaudeMd } from '../claudeMd.js';

export function ProjectsView({
  projects,
  onExit,
}: {
  projects: ProjectConfig[];
  onExit: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');

  const project = projects[cursor];

  useInput((input, key) => {
    if (confirming) {
      if (input === 'y' && project) {
        const r = installClaudeMd(project.repo, { overwrite: true });
        setNotice(`${r} CLAUDE.md in ${project.name}`);
      } else if (input === 'n' || key.escape) {
        setNotice('cancelled');
      }
      setConfirming(false);
      return;
    }
    if (key.escape) {
      onExit();
      return;
    }
    if (projects.length === 0) return;
    if (key.upArrow) setCursor((c) => (c - 1 + projects.length) % projects.length);
    else if (key.downArrow) setCursor((c) => (c + 1) % projects.length);
    else if (input === 'c' || key.return) {
      if (!project) return;
      if (hasClaudeMd(project.repo)) {
        setConfirming(true);
      } else {
        const r = installClaudeMd(project.repo, { overwrite: false });
        setNotice(`${r} CLAUDE.md in ${project.name}`);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Projects — install mobile CLAUDE.md</Text>
      <Text dimColor>Writes the mobile agent instructions into the selected project's CLAUDE.md.</Text>

      <Box flexDirection="column" marginTop={1}>
        {projects.map((p, i) => {
          const has = hasClaudeMd(p.repo);
          return (
            <Text key={p.name} color={i === cursor ? 'cyan' : undefined}>
              {i === cursor ? '❯ ' : '  '}
              {p.name} <Text dimColor>{p.repo}</Text>{' '}
              {has ? <Text color="green">[has CLAUDE.md]</Text> : <Text dimColor>[none]</Text>}
            </Text>
          );
        })}
      </Box>

      {confirming ? (
        <Text color="yellow">{project?.name}: CLAUDE.md already exists — overwrite? y/n</Text>
      ) : (
        <Text dimColor>
          ↑↓: choose · c/Enter: install · Esc: back{notice ? `   ·   ${notice}` : ''}
        </Text>
      )}
    </Box>
  );
}
