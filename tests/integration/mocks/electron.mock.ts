// ============================================================================
// Electron API Mocks for Testing
// ============================================================================
//
// Provides mock implementations of Electron APIs for testing without
// requiring an actual Electron runtime.
// ============================================================================

import { vi } from 'vitest';
import path from 'path';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface MockElectronApp {
  getPath: ReturnType<typeof vi.fn>;
  getName: ReturnType<typeof vi.fn>;
  getVersion: ReturnType<typeof vi.fn>;
  isPackaged: boolean;
  quit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  whenReady: ReturnType<typeof vi.fn>;
}

export interface MockBrowserWindow {
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  webContents: {
    send: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    openDevTools: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
}

export interface MockDialog {
  showOpenDialog: ReturnType<typeof vi.fn>;
  showSaveDialog: ReturnType<typeof vi.fn>;
  showMessageBox: ReturnType<typeof vi.fn>;
  showErrorBox: ReturnType<typeof vi.fn>;
}

export interface MockShell {
  openExternal: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
  showItemInFolder: ReturnType<typeof vi.fn>;
  trashItem: ReturnType<typeof vi.fn>;
}

export interface MockClipboard {
  readText: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
  readImage: ReturnType<typeof vi.fn>;
  writeImage: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

export interface MockIpcMain {
  handle: ReturnType<typeof vi.fn>;
  handleOnce: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeHandler: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

export interface MockIpcRenderer {
  invoke: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

// ----------------------------------------------------------------------------
// Mock Factories
// ----------------------------------------------------------------------------

/**
 * Creates a mock Electron app object
 */
export function createMockApp(tempDir: string): MockElectronApp {
  return {
    getPath: vi.fn((name: string) => {
      switch (name) {
        case 'userData': return path.join(tempDir, 'userData');
        case 'temp': return path.join(tempDir, 'temp');
        case 'home': return tempDir;
        case 'appData': return path.join(tempDir, 'appData');
        case 'documents': return path.join(tempDir, 'documents');
        case 'downloads': return path.join(tempDir, 'downloads');
        case 'desktop': return path.join(tempDir, 'desktop');
        default: return tempDir;
      }
    }),
    getName: vi.fn(() => 'Code Agent Test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    quit: vi.fn(),
    on: vi.fn(),
    whenReady: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a mock BrowserWindow
 */
export function createMockBrowserWindow(): MockBrowserWindow {
  return {
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    webContents: {
      send: vi.fn(),
      on: vi.fn(),
      openDevTools: vi.fn(),
    },
    on: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
    focus: vi.fn(),
    setTitle: vi.fn(),
  };
}

/**
 * Creates a mock dialog module
 */
export function createMockDialog(): MockDialog {
  return {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: [] }),
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '' }),
    showMessageBox: vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false }),
    showErrorBox: vi.fn(),
  };
}

/**
 * Creates a mock shell module
 */
export function createMockShell(): MockShell {
  return {
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a mock clipboard module
 */
export function createMockClipboard(): MockClipboard {
  let textContent = '';

  return {
    readText: vi.fn(() => textContent),
    writeText: vi.fn((text: string) => { textContent = text; }),
    readImage: vi.fn(() => ({ isEmpty: () => true, toDataURL: () => '' })),
    writeImage: vi.fn(),
    clear: vi.fn(() => { textContent = ''; }),
  };
}

/**
 * Creates a mock ipcMain module
 */
export function createMockIpcMain(): MockIpcMain {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    handleOnce: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(channel)) {
        listeners.set(channel, new Set());
      }
      listeners.get(channel)!.add(listener);
    }),
    once: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(channel)) {
        listeners.set(channel, new Set());
      }
      listeners.get(channel)!.add(listener);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener);
    }),
  };
}

/**
 * Creates a mock ipcRenderer module
 */
export function createMockIpcRenderer(): MockIpcRenderer {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    invoke: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(channel)) {
        listeners.set(channel, new Set());
      }
      listeners.get(channel)!.add(listener);
      return { removeListener: () => listeners.get(channel)?.delete(listener) };
    }),
    once: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(channel)) {
        listeners.set(channel, new Set());
      }
      listeners.get(channel)!.add(listener);
    }),
    removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener);
    }),
  };
}

// ----------------------------------------------------------------------------
// Complete Electron Mock
// ----------------------------------------------------------------------------

export interface MockElectron {
  app: MockElectronApp;
  BrowserWindow: ReturnType<typeof vi.fn>;
  dialog: MockDialog;
  shell: MockShell;
  clipboard: MockClipboard;
  ipcMain: MockIpcMain;
  ipcRenderer: MockIpcRenderer;
}

/**
 * Creates a complete mock of the Electron module
 */
export function createMockElectron(tempDir: string): MockElectron {
  const mockBrowserWindow = vi.fn().mockImplementation(() => createMockBrowserWindow());

  return {
    app: createMockApp(tempDir),
    BrowserWindow: mockBrowserWindow,
    dialog: createMockDialog(),
    shell: createMockShell(),
    clipboard: createMockClipboard(),
    ipcMain: createMockIpcMain(),
    ipcRenderer: createMockIpcRenderer(),
  };
}

/**
 * Sets up Electron module mocks for vitest
 */
export function setupElectronMocks(tempDir: string) {
  const mockElectron = createMockElectron(tempDir);

  vi.mock('electron', () => mockElectron);

  return mockElectron;
}
