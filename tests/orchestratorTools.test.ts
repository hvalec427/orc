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
