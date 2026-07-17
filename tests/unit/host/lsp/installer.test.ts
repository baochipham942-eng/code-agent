// ============================================================================
// LSP installer — PATH hit, npm install paths, system install error
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  getUserConfigDir: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: mocks.spawnSync,
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: mocks.getUserConfigDir,
}));

import {
  ensureInstalled,
  getLSPInstallDir,
  LSPInstallError,
} from '../../../../src/host/lsp/installer';

describe('LSP installer', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-install-'));
    mocks.getUserConfigDir.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function pathProbe(status: number): void {
    // isCommandOnPath uses which/where via spawnSync
    mocks.spawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status, stdout: status === 0 ? '/usr/bin/foo\n' : '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
  }

  it('getLSPInstallDir joins user config with lsp-servers', () => {
    expect(getLSPInstallDir()).toBe(path.join(tmpDir, 'lsp-servers'));
  });

  it('returns PATH command when already installed (installed=false)', async () => {
    pathProbe(0);
    const resolved = await ensureInstalled({
      name: 'typescript',
      command: 'typescript-language-server',
      args: ['--stdio'],
      install: { type: 'npm', packages: ['typescript-language-server'], binName: 'typescript-language-server' },
    });
    expect(resolved).toEqual({
      command: 'typescript-language-server',
      args: ['--stdio'],
      installed: false,
    });
    // should not attempt npm install
    expect(mocks.spawnSync.mock.calls.every((c) => c[0] !== 'npm')).toBe(true);
  });

  it('throws LSPInstallError when missing on PATH and no install config', async () => {
    pathProbe(1);
    await expect(
      ensureInstalled({ name: 'foo', command: 'foo-ls', args: [] }),
    ).rejects.toMatchObject({
      name: 'LSPInstallError',
      serverName: 'foo',
      message: expect.stringContaining('no installer configured'),
    });
  });

  it('system install source throws with installCmd guidance', async () => {
    pathProbe(1);
    await expect(
      ensureInstalled({
        name: 'rust-analyzer',
        command: 'rust-analyzer',
        args: [],
        install: {
          type: 'system',
          installCmd: 'rustup component add rust-analyzer',
          docUrl: 'https://example.com',
        },
      }),
    ).rejects.toMatchObject({
      name: 'LSPInstallError',
      message: expect.stringContaining('rustup component add rust-analyzer'),
    });
  });

  it('npm: reuses existing bin without reinstalling', async () => {
    pathProbe(1);
    const installDir = path.join(tmpDir, 'lsp-servers');
    const binDir = path.join(installDir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, 'typescript-language-server');
    fs.writeFileSync(binPath, '#!/bin/sh\n');

    const resolved = await ensureInstalled({
      name: 'typescript',
      command: 'typescript-language-server',
      args: ['--stdio'],
      install: {
        type: 'npm',
        packages: ['typescript-language-server'],
        binName: 'typescript-language-server',
      },
    });

    expect(resolved.command).toBe(binPath);
    expect(resolved.installed).toBe(false);
    expect(mocks.spawnSync.mock.calls.every((c) => c[0] !== 'npm')).toBe(true);
  });

  it('npm: installs packages then returns new bin path (installed=true)', async () => {
    pathProbe(1);
    mocks.spawnSync.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'npm') {
        // simulate successful install by writing bin
        const installDir = path.join(tmpDir, 'lsp-servers');
        const binDir = path.join(installDir, 'node_modules', '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'pyright-langserver'), '#!/bin/sh\n');
        return { status: 0, stdout: 'ok', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const resolved = await ensureInstalled({
      name: 'pyright',
      command: 'pyright-langserver',
      args: ['--stdio'],
      install: {
        type: 'npm',
        packages: ['pyright'],
        binName: 'pyright-langserver',
      },
    });

    expect(resolved.installed).toBe(true);
    expect(resolved.command).toContain('pyright-langserver');
    expect(fs.existsSync(path.join(tmpDir, 'lsp-servers', 'package.json'))).toBe(true);
  });

  it('npm: install failure wraps as LSPInstallError with cause', async () => {
    pathProbe(1);
    mocks.spawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'npm') {
        return { status: 1, stdout: '', stderr: 'EACCES denied' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    try {
      await ensureInstalled({
        name: 'pyright',
        command: 'pyright-langserver',
        args: [],
        install: { type: 'npm', packages: ['pyright'], binName: 'pyright-langserver' },
      });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LSPInstallError);
      const e = err as LSPInstallError;
      expect(e.serverName).toBe('pyright');
      expect(e.message).toContain('Failed to install pyright');
      expect(e.cause).toBeInstanceOf(Error);
    }
  });

  it('npm: completed install but missing bin throws LSPInstallError', async () => {
    pathProbe(1);
    mocks.spawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'npm') {
        // success status but no bin written
        return { status: 0, stdout: 'ok', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    await expect(
      ensureInstalled({
        name: 'ghost',
        command: 'ghost-ls',
        args: [],
        install: { type: 'npm', packages: ['ghost-ls'], binName: 'ghost-ls' },
      }),
    ).rejects.toMatchObject({
      name: 'LSPInstallError',
      message: expect.stringContaining("bin 'ghost-ls' not found"),
    });
  });
});
