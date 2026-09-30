import { AgentSession } from '../src/agent/AgentSession.js';
import type { OrcConfig } from '../src/types.js';

const config: OrcConfig = {
  repo: '/tmp',
  model: 'claude-opus-4-8',
  worktreeDir: '.worktrees',
  basePort: 8300,
  permissionMode: 'bypassPermissions',
  settingSources: ['project'],
};

const s = new AgentSession({
  id: 'x',
  name: 'x',
  ticket: 't',
  branch: 'agent/x',
  worktree: '/tmp/x',
  metroPort: 8300,
  config,
});

// Feed synthetic stream events directly into the private handler.
const h = (msg: unknown) => (s as unknown as { handle: (m: unknown) => void }).handle(msg);
const ev = (event: unknown) => h({ type: 'stream_event', event });

// tool_use Bash streamed via input_json_delta
ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash' } });
ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm ' } });
ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'test"}' } });
ev({ type: 'content_block_stop', index: 0 });
ev({ type: 'message_stop' });

// text streamed via text_delta
ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } });
ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } });
ev({ type: 'content_block_stop', index: 0 });
ev({ type: 'message_stop' });

// result with NEEDS_INPUT
h({ type: 'result', subtype: 'success', result: 'Which color?\n@@NEEDS_INPUT@@', session_id: 'sess1', total_cost_usd: 0.01 });

const events = s.getEvents();
console.log('events:');
for (const e of events) console.log(`  [${e.kind}] "${e.text}"`);
console.log('status:', s.getInfo().status);
console.log('question:', JSON.stringify(s.getInfo().question));
console.log('sessionId:', s.getInfo().sessionId, 'cost:', s.getInfo().totalCostUsd);

const toolOk = events.some((e) => e.kind === 'tool' && e.text === '▸ Bash npm test');
const textOk = events.some((e) => e.kind === 'text' && e.text === 'Hello world');
const statusOk = s.getInfo().status === 'needs_input' && s.getInfo().question === 'Which color?';
console.log('\ntoolOk:', toolOk, 'textOk:', textOk, 'statusOk:', statusOk);
process.exit(toolOk && textOk && statusOk ? 0 : 1);
