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
  read(): Promise<T> {
    if (this.error) return Promise.reject(this.error);
    if (this.latest) { const { value } = this.latest; this.latest = undefined; return Promise.resolve(value); }
    if (this.waiting) return Promise.reject(new Error('A frame is already in flight.'));
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
  close(error = new Error('Screen stream closed.')) {
    this.error = error; this.latest = undefined;
    this.waiting?.reject(error); this.waiting = undefined;
  }
}
