import { describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  register: vi.fn(() => true),
  unregister: vi.fn(),
}));

vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: platform.handle, removeHandler: platform.removeHandler },
  globalShortcut: { register: platform.register, unregister: platform.unregister },
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
  AppWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../src/host/services/speech/speechTranscriptionService', () => ({
  getSpeechTranscriptionService: () => ({ transcribe: vi.fn() }),
}));

import {
  registerVoicePasteHandlers,
  registerVoicePasteShortcut,
} from '../../../src/host/ipc/voicePaste.ipc';

describe('voice paste capability contributions', () => {
  it('registers both IPC handlers and removes both during package cleanup', async () => {
    const ipcMain = { handle: platform.handle, removeHandler: platform.removeHandler };

    const cleanup = registerVoicePasteHandlers(ipcMain as never);

    expect(platform.handle.mock.calls.map(([channel]) => channel)).toEqual([
      'voice-paste:get-status',
      'voice-paste:toggle',
    ]);
    await cleanup();
    expect(platform.removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      'voice-paste:get-status',
      'voice-paste:toggle',
    ]);
  });

  it('returns a cleanup that unregisters the package-owned global shortcut', async () => {
    const originalElectron = process.versions.electron;
    Object.defineProperty(process.versions, 'electron', { value: 'test', configurable: true });
    const cleanup = registerVoicePasteShortcut();

    await cleanup();

    expect(platform.unregister).toHaveBeenCalledWith('CommandOrControl+`');
    Object.defineProperty(process.versions, 'electron', {
      value: originalElectron,
      configurable: true,
    });
  });
});
