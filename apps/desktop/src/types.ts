export type ConnectionMode = 'direct' | 'tailscale' | 'relay';

export interface Device {
  id: string;
  name: string;
  endpoint: string;
  addedAt: string;
  lastConnectedAt?: string;
  status?: 'unknown' | 'ready' | 'offline';
}

export interface NetworkSettings {
  mode: ConnectionMode;
  proxyEnabled: boolean;
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
  proxyPasswordSaved?: boolean;
  relayUrl: string;
  relayDeviceId: string;
  relayToken: string;
  relayTokenSaved?: boolean;
}

export interface ActivityItem {
  id: string;
  at: string;
  deviceName: string;
  action: string;
}

export interface UpdateState {
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error' | 'unsupported';
  currentVersion: string;
  availableVersion?: string;
  source?: string;
  notes?: string;
  progress?: number;
  checkedAt?: string;
  message: string;
}

export interface AppState {
  devices: Device[];
  network: NetworkSettings;
  activity: ActivityItem[];
  hostRunning: boolean;
  hostInvitation?: string;
  hostSuggestedEndpoint?: string;
  hostSuggestedListen?: string;
}

export interface Display {
  id: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface HostInfo {
  name: string;
  os: string;
  version: string;
  capabilities: { capture: boolean; input: boolean };
  displays: Display[];
  synthetic?: boolean;
  warning?: string;
}

export type RemoteInput =
  | { type: 'move'; displayId: number; x: number; y: number }
  | { type: 'button'; button: 'left' | 'middle' | 'right'; down: boolean }
  | { type: 'key'; code: string; down: boolean }
  | { type: 'scroll'; deltaX: number; deltaY: number }
  | { type: 'releaseAll' };

export interface RemoterAPI {
  getUpdates(): Promise<UpdateState>;
  checkUpdates(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  getState(): Promise<AppState>;
  addDevice(invitation: string): Promise<AppState>;
  removeDevice(id: string): Promise<AppState>;
  saveNetwork(settings: NetworkSettings): Promise<AppState>;
  testDevice(id: string): Promise<HostInfo>;
  connect(id: string): Promise<HostInfo>;
  frame(options: { deviceId: string; displayId: number; quality: number; width: number }): Promise<string>;
  input(options: { deviceId: string; event: RemoteInput }): Promise<void>;
  disconnect(id: string): Promise<AppState>;
  startHost(options: { allowInput: boolean; listen: string; advertise: string }): Promise<{ invitation: string }>;
  stopHost(): Promise<void>;
  copy(text: string): Promise<void>;
}

declare global {
  interface Window {
    remoter?: RemoterAPI;
  }
}
