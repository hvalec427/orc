import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { ProjectConfig } from '../types.js';

type Step = 'project' | 'magiclink' | 'name' | 'ticket' | 'prompt';

export function NewAgentForm({
  projects,
  onSubmit,
  onCancel,
}: {
  projects: ProjectConfig[];
  onSubmit: (
    project: string,
    name: string,
    ticket: string,
    prompt: string,
    magicLink: string | undefined,
  ) => void;
  onCancel: () => void;
}) {
  const single = projects.length === 1 ? projects[0] : undefined;
  const [step, setStep] = useState<Step>(
    single ? (single.magicLink ? 'magiclink' : 'name') : 'project',
  );
  const [project, setProject] = useState<string>(single?.name ?? '');
  const [cursor, setCursor] = useState(0);
  const [magicLink, setMagicLink] = useState<string>(single?.magicLink ?? '');
  const [name, setName] = useState('');
  const [ticket, setTicket] = useState('');
  const [prompt, setPrompt] = useState('');

  const selected = projects.find((p) => p.name === project);
  const hasMagic = !!selected?.magicLink;

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (step !== 'project') return;
    if (key.upArrow || input === 'k' || input === 'h')
      setCursor((c) => (c - 1 + projects.length) % projects.length);
    else if (key.downArrow || input === 'j' || input === 'l')
      setCursor((c) => (c + 1) % projects.length);
    else if (key.return) {
      const proj = projects[cursor];
      setProject(proj.name);
      setMagicLink(proj.magicLink ?? '');
      setStep(proj.magicLink ? 'magiclink' : 'name');
    }
  });

  const finish = (finalPrompt: string) =>
    onSubmit(project, name.trim(), ticket.trim(), finalPrompt.trim(), hasMagic ? magicLink.trim() : undefined);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">New agent</Text>
      <Text dimColor>A git worktree + branch + simulator name are derived from the agent name.</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text>{step === 'project' ? '› ' : '  '}project:</Text>
        {step === 'project' ? (
          <Box flexDirection="column" marginLeft={2}>
            {projects.map((p, i) => (
              <Text key={p.name} color={i === cursor ? 'cyan' : undefined}>
                {i === cursor ? '❯ ' : '  '}
                {p.name} <Text dimColor>({p.repo})</Text>
              </Text>
            ))}
          </Box>
        ) : (
          <Text>  {project}</Text>
        )}
      </Box>

      {hasMagic && step !== 'project' && (
        <Box>
          <Text>{step === 'magiclink' ? '› ' : '  '}magic  : </Text>
          {step === 'magiclink' ? (
            <TextInput
              value={magicLink}
              onChange={setMagicLink}
              onSubmit={() => setStep('name')}
              placeholder="Enter to use config default · edit to override · clear for none"
            />
          ) : (
            <Text dimColor>{magicLink ? truncate(magicLink, 48) : '(none)'}</Text>
          )}
        </Box>
      )}

      {(step === 'name' || step === 'ticket' || step === 'prompt') && (
        <Box>
          <Text>{step === 'name' ? '› ' : '  '}name   : </Text>
          {step === 'name' ? (
            <TextInput
              value={name}
              onChange={setName}
              onSubmit={(v) => {
                if (v.trim()) setStep('ticket');
              }}
              placeholder="e.g. login-flow"
            />
          ) : (
            <Text>{name}</Text>
          )}
        </Box>
      )}

      {(step === 'ticket' || step === 'prompt') && (
        <Box>
          <Text>{step === 'ticket' ? '› ' : '  '}ticket : </Text>
          {step === 'ticket' ? (
            <TextInput
              value={ticket}
              onChange={setTicket}
              onSubmit={() => setStep('prompt')}
              placeholder="e.g. PROJ-123 (optional — for the commit; Enter to skip)"
            />
          ) : (
            <Text>{ticket ? ticket : <Text dimColor>—</Text>}</Text>
          )}
        </Box>
      )}

      {step === 'prompt' && (
        <Box>
          <Text>› prompt : </Text>
          <TextInput
            value={prompt}
            onChange={setPrompt}
            onSubmit={(v) => {
              if (v.trim()) finish(v);
            }}
            placeholder="what should this agent do?"
          />
        </Box>
      )}

      <Text dimColor>
        {step === 'project'
          ? '↑↓/jk: choose · Enter: select · Esc: cancel'
          : 'Enter: next/create · Esc: cancel'}
      </Text>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
