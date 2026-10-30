import type { RemoteInput } from '../src/types.js';
interface Pending { event: RemoteInput; resolve: () => void; reject: (error: Error) => void }
/** One in-flight input request; coalesce pointer motion and discard stale input on release. */
export class InputQueue {
  private pending: Pending[] = [];
  private running = false;
  private closed = false;
  constructor(private readonly deliver: (event: RemoteInput) => Promise<void>) {}
  send(event: RemoteInput): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The session is closed.'));
    if (event.type === 'releaseAll') this.clear();
    if (event.type === 'move' && this.pending.at(-1)?.event.type === 'move') this.pending.pop()!.resolve();
    if (this.pending.length >= 32) return Promise.reject(new Error('Remote input is congested. Pause control and reconnect.'));
    return new Promise((resolve, reject) => {
      this.pending.push({ event, resolve, reject });
      void this.drain();
    });
  }
  private clear() { for (const item of this.pending.splice(0)) item.resolve(); }
  close() { this.closed = true; this.clear(); }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length && !this.closed) {
        const next = this.pending.shift()!;
        try { await this.deliver(next.event); next.resolve(); }
        catch (error) { next.reject(error instanceof Error ? error : new Error('Remote input failed.')); this.clear(); }
      }
    } finally { this.running = false; }
  }
}
