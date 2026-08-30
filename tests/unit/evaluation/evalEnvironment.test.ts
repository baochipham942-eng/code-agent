import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectEvalEnvironment } from '@internal-evaluation/host/evaluation/evalEnvironment';

const repoRoot = path.resolve(__dirname, '../../..');

describe('evaluation environment probe', () => {
  it('accepts the development checkout and reports proxy settings without changing them', () => {
    const result = inspectEvalEnvironment({
      packaged: false,
      cwd: repoRoot,
      env: {
        HTTP_PROXY: 'http://proxy.example',
        NO_PROXY: 'localhost,127.0.0.1',
      },
    });

    expect(result).toMatchObject({
      available: true,
      repositoryRoot: repoRoot,
      packaged: false,
      git: { available: true, repository: true },
      osJail: {
        enabled: expect.any(Boolean),
        available: expect.any(Boolean),
        active: expect.any(Boolean),
      },
      proxy: {
        HTTP_PROXY: 'http://proxy.example',
        NO_PROXY: 'localhost,127.0.0.1',
      },
    });
    expect(result.osJail.active).toBe(result.osJail.enabled && result.osJail.available);
  });

  it('rejects a packaged build with the product-facing message even when source files are visible', () => {
    const result = inspectEvalEnvironment({ packaged: true, cwd: repoRoot });

    expect(result.available).toBe(false);
    expect(result.failures).toContain('packaged_build');
    expect(result.message).toBe('这个安装包不含评测引擎，请在开发构建里跑');
    expect(result.message).not.toMatch(/spawn|NDJSON|沙箱|分母/i);
  });

  it('rejects Windows because the repository snapshot path is POSIX-only', () => {
    const result = inspectEvalEnvironment({ packaged: false, cwd: repoRoot, platform: 'win32' });

    expect(result.available).toBe(false);
    expect(result.failures).toContain('unsupported_platform');
  });
});
