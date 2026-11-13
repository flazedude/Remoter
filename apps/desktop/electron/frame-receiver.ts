/** Drain transport at host speed; keep one latest frame when rendering is slower. */
export class FrameReceiver<T> {
  private latest?: { value: T };
  private waiting?: { resolve: (value: T) => void; reject: (error: Error) => void };
  private error?: Error;
  constructor(source: AsyncIterable<T>) { void this.consume(source); }
  private async consume(source: AsyncIterable<T>) {
    try {
      for await (const value of source) {
        if (this.error) break;
        if (this.waiting) { const waiter = this.waiting; this.waiting = undefined; waiter.resolve(value); }
        else this.latest = { value };
      }
      this.close(new Error('The host stopped the screen stream.'));
    } catch (error) { this.close(error instanceof Error ? error : new Error('Screen stream failed.')); }
  }
  read(timeoutMs = 5000): Promise<T> {
    if (this.error) return Promise.reject(this.error);
    if (this.latest) { const { value } = this.latest; this.latest = undefined; return Promise.resolve(value); }
    if (this.waiting) return Promise.reject(new Error('A frame is already in flight.'));
    return new Promise((resolve, reject) => {
      // A socket can stay active without completing a frame. Reject the pending
      // delivery so the caller aborts this transport and opens a fresh stream.
      const timeout = setTimeout(() => this.close(new Error('Screen frame timed out.')), timeoutMs);
      this.waiting = {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); }
      };
    });
  }
  close(error = new Error('Screen stream closed.')) {
    if (this.error) return;
    this.error = error; this.latest = undefined;
    this.waiting?.reject(error); this.waiting = undefined;
  }
}
