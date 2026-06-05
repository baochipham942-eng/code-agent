import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeBundleDir,
  readActiveBundleMeta,
  readActiveContentHash,
  resolveRendererServeDir,
} from '../../src/main/services/renderer/rendererBundleCache';

describe('rendererBundleCache（serve 目录解析 + active 健康校验 + 兜底）', () => {
  let dataDir: string;
  const builtinDir = '/app/dist/renderer';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rbc-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seedActive(meta: unknown, withIndexHtml: boolean) {
    const active = activeBundleDir(dataDir);
    mkdirSync(active, { recursive: true });
    if (meta !== undefined) {
      writeFileSync(
        join(active, '.bundle-meta.json'),
        typeof meta === 'string' ? meta : JSON.stringify(meta),
      );
    }
    if (withIndexHtml) writeFileSync(join(active, 'index.html'), '<html></html>');
  }

  it('无 active 缓存 → serve 包内 builtin', () => {
    expect(resolveRendererServeDir(dataDir, builtinDir)).toBe(builtinDir);
  });

  it('active 健康（合法 meta + index.html）→ serve active', () => {
    seedActive({ version: '0.16.91', contentHash: 'abc' }, true);
    expect(resolveRendererServeDir(dataDir, builtinDir)).toBe(activeBundleDir(dataDir));
  });

  it('active 有 meta 但缺 index.html → 不健康，fallback builtin', () => {
    seedActive({ version: '0.16.91', contentHash: 'abc' }, false);
    expect(resolveRendererServeDir(dataDir, builtinDir)).toBe(builtinDir);
  });

  it('active meta 畸形 JSON → null + fallback builtin', () => {
    seedActive('{not valid json', true);
    expect(readActiveBundleMeta(dataDir)).toBeNull();
    expect(resolveRendererServeDir(dataDir, builtinDir)).toBe(builtinDir);
  });

  it('active meta 缺字段 → null + fallback builtin', () => {
    seedActive({ version: '0.16.91' }, true);
    expect(readActiveBundleMeta(dataDir)).toBeNull();
    expect(resolveRendererServeDir(dataDir, builtinDir)).toBe(builtinDir);
  });

  it('readActiveContentHash：健康返回 hash，无 active 返回 null（喂给契约门）', () => {
    expect(readActiveContentHash(dataDir)).toBeNull();
    seedActive({ version: '0.16.91', contentHash: 'deadbeef' }, true);
    expect(readActiveContentHash(dataDir)).toBe('deadbeef');
  });
});
