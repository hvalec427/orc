import { createServer } from 'node:net';
import type { PortRange } from './types.js';

/**
 * Allocates unique ports for agents within a given inclusive range, avoiding ports
 * already in use or already handed out. One allocator instance owns one range.
 */
export class PortAllocator {
  private readonly assigned = new Set<number>();

  constructor(private readonly range: PortRange) {}

  /** Allocate the next free port within the range that no agent already holds. */
  async allocate(): Promise<number> {
    for (let port = this.range.start; port <= this.range.end; port++) {
      if (this.assigned.has(port)) continue;
      if (await isFree(port)) {
        this.assigned.add(port);
        return port;
      }
    }
    throw new Error(`No free port available in range ${this.range.start}-${this.range.end}`);
  }

  release(port: number): void {
    this.assigned.delete(port);
  }

  /**
   * Mark a specific port as already taken so {@link allocate} won't hand it out again. Used when
   * restoring persisted agents: a reloaded agent keeps its prior port, so we reserve it up front to
   * stop a freshly created agent from colliding with it. Ports outside this allocator's range are
   * ignored (they belong to no allocator).
   */
  reserve(port: number): void {
    if (port < this.range.start || port > this.range.end) return;
    this.assigned.add(port);
  }
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}
