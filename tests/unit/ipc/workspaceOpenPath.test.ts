import { beforeEach, describe, expect, it, vi } from 'vitest';

const shellMocks = vi.hoisted(() => ({
  openPath: vi.fn(async (path: string) => path),
  showItemInFolder: vi.fn(),
}));

vi.mock('../../../src/host/platform', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/platform')>();
  return {
    ...actual,
    shell: {
      ...actual.shell,
      openPath: (...args: unknown[]) => shellMocks.openPath(...(args as [string])),
      showItemInFolder: (...args: unknown[]) => shellMocks.showItemInFolder(...(args as [string])),
    },
  };
});

import {
  handleOpenPath,
  handleShowItemInFolder,
} from '../../../src/host/ipc/workspace.ipc';

describe('workspace openPath / showItemInFolder absolute-path gate', () => {
  beforeEach(() => {
    shellMocks.openPath.mockClear();
    shellMocks.showItemInFolder.mockClear();
  });

  it('openPath accepts absolute paths', async () => {
    await expect(handleOpenPath({ filePath: '/tmp/absolute-file.md' })).resolves.toBe('/tmp/absolute-file.md');
    expect(shellMocks.openPath).toHaveBeenCalledWith('/tmp/absolute-file.md');
  });

  it('openPath rejects relative paths (no app-cwd resolution)', async () => {
    await expect(handleOpenPath(
      { filePath: 'relative/notes.md' },
      () => ({ getWorkingDirectory: () => '/wrong/app/cwd' } as never),
    )).rejects.toThrow(/相对路径|绝对路径/);
    expect(shellMocks.openPath).not.toHaveBeenCalled();
  });

  it('showItemInFolder accepts absolute paths', async () => {
    await handleShowItemInFolder({ filePath: '/Users/me/project/out.pdf' });
    expect(shellMocks.showItemInFolder).toHaveBeenCalledWith('/Users/me/project/out.pdf');
  });

  it('showItemInFolder rejects relative paths (no app-cwd resolution)', async () => {
    await expect(handleShowItemInFolder(
      { filePath: './out.pdf' },
      () => ({ getWorkingDirectory: () => '/wrong/app/cwd' } as never),
    )).rejects.toThrow(/相对路径|绝对路径/);
    expect(shellMocks.showItemInFolder).not.toHaveBeenCalled();
  });
});
