import { contextBridge, ipcRenderer } from 'electron';
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`remoter:${name}`, ...args);
contextBridge.exposeInMainWorld('remoter', {
  getHostPermissions: () => invoke('getHostPermissions'),
  requestHostPermission: (permission: 'screen' | 'input') => invoke('requestHostPermission', permission),
  setTheme: (theme: 'light' | 'dark') => invoke('setTheme', theme),
  getUpdates: () => invoke('getUpdates'),
  checkUpdates: () => invoke('checkUpdates'),
  installUpdate: () => invoke('installUpdate'),
  getState: () => invoke('getState'),
  addDevice: (invitation: string) => invoke('addDevice', invitation),
  discoverLAN: () => invoke('discoverLAN'),
  addLANDevice: (id: string) => invoke('addLANDevice', id),
  audio: (options: unknown) => invoke('audio', options),
  clipboardSync: (options: unknown) => invoke('clipboardSync', options),
  removeDevice: (id: string) => invoke('removeDevice', id),
  saveNetwork: (settings: unknown) => invoke('saveNetwork', settings),
  setLaunchOnBoot: (enabled: boolean) => invoke('setLaunchOnBoot', enabled),
  testDevice: (id: string) => invoke('testDevice', id),
  connect: (id: string) => invoke('connect', id),
  frame: (options: unknown) => invoke('frame', options),
  input: (options: unknown) => invoke('input', options),
  disconnect: (id: string) => invoke('disconnect', id),
  startHost: (options: unknown) => invoke('startHost', options),
  stopHost: () => invoke('stopHost'),
  copy: (text: string) => invoke('copy', text)
});
