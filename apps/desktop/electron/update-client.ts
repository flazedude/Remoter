import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import config from '../../../updates/config.json';
import type { UpdateState } from '../src/types.js';

export interface ReleaseManifest {
  schemaVersion: 1; application: 'Remoter'; channel: 'alpha'; version: string;
  sourceCommit: string; publishedAt: string; notes: string;
  installer: { name: string; size: number; sha256: string };
}
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-alpha\.(0|[1-9]\d{0,8}))?$/;
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => { const m = versionPattern.exec(v); if (!m) throw new Error('Unsupported release version.'); return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])]; };
  const aa = parse(a), bb = parse(b);
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
export function verifyManifest(bytes: Uint8Array, publicKey = config.publicKey): ReleaseManifest {
  if (bytes.byteLength > 128 * 1024) throw new Error('Update feed is too large.');
  const envelope = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Unsigned update feed.');
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!verify(null, payload, createPublicKey({ key: Buffer.from(publicKey, 'base64'), type: 'spki', format: 'der' }), Buffer.from(envelope.signature, 'base64'))) throw new Error('Invalid update signature.');
  const m = JSON.parse(payload.toString('utf8')) as ReleaseManifest;
  if (m.schemaVersion !== 1 || m.application !== 'Remoter' || m.channel !== config.channel || !versionPattern.test(m.version) ||
    !/^[a-f0-9]{40}$/.test(m.sourceCommit) || typeof m.notes !== 'string' || m.notes.length > 16000 || !Number.isFinite(Date.parse(m.publishedAt)) ||
    m.installer?.name !== `Remoter-Setup-${m.version}-x64.exe` || !Number.isSafeInteger(m.installer.size) || m.installer.size < 1 || m.installer.size > 1024 ** 3 || !/^[a-f0-9]{64}$/.test(m.installer.sha256)) throw new Error('Unsupported update manifest.');
  return m;
}
function isPrivate(host: string): boolean {
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
}
function allowedURL(url: URL, origin: URL): boolean {
  if (url.username || url.password || url.hash) return false;
  if (origin.protocol === 'http:') return isPrivate(origin.hostname) && url.origin === origin.origin && url.pathname.startsWith('/remoter/');
  return url.protocol === 'https:' && ['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname);
}
async function request(url: string, signal: AbortSignal): Promise<Response> {
  const origin = new URL(url);
  let target = origin;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!allowedURL(target, origin)) throw new Error('Untrusted update download address.');
    const response = await fetch(target, { redirect: 'manual', signal, headers: { 'User-Agent': 'Remoter-Updates', 'Cache-Control': 'no-cache' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('Invalid update redirect.'); target = new URL(location, target); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Update server returned HTTP ${response.status}.`); }
    return response;
  }
  throw new Error('Too many update redirects.');
}
async function readBounded(url: string, max: number, signal?: AbortSignal): Promise<Buffer> {
  const response = await request(url, signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000));
  const chunks: Buffer[] = []; let size = 0;
  if (!response.body) throw new Error('Empty update response.');
  for await (const part of responseChunks(response)) { size += part.length; if (size > max) throw new Error('Update metadata exceeds the size limit.'); chunks.push(Buffer.from(part)); }
  return Buffer.concat(chunks);
}
async function* responseChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) throw new Error('Empty update response.');
  const reader = response.body.getReader();
  try { while (true) { const result = await reader.read(); if (result.done) return; yield result.value; } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
interface Candidate { manifest: ReleaseManifest; url: string; source: string }
export function selectRelease(candidates: Candidate[], currentVersion: string): Candidate[] {
  const sorted = candidates.filter(c => compareVersions(c.manifest.version, currentVersion) > 0).sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
  if (!sorted.length) return [];
  const newest = sorted.filter(c => c.manifest.version === sorted[0].manifest.version);
  if (newest.some(c => c.manifest.installer.sha256 !== newest[0].manifest.installer.sha256 || c.manifest.installer.size !== newest[0].manifest.installer.size || c.manifest.sourceCommit !== newest[0].manifest.sourceCommit)) throw new Error('Conflicting signed releases use the same version.');
  return newest; // Stable sort retains LAN-first preference only for identical releases.
}
export async function verifyInstaller(filename: string, manifest: ReleaseManifest): Promise<void> {
  const info = await stat(filename);
  if (info.size !== manifest.installer.size) throw new Error('Update installer size does not match its signature.');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk);
  if (hash.digest('hex') !== manifest.installer.sha256) throw new Error('Update installer hash does not match its signature.');
}
export class UpdateManager {
  private state: UpdateState;
  private job?: Promise<UpdateState>;
  private prepared?: { manifest: ReleaseManifest; filename: string };
  private proxyEnabled = false;
  private operationAbort?: AbortController;
  constructor(private options: { currentVersion: string; cacheDirectory: string; enabled: boolean; publicKey?: string; feeds?: string[]; github?: boolean }) {
    this.state = { phase: options.enabled ? 'idle' : 'unsupported', currentVersion: options.currentVersion, message: options.enabled ? 'Checks Jack PC, GPD PC, and GitHub.' : 'Updates are available in the Windows desktop release.' };
  }
  snapshot(): UpdateState { return { ...this.state }; }
  setProxyEnabled(enabled: boolean): void {
    this.proxyEnabled = enabled;
    if (enabled) {
      this.operationAbort?.abort();
      this.state = { currentVersion: this.options.currentVersion, phase: 'unsupported', message: 'Updates are paused while SOCKS5 is enabled. Disable it to check LAN and GitHub directly.' };
    } else if (this.state.phase === 'unsupported' && this.options.enabled) {
      this.state = { currentVersion: this.options.currentVersion, phase: 'idle', message: 'Checks Jack PC, GPD PC, and GitHub.' };
    }
  }
  check(): Promise<UpdateState> {
    if (!this.options.enabled || this.proxyEnabled) return Promise.resolve(this.snapshot());
    if (this.job) return this.job;
    this.operationAbort = new AbortController();
    this.job = this.run(this.operationAbort.signal).catch(error => { if (!this.proxyEnabled) this.state = { ...this.state, phase: 'error', message: error instanceof Error ? error.message : 'Update failed.' }; return this.snapshot(); }).finally(() => { this.job = undefined; });
    return this.job;
  }
  private async run(signal: AbortSignal): Promise<UpdateState> {
    this.state = { currentVersion: this.options.currentVersion, phase: 'checking', message: 'Checking LAN hosts and GitHub…' };
    const feeds = (this.options.feeds ?? config.lanFeeds).map((url, i) => ({ url, source: i === 0 ? 'Jack PC (LAN)' : 'GPD PC (LAN)' }));
    const results = await Promise.allSettled([
      ...feeds.map(async feed => {
        const manifest = verifyManifest(await readBounded(feed.url, 128 * 1024, signal), this.options.publicKey);
        return { manifest, url: new URL(manifest.installer.name, feed.url).href, source: feed.source };
      }),
      ...(this.options.github === false ? [] : [(async () => {
        // /latest excludes prereleases. This app explicitly follows the signed alpha channel.
        const releases: unknown = JSON.parse((await readBounded(`https://api.github.com/repos/${config.repository}/releases?per_page=30`, 2 * 1024 * 1024, signal)).toString('utf8'));
        if (!Array.isArray(releases)) throw new Error('Invalid GitHub release list.');
        const release = releases.filter(r => !r.draft && typeof r.tag_name === 'string' && versionPattern.test(r.tag_name.slice(1)) && r.tag_name.startsWith('v') && Array.isArray(r.assets) && r.assets.some((a: { name: string }) => a.name === 'latest.json'))
          .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
        if (!release) throw new Error('No GitHub update release is available yet.');
        const base = `https://github.com/${config.repository}/releases/download/${release.tag_name}/`;
        const manifest = verifyManifest(await readBounded(base + 'latest.json', 128 * 1024, signal), this.options.publicKey);
        if (`v${manifest.version}` !== release.tag_name) throw new Error('GitHub release tag and signed version differ.');
        return { manifest, url: base + manifest.installer.name, source: 'GitHub' };
      })()])
    ]);
    signal.throwIfAborted();
    const candidates = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const failures = results.filter(r => r.status === 'rejected').length;
    if (!candidates.length) throw new Error('No trusted update feed could be reached. Check the network and try again.');
    const selected = selectRelease(candidates, this.options.currentVersion);
    if (!selected.length) { this.state = { currentVersion: this.options.currentVersion, phase: 'current', message: failures ? `Up to date on reachable feeds. ${failures} source(s) unavailable; try again later.` : 'Remoter is up to date.', checkedAt: new Date().toISOString() }; return this.snapshot(); }
    const manifest = selected[0].manifest;
    this.state = { ...this.state, availableVersion: manifest.version, notes: manifest.notes, checkedAt: new Date().toISOString(), phase: 'downloading', progress: 0, message: 'Downloading a signed update…' };
    await mkdir(this.options.cacheDirectory, { recursive: true });
    const filename = path.join(this.options.cacheDirectory, manifest.installer.name);
    try { await verifyInstaller(filename, manifest); }
    catch {
      let downloaded = false;
      for (const candidate of selected) {
        const temporary = `${filename}.partial`;
        this.state = { ...this.state, source: candidate.source, progress: 0 };
        try {
          const response = await request(candidate.url, AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]));
          if (!response.body) throw new Error('Empty update download.');
          const output = await open(temporary, 'w', 0o600);
          let size = 0;
          try {
            for await (const chunk of responseChunks(response)) {
              size += chunk.length; if (size > manifest.installer.size) throw new Error('Installer exceeds its signed size.');
              await output.writeFile(chunk); this.state.progress = Math.round(size * 100 / manifest.installer.size);
            }
          } finally { await output.close(); }
          await verifyInstaller(temporary, manifest);
          await rename(temporary, filename); downloaded = true; break;
        } catch { await rm(temporary, { force: true }); signal.throwIfAborted(); }
      }
      if (!downloaded) throw new Error('The update could not be downloaded and verified from any matching source.');
    }
    signal.throwIfAborted();
    this.prepared = { filename, manifest };
    this.state = { ...this.state, phase: 'ready', progress: 100, message: 'Verified update ready. Install when you are ready to close Remoter.' };
    return this.snapshot();
  }
  async installer(): Promise<string> {
    if (this.state.phase !== 'ready' || !this.prepared) throw new Error('Download and verify an update first.');
    // Recheck immediately before launching, including cached downloads.
    await verifyInstaller(this.prepared.filename, this.prepared.manifest);
    return this.prepared.filename;
  }
}
