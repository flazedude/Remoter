import type { NetworkSettings } from './types';

export const qualityProfiles = {
  lan: { quality: 80, width: 1920, fps: 30 },
  original: { quality: 90, width: 3840, fps: 30 },
  balanced: { quality: 70, width: 1600, fps: 30 },
  sharp: { quality: 85, width: 1920, fps: 30 },
  fast: { quality: 50, width: 1280, fps: 15 },
};

export function defaultQuality(endpoint: string, network: Pick<NetworkSettings, 'mode' | 'proxyEnabled'>): keyof typeof qualityProfiles {
  if (network.mode !== 'direct' || network.proxyEnabled) return 'balanced';
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    const octets = host.split('.').map(Number);
    const localV4 = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 169 && octets[1] === 254));
    return localV4 || host === 'localhost' || host.endsWith('.local') || host === '[::1]' || /^\[f[cd][\da-f]{2}:/.test(host) || /^\[fe[89ab][\da-f]:/.test(host) ? 'lan' : 'balanced';
  } catch { return 'balanced'; }
}

export function frameDelay(fps: number, elapsed: number): number {
  return Math.max(1, Math.ceil(1000 / fps) - elapsed);
}

// Adjust only the smooth LAN preset. Use sustained measurements and different
// up/down thresholds so one slow frame cannot make the resolution oscillate.
export class StreamResolution {
  width = 1920;
  private elapsed = 0;
  private frames = 0;
  private recovery = 0;
  sample(milliseconds: number): number {
    this.elapsed += milliseconds;
    if (++this.frames < 30) return this.width;
    const average = this.elapsed / this.frames;
    this.elapsed = 0; this.frames = 0;
    const widths = [960, 1280, 1600, 1920];
    const index = widths.indexOf(this.width);
    if (average > 38) { this.width = widths[Math.max(0, index - 1)]; this.recovery = 0; }
    else if (average < 22 && ++this.recovery >= 5) { this.width = widths[Math.min(widths.length - 1, index + 1)]; this.recovery = 0; }
    else if (average >= 22) this.recovery = 0;
    return this.width;
  }
}
