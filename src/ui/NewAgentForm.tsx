import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { ProjectConfig } from '../types.js';

type Step = 'project' | 'name' | 'ticket' | 'prompt';

export function NewAgentForm({
  projects,
  onSubmit,
  onCancel,
}: {
  projects: ProjectConfig[];
  onSubmit: (project: string, name: string, ticket: string, prompt: string) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>(projects.length === 1 ? 'name' : 'project');
  const [project, setProject] = useState<string>(projects.length === 1 ? projects[0].name : '');
  const [cursor, setCursor] = useState(0);
  const [name, setName] = useState('');
  const [ticket, setTicket] = useState('');
  const [prompt, setPrompt] = useState('');

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (step !== 'project') return;
    if (key.upArrow) setCursor((c) => (c - 1 + projects.length) % projects.length);
    else if (key.downArrow) setCursor((c) => (c + 1) % projects.length);
    else if (key.return) {
      setProject(projects[cursor].name);
      setStep('name');
    }
  });

  const filled = (v: string) => (v ? v : <Text dimColor>—</Text>);

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

      {step !== 'project' && (
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
            <Text>{filled(ticket)}</Text>
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
              if (v.trim()) onSubmit(project, name.trim(), ticket.trim(), v.trim());
            }}
            placeholder="what should this agent do?"
          />
        </Box>
      )}

      <Text dimColor>
        {step === 'project'
          ? '↑↓: choose · Enter: select · Esc: cancel'
          : 'Enter: next/create · Esc: cancel'}
      </Text>
    </Box>
  );
}
