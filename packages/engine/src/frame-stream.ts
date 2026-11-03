export interface StreamFrame {
  bytes: Uint8Array;
  width: number;
  height: number;
  captureMs: number;
  encodeMs: number;
  streaming: boolean;
}

/** Parse arbitrary TLS chunk boundaries without ever buffering an unbounded frame. */
export async function* decodeFrameStream(source: AsyncIterable<Buffer>): AsyncGenerator<StreamFrame> {
  const iterator = source[Symbol.asyncIterator]();
  let chunk: Buffer = Buffer.alloc(0), offset = 0;
  async function read(size: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      if (offset === chunk.length) {
        const next = await iterator.next();
        if (next.done) throw new Error('The host stopped the screen stream.');
        chunk = next.value; offset = 0;
      }
      const count = Math.min(size - written, chunk.length - offset);
      chunk.copy(result, written, offset, offset + count); offset += count; written += count;
    }
    return result;
  }
  try {
    while (true) {
      const header = await read(20);
      const size = header.readUInt32BE(0), width = header.readUInt32BE(4), height = header.readUInt32BE(8);
      if (size < 4 || size > 16 * 1024 * 1024 || width < 1 || width > 3840 || height < 1 || height > 16384 || width * height > 40000000) throw new Error('Invalid screen stream frame.');
      const bytes = await read(size);
      if (bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(size - 2) !== 0xffd9) throw new Error('Invalid screen stream JPEG.');
      yield { bytes, width, height, captureMs: header.readUInt32BE(12) / 1000, encodeMs: header.readUInt32BE(16) / 1000, streaming: true };
    }
  } finally { await iterator.return?.(); }
}
