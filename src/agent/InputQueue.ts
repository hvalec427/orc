import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * A push-able async iterable of SDKUserMessages, passed as the `prompt` to query().
 * The session stays alive as long as this iterator has not finished; pushing a message
 * delivers the human's reply into the same session, closing ends it.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  /** Enqueue a user message (the text becomes a user turn). */
  push(text: string): void {
    if (this.closed) return;
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      // session_id is assigned by the SDK for streaming input; a placeholder satisfies the type.
      session_id: '',
    };
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  /** End the stream; the underlying session finishes after the current turn. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
