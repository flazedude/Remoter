import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrameStream } from '../packages/engine/src/frame-stream.js';
import { FrameReceiver } from '../apps/desktop/electron/frame-receiver.js';

function frame(size = 4) {
  const header = Buffer.alloc(20);
  [size, 1920, 1080, 1200, 5000].forEach((n, i) => header.writeUInt32BE(n, i * 4));
  return Buffer.concat([header, Buffer.from([0xff, 0xd8, 0xff, 0xd9])]);
}
async function* fragments(bytes: Buffer) { for (const byte of bytes) yield Buffer.from([byte]); }
test('binary stream handles fragmented headers and payloads and preserves measurements', async () => {
  const iterator = decodeFrameStream(fragments(Buffer.concat([frame(), frame()])));
  for (let i = 0; i < 2; i++) {
    const { value } = await iterator.next();
    assert.equal(value!.width, 1920); assert.equal(value!.height, 1080);
    assert.equal(value!.captureMs, 1.2); assert.equal(value!.encodeMs, 5);
    assert.equal(value!.bytes.length, 4);
  }
  await assert.rejects(iterator.next(), /stopped/);
});
test('stream rejects oversized lengths before allocating or waiting for pixels', async () => {
  const iterator = decodeFrameStream(fragments(frame(16 * 1024 * 1024 + 1)));
  await assert.rejects(iterator.next(), /Invalid screen stream frame/);
});
test('stream rejects truncated and invalid JPEG data', async () => {
  await assert.rejects(decodeFrameStream(fragments(frame().subarray(0, 22))).next(), /stopped/);
  const invalid = frame(); invalid[23] = 0;
  await assert.rejects(decodeFrameStream(fragments(invalid)).next(), /Invalid screen stream JPEG/);
});
test('slow renderer gets only latest frame, and close rejects a pending delivery', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sent!: () => void;
  const delivered = new Promise<void>(resolve => { sent = resolve; });
  async function* source() { for (let i = 0; i < 100; i++) yield i; sent(); await gate; }
  const receiver = new FrameReceiver(source());
  await delivered;
  assert.equal(await receiver.read(), 99);
  const pending = receiver.read();
  receiver.close();
  await assert.rejects(pending, /closed/);
  release();
});
