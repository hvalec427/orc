import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { MultilineInput } from './MultilineInput.js';
import type { AgentTemplate, ProjectConfig } from '../types.js';
import { needsWorktree } from '../types.js';

type Step = 'template' | 'project' | 'magiclink' | 'name' | 'ticket' | 'prompt';

interface TemplateChoice {
  value: AgentTemplate;
  label: string;
  hint: string;
}

const TEMPLATES: TemplateChoice[] = [
  { value: 'feature', label: 'Feature', hint: 'builds one task end-to-end itself, in its own worktree' },
  { value: 'fix', label: 'Fix', hint: 'reproduces, root-causes & lands a minimal fix for a bug' },
  { value: 'worker', label: 'Worker', hint: 'does anything asked; cuts a worktree only if it must edit code' },
  { value: 'pipeline', label: 'Pipeline', hint: 'orchestrates architect→…→tester roles on a shared worktree' },
  { value: 'launcher', label: 'Launcher', hint: 'splits several tasks into separate feature agents' },
  { value: 'explorer', label: 'Explorer', hint: 'read-only; investigates the codebase, cannot edit' },
  { value: 'merge', label: 'Integrate', hint: 'lands the branches you name using the project\u2019s merge/rebase strategy' },
];

/**
 * Does this template get the feature-only fields (magiclink + ticket) and a worktree? True for the
 * full-access `feature` template. Everything else — explorer, merge, launcher, pipeline — just
 * needs a name + prompt.
 */
function isFeature(t: AgentTemplate): boolean {
  return needsWorktree(t);
}

/** Per-template placeholder for the prompt field. Templates not listed fall back to a generic hint. */
const PROMPT_PLACEHOLDERS: Partial<Record<AgentTemplate, string>> = {
  fix: 'describe the bug/problem to fix (symptoms, repro steps, expected behavior)',
  merge: 'which branches should be integrated? (e.g. land agent/foo into master)',
  worker: 'what should this worker do? (anything — it makes a worktree only if it needs to edit code)',
  launcher: 'list everything you want done; it will split the work into feature agents',
  pipeline: 'describe the feature; it will run the full architect→…→tester pipeline',
  explorer: 'what part of the codebase should the explorer investigate and explain?',
};

export function NewAgentForm({
  projects,
  parentName,
  parentTicket,
  onSubmit,
  onCancel,
}: {
  projects: ProjectConfig[];
  /** When set, this form creates a subagent nested under the named parent (opened via `c`). */
  parentName?: string;
  /** The parent's ticket, inherited by subagents so they skip the ticket prompt when set. */
  parentTicket?: string;
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
  // Subagents may leave the name blank to inherit the parent's name, and skip the ticket
  // prompt entirely when the parent already carries one (they share the group's commit).
  const isSubagent = !!parentName;
  const inheritTicket = isSubagent && !!parentTicket?.trim();
  // Whether this form shows a ticket step at all (feature templates, unless inherited).
  const asksTicket = feature && !inheritTicket;

  // The first field to fill in for a template once a project is chosen. Integrate agents are
  // auto-named ("integrator N"), so they skip the name step and go straight to the prompt.
  const firstStep = (t: AgentTemplate, proj: ProjectConfig): Step =>
    isFeature(t) ? (proj.magicLink ? 'magiclink' : 'name') : t === 'merge' ? 'prompt' : 'name';

  // After choosing a project, jump to the first relevant field for the template.
  const afterProject = (proj: ProjectConfig): Step => firstStep(template, proj);

  // The step to return to when going back. This reverses the forward flow,
  // skipping steps that don't apply to the current template/project (e.g. the
  // project chooser with a single project, magiclink/ticket for non-feature
  // agents, name for integrate agents). Returns undefined on the first step, where
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
        if (asksTicket) return 'ticket';
        return template === 'merge' ? beforeFields : 'name';
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      const back = prevStep(step);
      if (back) {
        // Returning to the template picker is a fresh start: clear every field
        // filled in on later steps so a re-pick doesn't carry over stale input.
        if (back === 'template') {
          setMagicLink('');
          setName('');
          setTicket('');
          setPrompt('');
          if (!single) {
            setProject('');
            setCursor(0);
          }
        }
        setStep(back);
      } else onCancel();
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
      // Subagents may leave the name blank to reuse the parent's name.
      name.trim() || (isSubagent ? parentName!.trim() : ''),
      // Ticket only applies to feature agents (they commit); others send empty.
      // Subagents inherit the parent's ticket instead of prompting for one.
      feature ? (inheritTicket ? parentTicket!.trim() : ticket.trim()) : '',
      finalPrompt.trim(),
      hasMagic ? magicLink.trim() || selected?.magicLink : undefined,
    );

  const currentTemplate = TEMPLATES.find((t) => t.value === template)!;
  const promptPlaceholder = PROMPT_PLACEHOLDERS[template] ?? 'what should this agent do?';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{parentName ? `New subagent of "${parentName}"` : 'New agent'}</Text>
      <Text dimColor>
        {parentName
          ? 'Shares the group\u2019s worktree/branch; the parent orchestrates it alongside its siblings.'
          : feature
            ? 'A git worktree + branch + simulator name are derived from the agent name.'
            : 'Runs in the project repo with no worktree.'}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Text>{step === 'template' ? '› ' : '  '}Agents:</Text>
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

      {step !== 'template' &&
        (step === 'project' ? (
          <Box flexDirection="column" marginTop={1}>
            <Text>› project:</Text>
            <Box flexDirection="column" marginLeft={2}>
              {projects.map((p, i) => (
                <Text key={p.name} color={i === cursor ? 'cyan' : undefined}>
                  {i === cursor ? '❯ ' : '  '}
                  {p.name} <Text dimColor>({p.repo})</Text>
                </Text>
              ))}
            </Box>
          </Box>
        ) : (
          <Box>
            <Text>  project: {project}</Text>
          </Box>
        ))}

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

      {template !== 'merge' && (step === 'name' || step === 'ticket' || step === 'prompt') && (
        <Box>
          <Text>{step === 'name' ? '› ' : '  '}name   : </Text>
          {step === 'name' ? (
            <TextInput
              value={name}
              onChange={(v) => setName(stripBreaks(v))}
              onSubmit={(v) => {
                // Subagents may leave the name blank to inherit the parent's name.
                if (v.trim() || isSubagent) setStep(asksTicket ? 'ticket' : 'prompt');
              }}
              placeholder={isSubagent ? `Enter to reuse "${parentName}"` : 'e.g. login-flow'}
            />
          ) : (
            <Text>{name.trim() || parentName}</Text>
          )}
        </Box>
      )}

      {asksTicket && (step === 'ticket' || step === 'prompt') && (
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
