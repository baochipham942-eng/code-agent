import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listenTauriEvent,
  openNativePath,
  openNativeUrl,
  pickNativeDirectory,
  revealNativePath,
} from '../../../src/renderer/services/tauriPluginFacade';

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
}));

const openerMocks = vi.hoisted(() => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMocks.listen,
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: openerMocks.openPath,
  openUrl: openerMocks.openUrl,
  revealItemInDir: openerMocks.revealItemInDir,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: dialogMocks.open,
}));

describe('tauriPluginFacade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Tauri event listeners behind one service boundary', async () => {
    const unlisten = vi.fn();
    const handler = vi.fn();
    eventMocks.listen.mockResolvedValueOnce(unlisten);

    const result = await listenTauriEvent('memo:activate', handler);

    expect(eventMocks.listen).toHaveBeenCalledWith('memo:activate', handler);
    expect(result).toBe(unlisten);
  });

  it('routes opener operations through stable helpers', async () => {
    await openNativePath('/tmp/report.md');
    expect(openerMocks.openPath).toHaveBeenCalledWith('/tmp/report.md');

    await openNativeUrl('https://agentneo.local');
    expect(openerMocks.openUrl).toHaveBeenCalledWith('https://agentneo.local');

    await revealNativePath('/tmp/report.md');
    expect(openerMocks.revealItemInDir).toHaveBeenCalledWith('/tmp/report.md');
  });

  it('normalizes native directory picker results', async () => {
    dialogMocks.open.mockResolvedValueOnce('/Users/linchen/project');
    await expect(pickNativeDirectory({ title: '选择项目目录' })).resolves.toBe('/Users/linchen/project');
    expect(dialogMocks.open).toHaveBeenLastCalledWith({
      directory: true,
      multiple: false,
      title: '选择项目目录',
    });

    dialogMocks.open.mockResolvedValueOnce(['/Users/linchen/project']);
    await expect(pickNativeDirectory()).resolves.toBeNull();

    dialogMocks.open.mockResolvedValueOnce(null);
    await expect(pickNativeDirectory()).resolves.toBeNull();
  });
});
