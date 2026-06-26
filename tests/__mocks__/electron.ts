// ============================================================================
// Electron Mock for Vitest
// 在非 Electron 环境（vitest worker）中提供完整的 electron API mock
// ============================================================================

export const app = {
  getPath: (name: string) => `/tmp/mock-electron-${name}`,
  getAppPath: () => process.cwd(),
  getName: () => 'code-agent-test',
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  on: () => {},
  once: () => {},
  quit: () => {},
  whenReady: () => Promise.resolve(),
};

export class AppWindow {
  static getAllWindows() { return []; }
  static getFocusedWindow() { return null; }
  webContents = { send: () => {}, on: () => {} };
  on() { return this; }
  once() { return this; }
  show() {}
  hide() {}
  close() {}
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
}

export const ipcHost = {
  on: () => {},
  once: () => {},
  handle: () => {},
  removeHandler: () => {},
  removeAllListeners: () => {},
};

export const ipcClient = {
  on: () => {},
  once: () => {},
  send: () => {},
  invoke: () => Promise.resolve(),
  removeAllListeners: () => {},
};

export const clipboard = {
  readText: () => '',
  readImage: () => ({ isEmpty: () => true, toDataURL: () => '', getSize: () => ({ width: 0, height: 0 }) }),
  writeText: () => {},
  writeImage: () => {},
};

export const nativeImage = {
  createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
  createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
  createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
};

export const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
};

export const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
  showMessageBox: () => Promise.resolve({ response: 0 }),
};

export default {
  app,
  AppWindow,
  ipcHost,
  ipcClient,
  clipboard,
  nativeImage,
  shell,
  dialog,
};
