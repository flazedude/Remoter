import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { SocksClient } from 'socks';
import WebSocket, { createWebSocketStream } from 'ws';
import { endpointURL, relayURL, validateInvitation, validateRelay, validateRoute, validateTailscaleEndpoint } from './invitation.js';
import type { FrameOptions, HostInfo, InputEvent, Invitation, RouteSettings } from './types.js';

const CONNECT_TIMEOUT = 10_000;
const REQUEST_TIMEOUT = 15_000;

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}.`);
  return value;
}

function validateInput(event: InputEvent): void {
  if (!event || typeof event !== 'object') throw new Error('Invalid input event.');
  switch (event.type) {
    case 'move':
      boundedInteger(event.x, 0, 100000, 'pointer position');
      boundedInteger(event.y, 0, 100000, 'pointer position');
      boundedInteger(event.displayId, 0, 100, 'display');
      break;
    case 'button':
      if (!['left', 'right', 'middle'].includes(event.button) || typeof event.down !== 'boolean') throw new Error('Invalid mouse button event.');
      break;
    case 'key':
      if (typeof event.code !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(event.code) || typeof event.down !== 'boolean') throw new Error('Invalid keyboard event.');
      break;
    case 'scroll':
      boundedInteger(event.deltaX, -10000, 10000, 'scroll');
      boundedInteger(event.deltaY, -10000, 10000, 'scroll');
      break;
    case 'releaseAll': break;
    default: throw new Error('Unsupported input event.');
  }
}

/** Node/main-process only. Credentials and session bytes must not be passed into a renderer. */
export class EngineClient {
  readonly invitation: Invitation;
  readonly route: RouteSettings;
  private readonly endpoint: URL;
  private readonly pin: Buffer;
  private readonly agent: https.Agent;
  private readonly sockets = new Set<Duplex>();
  private readonly websockets = new Set<WebSocket>();
  private readonly outerAgents = new Set<http.Agent>();
  private closed = false;

  constructor(invitation: Invitation, route: RouteSettings = { mode: 'direct' }) {
    this.invitation = validateInvitation(invitation);
    this.route = validateRoute(route);
    this.endpoint = endpointURL(this.route.endpoint ?? this.invitation.endpoint);
    if (this.route.mode === 'tailscale') {
      if (this.route.proxy) throw new Error('Tailscale uses its system service. Select direct or relay mode to use a SOCKS5 proxy.');
      validateTailscaleEndpoint(this.endpoint);
    }
    this.pin = createHash('sha256').update(new X509Certificate(this.invitation.certificate).raw).digest();
    if (this.route.mode === 'relay') validateRelay(this.route.relay ?? this.invitation.relay);
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2, maxCachedSessions: 0 });
    this.agent.createConnection = (_options, callback) => {
      void this.openPinnedSocket().then((socket) => callback?.(null, socket), (error: Error) => callback?.(error, undefined as never));
      return undefined as never;
    };
  }

  async info(): Promise<HostInfo> {
    const { body } = await this.request('GET', '/v1/info', undefined, 64 * 1024);
    let value: HostInfo;
    try { value = JSON.parse(body.toString('utf8')) as HostInfo; } catch { throw new Error('The host returned invalid device information.'); }
    if (typeof value?.name !== 'string' || typeof value.os !== 'string' || typeof value.version !== 'string' || typeof value.capabilities?.capture !== 'boolean' || typeof value.capabilities?.input !== 'boolean' || !Array.isArray(value.displays) || value.displays.length > 100 || value.displays.some(d => !Number.isInteger(d.id) || typeof d.name !== 'string' || !Number.isInteger(d.width) || !Number.isInteger(d.height) || d.width < 1 || d.height < 1 || !Number.isInteger(d.x) || !Number.isInteger(d.y))) {
      throw new Error('The host returned invalid device information.');
    }
    return value;
  }

  async frame(options: FrameOptions = {}): Promise<Buffer> {
    const query = new URLSearchParams({
      display: String(boundedInteger(options.display ?? 0, 0, 100, 'display')),
      quality: String(boundedInteger(options.quality ?? 65, 20, 90, 'JPEG quality')),
      width: String(boundedInteger(options.width ?? 1280, 320, 3840, 'frame width')),
    });
    const { body, contentType } = await this.request('GET', `/v1/frame?${query}`, undefined, 16 * 1024 * 1024);
    if (!contentType?.startsWith('image/jpeg') || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) throw new Error('The host returned an invalid frame.');
    return body;
  }

  async input(event: InputEvent): Promise<void> {
    validateInput(event);
    await this.request('POST', '/v1/input', Buffer.from(JSON.stringify(event)), 4096);
  }

  close(): void {
    this.closed = true;
    this.agent.destroy();
    for (const agent of this.outerAgents) agent.destroy();
    for (const socket of this.sockets) socket.destroy();
    for (const websocket of this.websockets) websocket.terminate();
    this.sockets.clear();
    this.outerAgents.clear();
    this.websockets.clear();
  }

  private track<T extends Duplex>(socket: T): T {
    if (this.closed) { socket.destroy(); throw new Error('The session is closed.'); }
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    return socket;
  }

  private async dial(host: string, port: number): Promise<net.Socket> {
    if (this.closed) throw new Error('The session is closed.');
    if (this.route.proxy) {
      const proxy = this.route.proxy;
      try {
        const { socket } = await SocksClient.createConnection({
          proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username, password: proxy.password },
          command: 'connect',
          // Pass the hostname untouched: SOCKS5 resolves the destination remotely.
          destination: { host, port },
          timeout: CONNECT_TIMEOUT,
        });
        socket.setNoDelay(true);
        return this.track(socket);
      } catch { throw new Error('SOCKS5 connection failed. Check the proxy and credentials. Direct fallback is disabled.'); }
    }
    return new Promise((resolve, reject) => {
      const socket = this.track(net.createConnection({ host, port }));
      const timer = setTimeout(() => socket.destroy(new Error('Connection timed out.')), CONNECT_TIMEOUT);
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => { clearTimeout(timer); socket.setNoDelay(true); resolve(socket); });
    });
  }

  private secureSocket(socket: Duplex, host: string, pinned: boolean): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const secure = this.track(tls.connect({
        socket,
        host,
        servername: net.isIP(host) ? undefined : host,
        minVersion: pinned ? 'TLSv1.3' : 'TLSv1.2',
        rejectUnauthorized: true,
        ...(pinned ? {
          ca: this.invitation.certificate,
          // The invitation binds an exact certificate rather than a changeable network address.
          checkServerIdentity: (_hostname: string, cert: tls.PeerCertificate) => this.checkPin(cert),
        } : {}),
        ALPNProtocols: ['http/1.1'],
      }));
      const timer = setTimeout(() => secure.destroy(new Error('Secure connection timed out.')), CONNECT_TIMEOUT);
      secure.once('error', (error) => { clearTimeout(timer); socket.destroy(); reject(error); });
      secure.once('secureConnect', () => {
        clearTimeout(timer);
        const error = pinned ? this.checkPin(secure.getPeerCertificate()) : undefined;
        if (error) { secure.destroy(); socket.destroy(); reject(error); return; }
        resolve(secure);
      });
      secure.once('close', () => socket.destroy());
    });
  }

  private checkPin(cert: tls.PeerCertificate): Error | undefined {
    if (!cert.raw || !timingSafeEqual(createHash('sha256').update(cert.raw).digest(), this.pin)) return new Error('The host certificate does not match the invitation.');
    return undefined;
  }

  private async openPinnedSocket(): Promise<tls.TLSSocket> {
    const host = this.endpoint.hostname.replace(/^\[|\]$/g, '');
    const transport = this.route.mode === 'relay' ? await this.openRelay() : await this.dial(host, Number(this.endpoint.port || 443));
    return this.secureSocket(transport, host, true);
  }

  private async openRelay(): Promise<Duplex> {
    const relay = validateRelay(this.route.relay ?? this.invitation.relay);
    const url = relayURL(relay.url);
    url.searchParams.set('role', 'viewer');
    url.searchParams.set('device', relay.deviceId);
    const secure = url.protocol === 'wss:';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!secure && this.route.proxy) {
      const proxyHost = this.route.proxy.host.replace(/^\[|\]$/g, '').toLowerCase();
      const local = proxyHost === 'localhost' || proxyHost === '::1' || (net.isIP(proxyHost) === 4 && proxyHost.startsWith('127.'));
      if (!local) throw new Error('Plain development WS cannot use a non-loopback proxy. Configure WSS.');
    }
    const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    this.outerAgents.add(agent);
    agent.createConnection = (_options, callback) => {
      void this.dial(host, Number(url.port || (secure ? 443 : 80)))
        .then(async (socket): Promise<net.Socket> => secure ? await this.secureSocket(socket, host, false) : socket)
        .then(socket => callback?.(null, socket), (error: Error) => callback?.(error, undefined as never));
      return undefined as never;
    };
    return new Promise((resolve, reject) => {
      const websocket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${relay.token}` },
        agent,
        handshakeTimeout: CONNECT_TIMEOUT,
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: 1024 * 1024,
      });
      this.websockets.add(websocket);
      websocket.once('close', () => { this.websockets.delete(websocket); agent.destroy(); this.outerAgents.delete(agent); });
      websocket.once('error', () => reject(new Error('Relay connection failed. Check its address, access token, proxy, and host availability.')));
      websocket.once('unexpected-response', (_request, response) => {
        response.resume();
        websocket.terminate();
        reject(new Error(response.statusCode === 503 ? 'The host has no available relay connection. Try again shortly.' : 'The relay refused the connection. Check its access token and capacity.'));
      });
      websocket.once('open', () => {
        if (this.closed) { websocket.terminate(); reject(new Error('The session is closed.')); return; }
        const stream = this.track(createWebSocketStream(websocket, { encoding: undefined }));
        stream.on('error', () => { /* The wrapping TLS socket reports transport errors. */ });
        resolve(stream);
      });
    });
  }

  private request(method: string, path: string, body?: Buffer, limit = 64 * 1024): Promise<{ body: Buffer; contentType?: string }> {
    if (this.closed) return Promise.reject(new Error('The session is closed.'));
    return new Promise((resolve, reject) => {
      const request = https.request(new URL(path, this.endpoint), {
        method,
        agent: this.agent,
        headers: {
          Authorization: `Bearer ${this.invitation.token}`,
          Accept: path.startsWith('/v1/frame') ? 'image/jpeg' : 'application/json',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
        },
      });
      const timer = setTimeout(() => request.destroy(new Error('The host did not respond in time.')), REQUEST_TIMEOUT);
      request.once('error', (error) => { clearTimeout(timer); reject(error); });
      request.once('response', (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) { response.destroy(new Error('The host response exceeded its size limit.')); return; }
          chunks.push(chunk);
        });
        response.once('error', (error) => { clearTimeout(timer); reject(error); });
        response.once('end', () => {
          clearTimeout(timer);
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const messages: Record<number, string> = { 401: 'The host rejected this invitation. Pair again.', 403: 'The host has not granted this permission.', 409: 'Another controller has the input lease.', 429: 'The host is busy. Try again shortly.', 503: 'The host cannot capture or control this desktop. Check its system permissions.' };
            reject(new Error(messages[status] ?? `The host returned HTTP ${status}.`));
            return;
          }
          resolve({ body: Buffer.concat(chunks), contentType: response.headers['content-type'] });
        });
      });
      request.end(body);
    });
  }
}
