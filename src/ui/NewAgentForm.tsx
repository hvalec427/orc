import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { MultilineInput } from './MultilineInput.js';
import type { AgentTemplate, ProjectConfig } from '../types.js';
import { ROLE_TEMPLATES } from '../types.js';
import { ROLE_SPECS } from '../agentPrompt.js';

type Step = 'template' | 'project' | 'magiclink' | 'name' | 'ticket' | 'prompt';

interface TemplateChoice {
  value: AgentTemplate;
  label: string;
  hint: string;
}

const TEMPLATES: TemplateChoice[] = [
  { value: 'feature', label: 'Feature', hint: 'new git worktree + branch; builds a feature' },
  { value: 'question', label: 'Question', hint: 'read-only; answers a question, cannot edit' },
  { value: 'merge', label: 'Merge', hint: 'merges the branches you name' },
  { value: 'launcher', label: 'Launcher', hint: 'splits several tasks into separate feature agents' },
  // The seven standalone role agents: each runs on its own in its own worktree.
  ...ROLE_TEMPLATES.map((role) => ({
    value: role,
    label: ROLE_SPECS[role].label,
    hint: ROLE_SPECS[role].hint,
  })),
  { value: 'pipeline', label: 'Pipeline', hint: 'runs the roles in a row on one shared worktree' },
];

/**
 * Templates backed by their own git worktree + branch + port, which therefore use the
 * worktree-only form fields (magic link, ticket) and whose worktree gets cleaned up on removal:
 * the original `feature` plus all seven role agents. `question`/`merge`/`launcher`/`pipeline`
 * do not get their own worktree here (the pipeline creates a shared worktree internally).
 */
function isWorktreeTemplate(t: AgentTemplate): boolean {
  return t === 'feature' || (ROLE_TEMPLATES as readonly AgentTemplate[]).includes(t);
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
  // Worktree-backed templates (feature + the seven role agents) use the magic-link and ticket
  // fields; the orchestrator-ish templates (question/merge/launcher/pipeline) do not.
  const worktree = isWorktreeTemplate(template);
  const hasMagic = worktree && !!selected?.magicLink;

  // The first field to fill in for a template once a project is chosen. Merge agents are
  // auto-named ("merger N"), so they skip the name step and go straight to the prompt; every
  // other non-worktree template (question/launcher/pipeline) starts at the name field.
  const firstStep = (t: AgentTemplate, proj: ProjectConfig): Step =>
    isWorktreeTemplate(t) ? (proj.magicLink ? 'magiclink' : 'name') : t === 'merge' ? 'prompt' : 'name';

  // After choosing a project, jump to the first relevant field for the template.
  const afterProject = (proj: ProjectConfig): Step => firstStep(template, proj);

  // The step to return to when going back. This reverses the forward flow,
  // skipping steps that don't apply to the current template/project (e.g. the
  // project chooser with a single project, magiclink/ticket for non-worktree
  // agents, name for merge agents). Returns undefined on the first step, where
  // there is nothing to go back to and Esc should cancel instead.
  const prevStep = (s: Step): Step | undefined => {
    const beforeFields: Step = single ? 'template' : 'project';
    switch (s) {
      case 'template':
        return undefined;
      case 'project':
        return 'template';
      case 'magiclink':
        return beforeFields;
      case 'name':
        return hasMagic ? 'magiclink' : beforeFields;
      case 'ticket':
        return 'name';
      case 'prompt':
        // Reverse of firstStep/field order for the current template.
        if (worktree) return 'ticket';
        return template === 'merge' ? beforeFields : 'name';
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      const back = prevStep(step);
      if (back) setStep(back);
      else onCancel();
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
          setStep(firstStep(t, single));
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
      setStep(afterProject(proj));
    }
  });

  const finish = (finalPrompt: string) =>
    onSubmit(
      template,
      project,
      name.trim(),
      // Ticket only applies to worktree agents (they commit); others send empty.
      worktree ? ticket.trim() : '',
      finalPrompt.trim(),
      hasMagic ? magicLink.trim() || selected?.magicLink : undefined,
    );

  const currentTemplate = TEMPLATES.find((t) => t.value === template)!;
  const promptPlaceholder =
    template === 'question'
      ? 'what do you want to ask about this repo?'
      : template === 'merge'
        ? 'which branches should be merged? (e.g. merge agent/foo into master)'
        : template === 'launcher'
          ? 'list everything you want done; it will split the work into feature agents'
          : template === 'pipeline'
            ? 'describe the task; it runs architect→…→tester in a row on one worktree'
            : 'what should this agent do?';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">New agent</Text>
      <Text dimColor>
        {worktree
          ? 'A git worktree + branch + simulator name are derived from the agent name.'
          : template === 'pipeline'
            ? 'Runs the role phases in a row on one shared worktree it creates.'
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
                if (v.trim()) setStep(worktree ? 'ticket' : 'prompt');
              }}
              placeholder="e.g. login-flow"
            />
          ) : (
            <Text>{name}</Text>
          )}
        </Box>
      )}

      {worktree && (step === 'ticket' || step === 'prompt') && (
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
          <Box flexGrow={1}>
            <MultilineInput
              value={prompt}
              onChange={setPrompt}
              onSubmit={(v) => {
                if (v.trim()) finish(v);
              }}
              placeholder={promptPlaceholder}
            />
          </Box>
        </Box>
      )}

      <Text dimColor>
        {(() => {
          // On the first step there's nothing to go back to, so Esc cancels.
          const esc = prevStep(step) ? 'Esc: back' : 'Esc: cancel';
          if (step === 'template' || step === 'project')
            return `↑↓/jk: choose · Enter: select · ${esc}`;
          if (step === 'prompt') return `Enter: create · Alt/Shift+Enter: newline · ${esc}`;
          return `Enter: next/create · ${esc}`;
        })()}
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
