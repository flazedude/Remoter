import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import type { Invitation, RelaySettings, RouteSettings } from './types.js';

export function certificateFingerprint(certificate: string): string {
  return new X509Certificate(certificate).fingerprint256;
}

export function endpointURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a valid HTTPS endpoint.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.search || !['', '/'].includes(url.pathname)) {
    throw new Error('The host endpoint must be an HTTPS origin without credentials, a path, or query.');
  }
  return url;
}

export function relayURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a valid WSS relay URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) || url.username || url.password || url.hash || url.search || !['', '/', '/v1/tunnel'].includes(url.pathname)) {
    throw new Error('Relay connections require WSS; plain WS is allowed only on loopback for development.');
  }
  url.pathname = '/v1/tunnel';
  return url;
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function token(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_\-]{32,256}$/.test(value); }
export function validateRelay(value: unknown): RelaySettings {
  if (!object(value) || typeof value.url !== 'string' || typeof value.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.deviceId) || !token(value.token)) {
    throw new Error('Relay settings require a URL, device ID, and a valid access token.');
  }
  relayURL(value.url);
  return { url: value.url, deviceId: value.deviceId, token: value.token };
}

export function validateInvitation(value: unknown): Invitation {
  if (!object(value) || value.version !== 1 || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 120 || /[\x00-\x1f\x7f]/.test(value.name) || typeof value.endpoint !== 'string' || typeof value.certificate !== 'string' || value.certificate.length > 16384 || !token(value.token)) {
    throw new Error('Invalid Remoter invitation. Ask the host for a fresh invitation.');
  }
  endpointURL(value.endpoint);
  let certificate: X509Certificate;
  try { certificate = new X509Certificate(value.certificate); } catch { throw new Error('The invitation contains an invalid host certificate.'); }
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo)) throw new Error('The host certificate is not currently valid. Ask the host for a fresh invitation.');
  if (certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)) throw new Error('The invitation must contain the host’s self-signed identity certificate.');
  return { version: 1, name: value.name, endpoint: endpointURL(value.endpoint).origin, certificate: value.certificate, token: value.token, ...(value.relay ? { relay: validateRelay(value.relay) } : {}) };
}

export function parseInvitation(text: string): Invitation {
  if (typeof text !== 'string' || text.length > 32768) throw new Error('The invitation is too large.');
  const encoded = text.trim().replace(/^remoter:\/\/pair\//, '').replace(/^remoter:\/\//, '');
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Paste the complete Remoter invitation code.');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new Error('The invitation could not be decoded.'); }
  return validateInvitation(value);
}

export function validateRoute(route: RouteSettings): RouteSettings {
  if (!object(route) || !['direct', 'tailscale', 'relay'].includes(route.mode)) throw new Error('Choose a supported connection route.');
  const result: RouteSettings = { mode: route.mode };
  if (route.endpoint) result.endpoint = endpointURL(route.endpoint).origin;
  if (route.relay) result.relay = validateRelay(route.relay);
  if (route.proxy) {
    const p = route.proxy;
    if (!object(p) || typeof p.host !== 'string' || p.host.length < 1 || p.host.length > 253 || /[\s/@?#]/.test(p.host) || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535 || (p.username !== undefined && (typeof p.username !== 'string' || Buffer.byteLength(p.username) > 255)) || (p.password !== undefined && (typeof p.password !== 'string' || Buffer.byteLength(p.password) > 255))) {
      throw new Error('Check the SOCKS5 host, port, and credentials.');
    }
    result.proxy = { host: p.host, port: p.port, username: p.username, password: p.password };
  }
  return result;
}

export function validateTailscaleEndpoint(endpoint: URL): void {
  const host = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const parts = host.split('.').map(Number);
  const ipv4 = isIP(host) === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  const ipv6 = isIP(host) === 6 && host.startsWith('fd7a:115c:a1e0:');
  const magicDNS = host.endsWith('.ts.net');
  if (!ipv4 && !ipv6 && !magicDNS) throw new Error('Tailscale mode requires a tailnet IP or full MagicDNS .ts.net name. Ask the host to advertise its Tailscale endpoint.');
}
