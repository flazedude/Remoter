import type { RemoteInput } from '../src/types.js';
interface Pending { event: RemoteInput; resolve: () => void; reject: (error: Error) => void }
/** One in-flight input request; coalesce pointer motion and discard stale input on release. */
export class InputQueue {
  private pending: Pending[] = [];
  private running = false;
  private scheduled = false;
  private closed = false;
  constructor(private readonly deliver: (event: RemoteInput) => Promise<void>, private readonly deliverBatch?: (events: RemoteInput[]) => Promise<void>) {}
  send(event: RemoteInput): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The session is closed.'));
    if (event.type === 'releaseAll') this.clear();
    if (event.type === 'move' && this.pending.at(-1)?.event.type === 'move') this.pending.pop()!.resolve();
    if (this.pending.length >= 256) return Promise.reject(new Error('Remote input is catching up.'));
    return new Promise((resolve, reject) => {
      this.pending.push({ event, resolve, reject });
      if (this.deliverBatch) {
        if (!this.scheduled) { this.scheduled = true; setTimeout(() => { this.scheduled = false; void this.drain(); }, 2); }
      } else void this.drain();
    });
  }
  private clear() { for (const item of this.pending.splice(0)) item.resolve(); }
  close() { this.closed = true; this.clear(); }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length && !this.closed) {
        const batch = this.pending.splice(0, this.deliverBatch ? 32 : 1);
        try {
          if (this.deliverBatch) await this.deliverBatch(batch.map(item => item.event));
          else await this.deliver(batch[0].event);
          batch.forEach(item => item.resolve());
        } catch (error) {
          batch.forEach(item => item.reject(error instanceof Error ? error : new Error('Remote input failed.'))); this.clear();
        }
      }
    } finally { this.running = false; }
  }
}
