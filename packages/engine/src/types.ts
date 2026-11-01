export interface RelaySettings { url: string; deviceId: string; token: string }
export interface Invitation {
  version: 1;
  name: string;
  endpoint: string;
  certificate: string;
  token: string;
  relay?: RelaySettings;
}
export interface ProxySettings { host: string; port: number; username?: string; password?: string }
export interface RouteSettings {
  mode: 'direct' | 'tailscale' | 'relay';
  /** Optional LAN IP or MagicDNS endpoint override; the certificate remains pinned. */
  endpoint?: string;
  proxy?: ProxySettings;
  relay?: RelaySettings;
}
export interface Display { id: number; name: string; width: number; height: number; x: number; y: number }
export interface HostInfo {
  name: string;
  os: string;
  version: string;
  capabilities: { capture: boolean; input: boolean; clipboard?: boolean; audio?: boolean };
  displays: Display[];
}
export interface FrameOptions { display?: number; quality?: number; width?: number }
export interface AudioPacket { sequence: number; data: string; sampleRate: number; channels: number }
export interface LANHost { id: string; name: string; endpoint: string; certificate: string; easy: boolean }
export type InputEvent =
  | { type: 'move'; x: number; y: number; displayId: number }
  | { type: 'button'; button: 'left' | 'right' | 'middle'; down: boolean }
  | { type: 'key'; code: string; down: boolean }
  | { type: 'scroll'; deltaX: number; deltaY: number }
  | { type: 'releaseAll' };
