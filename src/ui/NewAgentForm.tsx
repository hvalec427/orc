import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentTemplate, ProjectConfig } from '../types.js';

type Step = 'template' | 'project' | 'magiclink' | 'name' | 'ticket' | 'prompt';

interface TemplateChoice {
  value: AgentTemplate;
  label: string;
  hint: string;
}

const TEMPLATES: TemplateChoice[] = [
  { value: 'feature', label: 'Feature', hint: 'new git worktree + branch; builds a feature' },
  { value: 'question', label: 'Question', hint: 'read-only; answers a question, cannot edit' },
  { value: 'merge', label: 'Merge', hint: 'no worktree; merges branches you name' },
];

/** Does this template need a worktree/branch (and therefore the feature-only fields)? */
function isFeature(t: AgentTemplate): boolean {
  return t === 'feature';
}

export function NewAgentForm({
  projects,
  onSubmit,
  onCancel,
}: {
  projects: ProjectConfig[];
  onSubmit: (
    template: AgentTemplate,
    project: string,
    name: string,
    ticket: string,
    prompt: string,
    magicLink: string | undefined,
  ) => void;
  onCancel: () => void;
}) {
  const single = projects.length === 1 ? projects[0] : undefined;
  const [step, setStep] = useState<Step>('template');
  const [template, setTemplate] = useState<AgentTemplate>('feature');
  const [templateCursor, setTemplateCursor] = useState(0);
  const [project, setProject] = useState<string>(single?.name ?? '');
  const [cursor, setCursor] = useState(0);
  const [magicLink, setMagicLink] = useState<string>('');
  const [name, setName] = useState('');
  const [ticket, setTicket] = useState('');
  const [prompt, setPrompt] = useState('');

  const selected = projects.find((p) => p.name === project);
  const feature = isFeature(template);
  const hasMagic = feature && !!selected?.magicLink;

  // After choosing a project, jump to the first relevant field for the template.
  const afterProject = (proj: ProjectConfig): Step =>
    feature ? (proj.magicLink ? 'magiclink' : 'name') : 'name';

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (step === 'template') {
      if (key.upArrow || input === 'k')
        setTemplateCursor((c) => (c - 1 + TEMPLATES.length) % TEMPLATES.length);
      else if (key.downArrow || input === 'j')
        setTemplateCursor((c) => (c + 1) % TEMPLATES.length);
      else if (key.return) {
        const t = TEMPLATES[templateCursor].value;
        setTemplate(t);
        // Single project: skip project selection and go to the template's first field.
        if (single) {
          setProject(single.name);
          setStep(isFeature(t) ? (single.magicLink ? 'magiclink' : 'name') : 'name');
        } else {
          setStep('project');
        }
      }
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
      setMagicLink('');
      setStep(afterProject(proj));
    }
  });

  const finish = (finalPrompt: string) =>
    onSubmit(
      template,
      project,
      name.trim(),
      // Ticket only applies to feature agents (they commit); others send empty.
      feature ? ticket.trim() : '',
      finalPrompt.trim(),
      hasMagic ? magicLink.trim() || selected?.magicLink : undefined,
    );

  const currentTemplate = TEMPLATES.find((t) => t.value === template)!;
  const promptPlaceholder =
    template === 'question'
      ? 'what do you want to ask about this repo?'
      : template === 'merge'
        ? 'which branches should be merged? (e.g. merge agent/foo into master)'
        : 'what should this agent do?';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">New agent</Text>
      <Text dimColor>
        {feature
          ? 'A git worktree + branch + simulator name are derived from the agent name.'
          : 'Runs in the project repo with no worktree.'}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Text>{step === 'template' ? '› ' : '  '}template:</Text>
        {step === 'template' ? (
          <Box flexDirection="column" marginLeft={2}>
            {TEMPLATES.map((t, i) => (
              <Text key={t.value} color={i === templateCursor ? 'cyan' : undefined}>
                {i === templateCursor ? '❯ ' : '  '}
                {t.label} <Text dimColor>— {t.hint}</Text>
              </Text>
            ))}
          </Box>
        ) : (
          <Text>  {currentTemplate.label} <Text dimColor>— {currentTemplate.hint}</Text></Text>
        )}
      </Box>

      {step !== 'template' && (
        <Box flexDirection="column" marginTop={step === 'project' ? 1 : 0}>
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
      )}

      {hasMagic && step !== 'template' && step !== 'project' && (
        <Box>
          <Text>{step === 'magiclink' ? '› ' : '  '}magic  : </Text>
          {step === 'magiclink' ? (
            <TextInput
              value={magicLink}
              onChange={(v) => setMagicLink(stripBreaks(v))}
              onSubmit={() => setStep('name')}
              placeholder={
                selected?.magicLink
                  ? `${truncate(selected.magicLink, 44)} (Enter to use, or paste a new one)`
                  : ''
              }
            />
          ) : (
            <Text dimColor>{truncate(magicLink.trim() || selected?.magicLink || '(none)', 48)}</Text>
          )}
        </Box>
      )}

      {(step === 'name' || step === 'ticket' || step === 'prompt') && (
        <Box>
          <Text>{step === 'name' ? '› ' : '  '}name   : </Text>
          {step === 'name' ? (
            <TextInput
              value={name}
              onChange={(v) => setName(stripBreaks(v))}
              onSubmit={(v) => {
                if (v.trim()) setStep(feature ? 'ticket' : 'prompt');
              }}
              placeholder="e.g. login-flow"
            />
          ) : (
            <Text>{name}</Text>
          )}
        </Box>
      )}

      {feature && (step === 'ticket' || step === 'prompt') && (
        <Box>
          <Text>{step === 'ticket' ? '› ' : '  '}ticket : </Text>
          {step === 'ticket' ? (
            <TextInput
              value={ticket}
              onChange={(v) => setTicket(stripBreaks(v))}
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
            onChange={(v) => setPrompt(stripBreaks(v))}
            onSubmit={(v) => {
              if (v.trim()) finish(v);
            }}
            placeholder={promptPlaceholder}
          />
        </Box>
      )}

      <Text dimColor>
        {step === 'template' || step === 'project'
          ? '↑↓/jk: choose · Enter: select · Esc: cancel'
          : 'Enter: next/create · Esc: cancel'}
      </Text>
    </Box>
  );
}

// Replace line breaks (from pasted multiline text) with spaces so the
// single-line inputs never wrap and break the bordered form layout.
function stripBreaks(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ');
}

function truncate(s: string, n: number): string {
  const one = stripBreaks(s);
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}
