import dgram from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { EngineClient } from './client.js';
import { validateInvitation } from './invitation.js';
import type { Invitation, LANHost } from './types.js';

const GROUP = '239.255.77.82';
const PORT = 45781;

export function parseLANHost(bytes: Buffer, nonce: string, source: string): LANHost | undefined {
  if (bytes.length > 24000) return;
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.service !== 'remoter-host-v1' || value.nonce !== nonce || typeof value.easy !== 'boolean') return;
    const invitation = validateInvitation({ version: 1, name: value.name, endpoint: value.endpoint, certificate: value.certificate, token: '0'.repeat(32) });
    const endpoint = new URL(invitation.endpoint);
    // Never follow a discovery advertisement to a different host or DNS name.
    if (endpoint.hostname !== source) return;
    return { id: createHash('sha256').update(invitation.certificate).digest('hex').slice(0, 32), name: invitation.name, endpoint: invitation.endpoint, certificate: invitation.certificate, easy: value.easy };
  } catch { return; }
}

export function discoverLAN(duration = 2200, port = PORT): Promise<LANHost[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error('Invalid discovery port.'));
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(16).toString('hex');
    const hosts = new Map<string, LANHost>();
    const sockets = new Set<dgram.Socket>();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const interfaces = Object.values(networkInterfaces()).flat().filter(iface => iface && iface.family === 'IPv4' && !iface.internal).slice(0, 32);
    let lastError: Error | undefined;
    const message = Buffer.from(JSON.stringify({ service: 'remoter-discover-v1', nonce }));
    // A socket per adapter prevents asynchronous sends from inheriting the last
    // selected multicast interface on Windows machines with virtual adapters.
    for (const iface of interfaces) {
      if (!iface) continue;
      const socket = dgram.createSocket('udp4');
      sockets.add(socket);
      socket.on('error', error => { lastError = error; sockets.delete(socket); socket.close(); });
      socket.on('message', (bytes, peer) => { const host = parseLANHost(bytes, nonce, peer.address); if (host && hosts.size < 100) hosts.set(host.id, host); });
      const send = () => {
        if (!sockets.has(socket)) return;
        const parts = iface.address.split('.').map(Number), mask = iface.netmask.split('.').map(Number);
        const broadcast = parts.map((part, i) => part | (~mask[i] & 255)).join('.');
        socket.send(message, port, GROUP, () => {});
        socket.send(message, port, broadcast, () => {});
      };
      socket.bind(0, iface.address, () => {
        try { socket.setBroadcast(true); socket.setMulticastTTL(1); socket.setMulticastInterface(iface.address); send(); timers.push(setTimeout(send, 700)); }
        catch (error) { lastError = error as Error; sockets.delete(socket); socket.close(); }
      });
    }
    setTimeout(() => {
      for (const timer of timers) clearTimeout(timer);
      const failed = interfaces.length > 0 && sockets.size === 0 && lastError;
      for (const socket of sockets) socket.close(); sockets.clear();
      if (failed) reject(new Error(`LAN discovery failed: ${lastError!.message}`));
      else resolve([...hosts.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }, duration);
  });
}

export async function pairLANHost(host: Pick<LANHost, 'name' | 'endpoint' | 'certificate'>): Promise<Invitation> {
  const client = new EngineClient({ version: 1, ...host, token: '0'.repeat(32) });
  try { return await client.pairLAN(); } finally { client.close(); }
}
