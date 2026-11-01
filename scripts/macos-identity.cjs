const { createHash } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Stock Electron executables share LC_UUID across unrelated apps. macOS uses
// this UUID for Local Network privacy (Apple TN3178/TN3179). Change only the
// packaged main executable, before publisher signing, never the cached runtime.
function rewriteMainUUID(binary, identity) {
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Expected a thin 64-bit Mac executable. Build each architecture separately.');
  const count = binary.readUInt32LE(16), end = 32 + binary.readUInt32LE(20);
  if (end > binary.length) throw new Error('Invalid Mach-O load commands.');
  let offset = 32, uuidOffset;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > end) throw new Error('Truncated Mach-O load command.');
    const command = binary.readUInt32LE(offset), size = binary.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) throw new Error('Invalid Mach-O load command size.');
    if (command === 0x1b) {
      if (size !== 24 || uuidOffset !== undefined) throw new Error('Invalid or duplicate LC_UUID.');
      uuidOffset = offset + 8;
    }
    offset += size;
  }
  if (offset !== end || uuidOffset === undefined) throw new Error('Missing LC_UUID or invalid Mach-O command table.');
  const uuid = createHash('sha256').update(identity).digest().subarray(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x80; // Application-defined UUIDv8.
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  const output = Buffer.from(binary);
  uuid.copy(output, uuidOffset);
  return output;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const info = context.packager.appInfo;
  const app = path.join(context.appOutDir, `${info.productFilename}.app`);
  const binary = path.join(app, 'Contents', 'MacOS', info.productFilename);
  const payload = await readFile(path.join(app, 'Contents', 'Resources', 'app.asar'));
  const identity = `${info.id}:${info.version}:${context.arch}:${createHash('sha256').update(payload).digest('hex')}`;
  await writeFile(binary, rewriteMainUUID(await readFile(binary), identity));
  // Patching invalidates Electron's inherited signature. Restore an ad-hoc
  // executable signature for local builds; builder's configured signing follows.
  execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' });
};
module.exports.rewriteMainUUID = rewriteMainUUID;
