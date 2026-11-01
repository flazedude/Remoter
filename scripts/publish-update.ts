import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile, open, rm } from 'node:fs/promises';
import path from 'node:path';
import pkg from '../package.json';
import config from '../updates/config.json';
import { verifyManifest, type ReleaseManifest } from '../apps/desktop/electron/update-client.js';

const repository = 'flazedude/Remoter';
const version = pkg.version;
const tag = `v${version}`;
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const lock = await open('release/.publish.lock', 'wx');
try {
  if (git('remote', 'get-url', 'origin') !== `https://github.com/${repository}.git`) throw new Error('Unexpected release repository.');
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Review and commit all intended source changes before publishing.');
  const commit = git('rev-parse', 'HEAD');
  if (git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0] !== commit) throw new Error('Push the reviewed release source to GitHub main before publishing.');
  const privateKey = await readFile(path.join(process.env.LOCALAPPDATA ?? '', 'RemoterPublisher', 'release-private.pem'));
  if (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64') !== config.publicKey) throw new Error('The release signing identity does not match the client.');
  const setupName = `Remoter-Setup-${version}-x64.exe`;
  const names = [setupName, `Remoter-Portable-${version}-x64.exe`, `Remoter-LAN-Host-Setup-${version}.zip`];
  const files = await Promise.all(names.map(async name => ({ name, bytes: await readFile(path.join('release', name)) })));
  const notes = await readFile(`docs/releases/${version}.md`, 'utf8');
  const manifest: ReleaseManifest = { schemaVersion: 1, application: 'Remoter', channel: 'alpha', version,
    sourceCommit: commit, publishedAt: new Date().toISOString(), notes,
    installer: { name: setupName, size: files[0].bytes.length, sha256: createHash('sha256').update(files[0].bytes).digest('hex') } };
  const payload = Buffer.from(JSON.stringify(manifest));
  let feed = Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }) + '\n');
  try {
    const priorFeed = await readFile('release/latest.json');
    const prior = verifyManifest(priorFeed);
    if (prior.version === version) {
      if (prior.sourceCommit !== commit || prior.installer.sha256 !== manifest.installer.sha256 || prior.installer.size !== manifest.installer.size || prior.notes !== notes) throw new Error('This local release version already identifies different content. Use a higher version.');
      feed = priorFeed;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  verifyManifest(feed);
  await writeFile('release/latest.json', feed);
  files.push({ name: 'latest.json', bytes: feed });
  const sums = Buffer.from(files.map(f => `${createHash('sha256').update(f.bytes).digest('hex')}  ${f.name}`).join('\n') + '\n');
  await writeFile('release/SHA256SUMS.txt', sums); files.push({ name: 'SHA256SUMS.txt', bytes: sums });
  // Credentials are obtained through the existing Git credential manager, never logged or saved.
  const credential = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const token = credential.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9);
  if (!token) throw new Error('No existing GitHub publishing credential is available.');
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'Remoter-Publisher', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function api(route: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await fetch(`https://api.github.com/repos/${repository}${route}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${route} failed (HTTP ${response.status}). Credentials were not logged.`);
    return response.status === 204 ? null : response.json();
  }
  const existing = await api('/releases?per_page=100');
  let release = existing?.find((r: any) => r.tag_name === tag);
  if (release && (!release.draft || release.target_commitish !== commit)) throw new Error('This version is already published or belongs to another source commit. Use a higher version.');
  const ref = await api(`/git/ref/tags/${tag}`);
  if (ref && (ref.object.type !== 'commit' || ref.object.sha !== commit)) throw new Error('The release tag already identifies another commit.');
  if (!ref) await api('/git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: commit });
  if (!release) release = await api('/releases', 'POST', { tag_name: tag, target_commitish: commit, name: `Remoter ${version}`, body: notes, draft: true, prerelease: true });
  for (const file of files) {
    const hash = createHash('sha256').update(file.bytes).digest('hex');
    let asset = release.assets.find((a: any) => a.name === file.name);
    if (asset && (asset.size !== file.bytes.length || asset.digest !== `sha256:${hash}`)) throw new Error(`Existing draft asset differs: ${file.name}. It was preserved.`);
    if (!asset) {
      console.log(`Uploading ${file.name} (${file.bytes.length} bytes)…`);
      const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: file.bytes, signal: AbortSignal.timeout(15 * 60 * 1000) });
      if (!response.ok) throw new Error(`Asset upload failed (HTTP ${response.status}); the release remains a draft.`);
      asset = await response.json();
    }
    if (asset.size !== file.bytes.length || asset.digest !== `sha256:${hash}`) throw new Error(`GitHub asset verification failed: ${file.name}.`);
  }
  if (git('status', '--porcelain', '--untracked-files=all') || git('rev-parse', 'HEAD') !== commit || git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0] !== commit) throw new Error('Release source changed during upload. The release remains a draft.');
  const published = await api(`/releases/${release.id}`, 'PATCH', { draft: false, prerelease: true });
  console.log(`Published verified Remoter release: ${published.html_url}`);
} finally { await lock.close(); await rm('release/.publish.lock', { force: true }); }
