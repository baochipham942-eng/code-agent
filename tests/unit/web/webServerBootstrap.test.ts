import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  enableWebServerCompileCache,
  resolveCompileCacheDir,
} = require('../../../src/web/webServerBootstrap.cjs') as {
  enableWebServerCompileCache: (options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    enable?: (cacheDir: string) => unknown;
  }) => { enabled: boolean; cacheDir: string };
  resolveCompileCacheDir: (env?: NodeJS.ProcessEnv, homeDir?: string) => string;
};

describe('webServer compile cache bootstrap', () => {
  it('places the cache under CODE_AGENT_DATA_DIR', () => {
    expect(resolveCompileCacheDir(
      { CODE_AGENT_DATA_DIR: '/tmp/agent-data' },
      '/Users/test',
    )).toBe('/tmp/agent-data/cache/v8-compile-cache');
  });

  it('falls back to the production data directory under HOME', () => {
    expect(resolveCompileCacheDir({}, '/Users/test'))
      .toBe('/Users/test/.code-agent/cache/v8-compile-cache');
  });

  it('degrades without blocking startup when compile cache is unavailable', () => {
    const enable = vi.fn(() => {
      throw new Error('unsupported');
    });

    expect(enableWebServerCompileCache({
      env: { CODE_AGENT_DATA_DIR: '/tmp/agent-data' },
      homeDir: '/Users/test',
      enable,
    })).toEqual({
      enabled: false,
      cacheDir: '/tmp/agent-data/cache/v8-compile-cache',
    });
    expect(enable).toHaveBeenCalledWith('/tmp/agent-data/cache/v8-compile-cache');
  });
});
