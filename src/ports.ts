import { createServer } from 'node:net';

/** Allocates unique Metro ports for agents, avoiding ports already in use. */
export class PortAllocator {
  private readonly assigned = new Set<number>();

  constructor(private readonly basePort: number) {}

  /** Allocate the next free port at or above basePort that no agent already holds. */
  async allocate(): Promise<number> {
    for (let port = this.basePort; port < this.basePort + 1000; port++) {
      if (this.assigned.has(port)) continue;
      if (await isFree(port)) {
        this.assigned.add(port);
        return port;
      }
    }
    throw new Error(`No free port found in range ${this.basePort}-${this.basePort + 1000}`);
  }

  release(port: number): void {
    this.assigned.delete(port);
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
