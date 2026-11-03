import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { rewriteMainUUID } = createRequire(import.meta.url)('../../../scripts/macos-identity.cjs') as { rewriteMainUUID(binary: Buffer, identity: string): Buffer };

function executable() {
  const result = Buffer.alloc(80, 0x41);
  result.writeUInt32LE(0xfeedfacf, 0);
  result.writeUInt32LE(2, 16);
  result.writeUInt32LE(32, 20);
  result.writeUInt32LE(0x1b, 32); result.writeUInt32LE(24, 36);
  result.writeUInt32LE(0x2a, 56); result.writeUInt32LE(8, 60);
  return result;
}

test('Mac identity changes only LC_UUID, remains stable per build, and separates apps/builds', () => {
  const original = executable(), before = Buffer.from(original);
  const changed = rewriteMainUUID(original, 'remoter:alpha6:arm64:payload');
  assert.deepEqual(original, before);
  assert.deepEqual(changed.subarray(0, 40), before.subarray(0, 40));
  assert.deepEqual(changed.subarray(56), before.subarray(56));
  assert.notDeepEqual(changed.subarray(40, 56), before.subarray(40, 56));
  assert.deepEqual(changed, rewriteMainUUID(original, 'remoter:alpha6:arm64:payload'));
  assert.deepEqual(changed, rewriteMainUUID(changed, 'remoter:alpha6:arm64:payload'));
  assert.notDeepEqual(changed, rewriteMainUUID(original, 'another-app:alpha6:arm64:payload'));
  assert.notDeepEqual(changed, rewriteMainUUID(original, 'remoter:alpha6:arm64:new-payload'));
});

test('Mac identity rejects malformed or unsupported binaries before changing bytes', () => {
  const variants = [Buffer.alloc(0), Buffer.alloc(80), executable().subarray(0, 40)];
  const missing = executable(); missing.writeUInt32LE(0x2b, 32); variants.push(missing);
  const badSize = executable(); badSize.writeUInt32LE(0, 36); variants.push(badSize);
  const duplicate = executable(); duplicate.writeUInt32LE(48, 20); duplicate.writeUInt32LE(0x1b, 56); duplicate.writeUInt32LE(24, 60); variants.push(duplicate);
  for (const binary of variants) assert.throws(() => rewriteMainUUID(binary, 'remoter'));
});
