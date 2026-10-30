import { contextBridge, ipcRenderer } from 'electron';
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`remoter:${name}`, ...args);
contextBridge.exposeInMainWorld('remoter', {
  getState: () => invoke('getState'),
  addDevice: (invitation: string) => invoke('addDevice', invitation),
  removeDevice: (id: string) => invoke('removeDevice', id),
  saveNetwork: (settings: unknown) => invoke('saveNetwork', settings),
  testDevice: (id: string) => invoke('testDevice', id),
  connect: (id: string) => invoke('connect', id),
  frame: (options: unknown) => invoke('frame', options),
  input: (options: unknown) => invoke('input', options),
  disconnect: (id: string) => invoke('disconnect', id),
  startHost: (options: unknown) => invoke('startHost', options),
  stopHost: () => invoke('stopHost'),
  copy: (text: string) => invoke('copy', text)
});
