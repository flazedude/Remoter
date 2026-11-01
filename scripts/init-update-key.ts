import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const directory = path.join(process.env.LOCALAPPDATA ?? '', 'RemoterPublisher');
if (!process.env.LOCALAPPDATA) throw new Error('Run signing identity setup on the Windows publishing PC.');
mkdirSync(directory, { recursive: true });
if (process.platform === 'win32') {
  const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[0-9-]+/)?.[0];
  if (!sid) throw new Error('Cannot identify the publisher account.');
  execFileSync('icacls', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { stdio: 'ignore' });
}
const privatePath = path.join(directory, 'release-private.pem');
if (!existsSync(privatePath)) {
  if (existsSync('updates/config.json')) throw new Error('An update identity already exists. Restore its private key; do not replace it.');
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
}
const publicKey = createPublicKey(readFileSync(privatePath)).export({ type: 'spki', format: 'der' }).toString('base64');
if (existsSync('updates/config.json') && JSON.parse(readFileSync('updates/config.json', 'utf8')).publicKey !== publicKey) throw new Error('Publisher key differs from the established client identity.');
mkdirSync('updates', { recursive: true });
writeFileSync('updates/config.json', JSON.stringify({ repository: 'flazedude/Remoter', channel: 'alpha', publicKey,
  lanFeeds: ['http://192.168.2.76:17846/remoter/latest.json', 'http://192.168.2.59:17846/remoter/latest.json'] }, null, 2) + '\n');
console.log('Remoter public update identity configured. The private signing key remains in the protected local publisher folder.');
