// ============================================================================
// Preload Script - Bridge between main and renderer processes
// ============================================================================

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ElectronAPI, IPC_CHANNELS } from '../shared/ipc';

// Type-safe IPC wrapper
const electronAPI: ElectronAPI = {
  invoke: (channel, ...args) => {
    return ipcRenderer.invoke(channel, ...args) as any;
  },

  on: (channel, callback) => {
    const subscription = (_event: Electron.IpcRendererEvent, ...args: any[]) => {
      (callback as (...args: any[]) => void)(...args);
    };

    ipcRenderer.on(channel, subscription);

    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },

  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback as any);
  },

  // Electron 33+ 获取文件路径的方法
  getPathForFile: (file: File) => {
    return webUtils.getPathForFile(file);
  },
};

// Expose to renderer
contextBridge.exposeInMainWorld('electronAPI', electronAPI);
