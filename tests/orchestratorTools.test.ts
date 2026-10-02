import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrchestratorTools,
  buildSubagentTools,
  buildSpawnSubagentTool,
  SPAWNABLE_TEMPLATES,
  type OrchestratorCallbacks,
  type SubagentInfo,
} from '../src/agent/orchestratorTools.js';

// The in-process MCP tools return an SDK CallToolResult: { content: [{type:'text', text}], isError? }.
// These helpers pull the flat text / error flag out so the assertions read cleanly.
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

// A tool definition's `handler` is what the SDK invokes. We call it directly with (input, extra);
// the second arg is unused by these handlers, so an empty object is fine.
type AnyTool = { name: string; handler: (input: any, extra: any) => Promise<any> };
function toolByName(tools: AnyTool[], name: string): AnyTool {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool "${name}" not found`);
  return t;
}
async function call(tool: AnyTool, input: unknown) {
  return tool.handler(input as any, {} as any);
}

const SUB: SubagentInfo = {
  id: 'c1',
  name: 'login-flow',
  template: 'feature',
  status: 'running',
  summary: 'building the login screen',
};

/** A spyable set of orchestrator callbacks with sensible defaults; override per test. */
function makeCallbacks(over: Partial<OrchestratorCallbacks> = {}): OrchestratorCallbacks & {
  calls: { ask: Array<{ childId: string; question: string }>; answer: Array<{ childId: string; answer: string }> };
} {
  const calls = { ask: [] as any[], answer: [] as any[] };
  return {
    listSubagents: over.listSubagents ?? (() => [SUB]),
    askSubagent:
      over.askSubagent ??
      (async (args) => {
        calls.ask.push(args);
        return { status: 'done', answer: 'child answer' };
      }),
    answerSubagent:
      over.answerSubagent ??
      (async (args) => {
        calls.answer.push(args);
        return { delivered: true };
      }),
    calls,
  };
}

test('list_subagents renders each subagent with id, template, status and summary', async () => {
  const cb = makeCallbacks();
  const tools = buildOrchestratorTools(cb) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'list_subagents'), {});
  const text = textOf(res);
  assert.match(text, /login-flow/);
  assert.match(text, /c1/);
  assert.match(text, /feature/);
  assert.match(text, /running/);
  assert.match(text, /building the login screen/);
});

test('list_subagents reports an empty group with a helpful hint', async () => {
  const cb = makeCallbacks({ listSubagents: () => [] });
  const tools = buildOrchestratorTools(cb) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'list_subagents'), {});
  assert.match(textOf(res), /no subagents yet/i);
});

test('ask_subagent forwards id+question and returns the child answer with its status', async () => {
  const cb = makeCallbacks();
  const tools = buildOrchestratorTools(cb) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'ask_subagent'), { childId: 'c1', question: 'status?' });
  assert.deepEqual(cb.calls.ask, [{ childId: 'c1', question: 'status?' }]);
  const text = textOf(res);
  assert.match(text, /done/);
  assert.match(text, /child answer/);
  assert.ok(!res.isError);
});

test('ask_subagent surfaces a thrown error as an isError result (bad scoping)', async () => {
  const cb = makeCallbacks({
    askSubagent: async () => {
      throw new Error('"c9" is not one of your subagents.');
    },
  });
  const tools = buildOrchestratorTools(cb) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'ask_subagent'), { childId: 'c9', question: 'hi' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /not one of your subagents/);
});

test('answer_subagent reports delivery when the child was waiting', async () => {
  const cb = makeCallbacks();
  const tools = buildOrchestratorTools(cb) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'answer_subagent'), { childId: 'c1', answer: 'use JWT' });
  assert.deepEqual(cb.calls.answer, [{ childId: 'c1', answer: 'use JWT' }]);
  assert.match(textOf(res), /delivered/i);
});

test('answer_subagent reports a fallback message when the child was not waiting', async () => {
  const cb = makeCallbacks({ answerSubagent: async () => ({ delivered: false }) });
  const tools = buildOrchestratorTools(cb) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'answer_subagent'), { childId: 'c1', answer: 'ping' });
  assert.match(textOf(res), /not waiting/i);
});

/** A no-op report callback for tests that only exercise ask_orchestrator. */
const noopReport = () => ({ delivered: true });

test('spawn_subagent forwards template/name/prompt/ticket and reports the created id+name', async () => {
  const seen: Array<{ template: string; name: string; prompt: string; ticket: string }> = [];
  const tools = buildSpawnSubagentTool(async (args) => {
    seen.push(args);
    return { id: 'login-flow', name: 'login-flow' };
  }) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'spawn_subagent'), {
    template: 'explorer',
    name: 'login-flow',
    prompt: 'investigate the login screen',
    ticket: 'PROJ-1',
  });
  assert.deepEqual(seen, [
    { template: 'explorer', name: 'login-flow', prompt: 'investigate the login screen', ticket: 'PROJ-1' },
  ]);
  const text = textOf(res);
  assert.match(text, /explorer/);
  assert.match(text, /login-flow/);
  assert.ok(!res.isError);
});

test('spawn_subagent passes through the chosen template and ticket to the callback', async () => {
  const seen: Array<{ template: string; ticket: string }> = [];
  const tools = buildSpawnSubagentTool(async (args) => {
    seen.push({ template: args.template, ticket: args.ticket });
    return { id: 'x', name: 'x' };
  }) as unknown as AnyTool[];
  // The SDK applies zod defaults before the handler runs; call the handler as the SDK would, with the
  // parsed input (template 'feature', ticket '').
  await call(toolByName(tools, 'spawn_subagent'), { template: 'feature', name: 'x', prompt: 'do x', ticket: '' });
  assert.deepEqual(seen, [{ template: 'feature', ticket: '' }]);
});

test('spawn_subagent surfaces a thrown error as an isError result', async () => {
  const tools = buildSpawnSubagentTool(async () => {
    throw new Error('Unknown project: ghost');
  }) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'spawn_subagent'), {
    template: 'feature',
    name: 'x',
    prompt: 'do x',
    ticket: '',
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /Unknown project: ghost/);
});

test('SPAWNABLE_TEMPLATES are the four standalone kinds (no orchestrator-internal templates)', () => {
  assert.deepEqual(new Set(SPAWNABLE_TEMPLATES), new Set(['feature', 'fix', 'explorer', 'worker']));
});

test('ask_orchestrator returns the parent answer', async () => {
  const seen: string[] = [];
  const tools = buildSubagentTools(async (args) => {
    seen.push(args.question);
    return { answer: 'go with option B' };
  }, noopReport) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'ask_orchestrator'), { question: 'A or B?' });
  assert.deepEqual(seen, ['A or B?']);
  assert.match(textOf(res), /go with option B/);
  assert.ok(!res.isError);
});

test('ask_orchestrator surfaces a thrown error as an isError result', async () => {
  const tools = buildSubagentTools(async () => {
    throw new Error('boom');
  }, noopReport) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'ask_orchestrator'), { question: 'x' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /boom/);
});

test('report_to_orchestrator forwards the note and confirms delivery', async () => {
  const notes: string[] = [];
  const tools = buildSubagentTools(async () => ({ answer: '' }), (args) => {
    notes.push(args.note);
    return { delivered: true };
  }) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'report_to_orchestrator'), { note: 'tests green' });
  assert.deepEqual(notes, ['tests green']);
  assert.match(textOf(res), /reported/i);
  assert.ok(!res.isError);
});

test('report_to_orchestrator notes when there is no orchestrator to receive it', async () => {
  const tools = buildSubagentTools(
    async () => ({ answer: '' }),
    () => ({ delivered: false }),
  ) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'report_to_orchestrator'), { note: 'hi' });
  assert.match(textOf(res), /no orchestrator/i);
  assert.ok(!res.isError);
});

// --- buildRunTool (NEW: the custom mcp__orc__run tool) ---------------------------------------------
// Expected RED until the implementer adds buildRunTool(runInPane, readOnly?) to orchestratorTools.ts.
// It returns a tool('run', …) whose fully-qualified name is mcp__orc__run; its handler runs the
// command in the agent's pane (or the injected fallback) and maps the real rc to isError.
// Dynamic import so the missing export fails ONLY these tests, not the whole file.

test('buildRunTool success: rc 0 returns the output text with isError false', async () => {
  const mod = (await import('../src/agent/orchestratorTools.js')) as any;
  assert.equal(typeof mod.buildRunTool, 'function', 'buildRunTool is exported');
  const tools = mod.buildRunTool(async () => ({ output: 'hi', rc: 0 })) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'run'), { command: 'echo hi' });
  assert.deepEqual(res.content, [{ type: 'text', text: 'hi' }]);
  assert.ok(!res.isError, 'rc 0 → not an error');
});

test('buildRunTool non-zero rc surfaces as isError true (output still returned)', async () => {
  const mod = (await import('../src/agent/orchestratorTools.js')) as any;
  const tools = mod.buildRunTool(async () => ({ output: 'boom', rc: 2 })) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'run'), { command: 'false' });
  assert.equal(res.isError, true, 'rc 2 → isError');
  assert.match(textOf(res), /boom/);
});

test('buildRunTool denies a state-changing command for a read-only agent', async () => {
  const mod = (await import('../src/agent/orchestratorTools.js')) as any;
  // readOnly=true → a state-changing command must be refused with a deny message, never run.
  let ran = false;
  const tools = mod.buildRunTool(
    async () => {
      ran = true;
      return { output: '', rc: 0 };
    },
    true,
  ) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'run'), { command: 'rm -rf /' });
  assert.equal(res.isError, true, 'state-changing command is refused');
  assert.equal(ran, false, 'the command was never executed in the pane');
  assert.match(textOf(res), /spawn a full-access|read-only/i);
});

test('buildRunTool allows a read-only command for a read-only agent', async () => {
  const mod = (await import('../src/agent/orchestratorTools.js')) as any;
  const tools = mod.buildRunTool(async () => ({ output: 'log output', rc: 0 }), true) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'run'), { command: 'git log' });
  assert.ok(!res.isError, 'read-only command runs fine for a read-only agent');
  assert.match(textOf(res), /log output/);
});

test('buildRunTool surfaces an error result when runInPane rejects (e.g. aborted)', async () => {
  const mod = (await import('../src/agent/orchestratorTools.js')) as any;
  const tools = mod.buildRunTool(async () => {
    throw new Error('The operation was aborted');
  }) as unknown as AnyTool[];
  const res = await call(toolByName(tools, 'run'), { command: 'sleep 100' });
  assert.equal(res.isError, true, 'a rejected runInPane surfaces as an error, not a hang/throw');
  assert.match(textOf(res), /aborted/i);
});

test('buildRunTool threads the SDK extra.signal into runInPane', async () => {
  const mod = (await import('../src/agent/orchestratorTools.js')) as any;
  const ac = new AbortController();
  let seen: AbortSignal | undefined;
  const tools = mod.buildRunTool(async (_cmd: string, signal: AbortSignal) => {
    seen = signal;
    return { output: '', rc: 0 };
  }) as unknown as AnyTool[];
  await toolByName(tools, 'run').handler({ command: 'echo hi' } as any, { signal: ac.signal } as any);
  assert.equal(seen, ac.signal, 'the per-call SDK signal reaches runInPane');
});

test('the run tool is named "run" (fully-qualified mcp__orc__run on the orc server)', async () => {
  const mod = (await import('../src/agent/orchestratorTools.js')) as any;
  const tools = mod.buildRunTool(async () => ({ output: '', rc: 0 })) as unknown as AnyTool[];
  assert.ok(toolByName(tools, 'run'), 'exposes a tool literally named "run"');
});
