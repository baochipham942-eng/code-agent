import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({
  spawnedEnv: undefined as Record<string, string> | undefined,
}));

vi.mock('node-pty', () => ({
  spawn: (_shell: string, _args: string[], options: { env: Record<string, string> }) => {
    state.spawnedEnv = options.env;
    return {
      pid: 424242,
      onData: vi.fn(),
      onExit: (callback: (event: { exitCode: number }) => void) => {
        queueMicrotask(() => callback({ exitCode: 0 }));
      },
      write: vi.fn(),
      kill: vi.fn(),
    };
  },
}));

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-pty-env-'));
vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => configDir,
}));

const { createPtySession } = await import('../../../../src/host/tools/shell/ptyExecutor');

describe('ptyExecutor environment isolation', () => {
  it('does not merge process secrets when the caller supplies a complete environment', async () => {
    process.env.AUTO_TEST_API_KEY = 'must-not-reappear';
    try {
      const result = createPtySession({
        command: 'true',
        cwd: configDir,
        env: { PATH: '/safe/bin' },
        inheritProcessEnv: false,
      });
      await Promise.resolve();

      expect(result.success).toBe(true);
      expect(state.spawnedEnv).toEqual({ PATH: '/safe/bin', TERM: 'xterm-256color' });
    } finally {
      delete process.env.AUTO_TEST_API_KEY;
    }
  });
});
