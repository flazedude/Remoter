import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { compareVersions, selectRelease, UpdateManager, verifyInstaller, verifyManifest, type ReleaseManifest } from '../electron/update-client.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const installer = Buffer.from('Synthetic installer for verification tests. Never executable.');
function manifest(version = '0.1.0-alpha.2'): ReleaseManifest {
  return { schemaVersion: 1, application: 'Remoter', channel: 'alpha', version, sourceCommit: 'a'.repeat(40), publishedAt: new Date().toISOString(), notes: 'Test release', installer: { name: `Remoter-Setup-${version}-x64.exe`, size: installer.length, sha256: createHash('sha256').update(installer).digest('hex') } };
}
function envelope(m: ReleaseManifest): Buffer { const payload = Buffer.from(JSON.stringify(m)); return Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') })); }

test('signed feeds reject tampering, other identities, invalid paths, channels, and excessive sizes', () => {
  const m = manifest(); assert.equal(verifyManifest(envelope(m), publicKey).version, m.version);
  const bad = JSON.parse(envelope(m).toString()); bad.payload = Buffer.from(JSON.stringify({ ...m, version: '99.0.0' })).toString('base64');
  assert.throws(() => verifyManifest(Buffer.from(JSON.stringify(bad)), publicKey), /signature/);
  assert.throws(() => verifyManifest(envelope(m), generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')), /signature/);
  for (const invalid of [{ ...m, channel: 'stable' }, { ...m, application: 'Other' }, { ...m, installer: { ...m.installer, name: '../setup.exe' } }, { ...m, installer: { ...m.installer, size: 2 ** 40 } }]) assert.throws(() => verifyManifest(envelope(invalid as ReleaseManifest), publicKey));
});
test('newest signed release wins; LAN is preferred only for matching immutable releases', () => {
  assert.equal(compareVersions('0.1.0-alpha.10', '0.1.0-alpha.2'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0-alpha.99'), 1);
  const candidate = (version: string, source: string) => ({ manifest: manifest(version), source, url: 'unused' });
  const candidates = [candidate('0.1.0-alpha.2', 'stale LAN'), candidate('0.1.0-alpha.3', 'LAN'), candidate('0.1.0-alpha.3', 'GitHub')];
  assert.deepEqual(selectRelease(candidates, '0.1.0-alpha.1').map(c => c.source), ['LAN', 'GitHub']);
  assert.deepEqual(selectRelease(candidates, '0.1.0-alpha.3'), []);
  candidates[2].manifest.installer.sha256 = '0'.repeat(64);
  assert.throws(() => selectRelease(candidates, '0.1.0-alpha.1'), /Conflicting/);
});
test('downloads fall back between matching mirrors, verify cache again before install, and reject redirects away from LAN', async () => {
  const m = manifest();
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('latest.json')) { res.end(envelope(m)); return; }
    if (req.url?.startsWith('/remoter/failed/')) { res.writeHead(503); res.end(); return; }
    if (req.url?.startsWith('/remoter/redirect/')) { res.writeHead(302, { Location: 'https://example.com/setup.exe' }); res.end(); return; }
    res.end(installer);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/remoter/`;
  try {
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'remoter-update-test-'));
    const manager = new UpdateManager({ enabled: true, currentVersion: '0.1.0-alpha.1', cacheDirectory, publicKey, feeds: [base + 'failed/latest.json', base + 'latest.json'], github: false });
    const checking = manager.check(); assert.equal(manager.check(), checking, 'Only one check/download may run');
    assert.equal((await checking).phase, 'ready');
    const filename = await manager.installer(); assert.deepEqual(await readFile(filename), installer);
    await writeFile(filename, Buffer.alloc(installer.length)); await assert.rejects(manager.installer(), /hash/);
    await writeFile(filename, 'short'); await assert.rejects(verifyInstaller(filename, m), /size/);
    const redirected = new UpdateManager({ enabled: true, currentVersion: '0.1.0-alpha.1', cacheDirectory: path.join(cacheDirectory, 'redirect'), publicKey, feeds: [base + 'redirect/latest.json'], github: false });
    assert.equal((await redirected.check()).phase, 'error');
    const blocked = new UpdateManager({ enabled: true, currentVersion: '0.1.0-alpha.1', cacheDirectory, publicKey, feeds: [base + 'latest.json'], github: false });
    blocked.setProxyEnabled(true);
    assert.equal((await blocked.check()).phase, 'unsupported');
    blocked.setProxyEnabled(false);
    assert.equal((await blocked.check()).phase, 'ready');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
