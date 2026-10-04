import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InputQueue } from '../src/agent/InputQueue.js';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function withTimeout<T>(p: Promise<T>, ms = 1000, label = 'operation'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label} did not settle in ${ms}ms`)), ms),
    ),
  ]);
}

function assertUserMsg(msg: SDKUserMessage, expectedContent: string): void {
  assert.equal(msg.type, 'user');
  assert.equal(msg.message.role, 'user');
  assert.equal(msg.message.content, expectedContent);
  assert.equal(msg.parent_tool_use_id, null);
  assert.equal(msg.session_id, '');
}

describe('InputQueue', () => {
  test('push with a consumer waiting resolves the pending next()', async () => {
    const q = new InputQueue();
    const it = q[Symbol.asyncIterator]();
    const p = it.next();
    await flush();
    q.push('hello');
    const res = await withTimeout(p, 1000, 'waiter push');
    assert.equal(res.done, false);
    assertUserMsg(res.value as SDKUserMessage, 'hello');
  });

  test('push with no consumer waiting buffers FIFO', async () => {
    const q = new InputQueue();
    const it = q[Symbol.asyncIterator]();
    q.push('first');
    q.push('second');
    q.close();
    const r1 = await withTimeout(it.next(), 1000, 'buffer r1');
    assert.equal(r1.done, false);
    assertUserMsg(r1.value as SDKUserMessage, 'first');
    const r2 = await withTimeout(it.next(), 1000, 'buffer r2');
    assert.equal(r2.done, false);
    assertUserMsg(r2.value as SDKUserMessage, 'second');
    const r3 = await withTimeout(it.next(), 1000, 'buffer r3');
    assert.equal(r3.done, true);
    assert.equal(r3.value, undefined);
  });

  test('close with a pending next() ends the stream (done:true)', async () => {
    const q = new InputQueue();
    const it = q[Symbol.asyncIterator]();
    const p = it.next();
    await flush();
    q.close();
    const res = await withTimeout(p, 1000, 'waiter close');
    assert.equal(res.done, true);
    assert.equal(res.value, undefined);
    const res2 = await withTimeout(it.next(), 1000, 'post-close next');
    assert.equal(res2.done, true);
  });

  test('close while items buffered drains all buffered items FIFO before terminating', async () => {
    const q = new InputQueue();
    const it = q[Symbol.asyncIterator]();
    q.push('a');
    q.push('b');
    q.push('c');
    q.close();
    const out: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await withTimeout(it.next(), 1000, 'drain');
      if (r.done) break;
      out.push((r.value as SDKUserMessage).message.content as string);
    }
    assert.deepEqual(out, ['a', 'b', 'c']);
    const final = await withTimeout(it.next(), 1000, 'drain final');
    assert.equal(final.done, true);
  });

  test('push after close is a no-op (dropped)', async () => {
    const q = new InputQueue();
    const it = q[Symbol.asyncIterator]();
    q.close();
    q.push('ignored');
    const res = await withTimeout(it.next(), 1000, 'post-close push');
    assert.equal(res.done, true);
    assert.equal(res.value, undefined);
  });

  test('double close is idempotent', async () => {
    const q = new InputQueue();
    const it = q[Symbol.asyncIterator]();
    q.close();
    q.close();
    const res = await withTimeout(it.next(), 1000, 'double close');
    assert.equal(res.done, true);
  });

  test('yielded message has exactly the expected four fields', async () => {
    const q = new InputQueue();
    const it = q[Symbol.asyncIterator]();
    q.push('payload');
    q.close();
    const res = await withTimeout(it.next(), 1000, 'shape');
    assert.equal(res.done, false);
    const value = res.value as SDKUserMessage;
    assertUserMsg(value, 'payload');
    assert.deepEqual(Object.keys(value).sort(), ['message', 'parent_tool_use_id', 'session_id', 'type']);
    assert.deepEqual(Object.keys(value.message).sort(), ['content', 'role']);
  });

  test('for-await drains interleaved pushes then exits on close', async () => {
    const q = new InputQueue();
    const collected: string[] = [];
    const consume = (async () => {
      for await (const m of q) collected.push(m.message.content as string);
    })();
    await flush();
    q.push('one');
    await flush();
    q.push('two');
    await flush();
    q.close();
    await withTimeout(consume, 1000, 'for-await consume');
    assert.deepEqual(collected, ['one', 'two']);
  });
});
