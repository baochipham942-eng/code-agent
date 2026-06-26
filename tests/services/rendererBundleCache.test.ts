import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeBundleDir,
  readActiveBundleMeta,
  readActiveContentHash,
  readRendererBundleStatus,
  resolveRendererServeDecision,
  resolveRendererServeDir,
} from '../../src/host/services/renderer/rendererBundleCache';
import {
  RENDERER_BUNDLE_CHANNEL_ENV,
  RENDERER_BUNDLE_MANIFEST_URL_ENV,
} from '../../src/shared/constants/network';

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
    expect(resolveRendererServeDecision(dataDir, builtinDir)).toMatchObject({
      source: 'builtin',
      reason: 'no-active-meta',
      serveDir: builtinDir,
      activeBundle: null,
    });
  });

  it('active 健康（合法 meta + index.html）→ serve active', () => {
    seedActive({ version: '0.16.91', contentHash: 'abc' }, true);
    expect(resolveRendererServeDir(dataDir, builtinDir)).toBe(activeBundleDir(dataDir));
    expect(resolveRendererServeDecision(dataDir, builtinDir)).toMatchObject({
      source: 'active',
      reason: 'active-healthy',
      serveDir: activeBundleDir(dataDir),
      activeBundle: { version: '0.16.91', contentHash: 'abc' },
    });
  });

  it('active 版本低于当前 shell → serve 包内 builtin，避免旧前端压过新壳修复', () => {
    seedActive({ version: '0.16.101', contentHash: 'abc' }, true);

    expect(resolveRendererServeDir(dataDir, builtinDir, process.env, {
      currentShellVersion: '0.16.102',
    })).toBe(builtinDir);
    expect(resolveRendererServeDecision(dataDir, builtinDir, process.env, {
      currentShellVersion: '0.16.102',
    })).toMatchObject({
      source: 'builtin',
      reason: 'active-older-than-shell',
      activeBundle: { version: '0.16.101', contentHash: 'abc' },
    });
  });

  it('active 版本等于当前 shell → 仍可 serve active', () => {
    seedActive({ version: '0.16.102', contentHash: 'abc' }, true);

    expect(resolveRendererServeDir(dataDir, builtinDir, process.env, {
      currentShellVersion: '0.16.102',
    })).toBe(activeBundleDir(dataDir));
  });

  it('热更被 kill switch 停用时，即使 active 健康也 serve 包内 builtin', () => {
    seedActive({ version: '0.16.91', contentHash: 'abc' }, true);

    expect(resolveRendererServeDir(dataDir, builtinDir, {
      CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
    } as NodeJS.ProcessEnv)).toBe(builtinDir);
    expect(resolveRendererServeDecision(dataDir, builtinDir, {
      CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
    } as NodeJS.ProcessEnv)).toMatchObject({
      source: 'builtin',
      reason: 'hot-update-disabled',
      disabledReason: 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE',
    });
    expect(readRendererBundleStatus(dataDir, {
      CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
    } as NodeJS.ProcessEnv)).toMatchObject({
      disabled: true,
      disabledReason: 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE',
      activeBundle: null,
    });
  });

  it('readRendererBundleStatus 暴露当前热更 manifest source 配置', () => {
    expect(readRendererBundleStatus(dataDir, {
      [RENDERER_BUNDLE_CHANNEL_ENV]: 'beta',
    } as NodeJS.ProcessEnv)).toMatchObject({
      source: {
        channel: 'beta',
        manifestUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/channels/beta/manifest.json',
      },
    });

    expect(readRendererBundleStatus(dataDir, {
      [RENDERER_BUNDLE_CHANNEL_ENV]: 'staff',
      [RENDERER_BUNDLE_MANIFEST_URL_ENV]: 'https://cdn.example.com/canary/manifest.json',
    } as NodeJS.ProcessEnv)).toMatchObject({
      source: {
        channel: 'staff',
        manifestUrl: 'https://cdn.example.com/canary/manifest.json',
        manifestUrlOverride: true,
      },
    });
  });

  it('readRendererBundleStatus 对非法 channel 暴露配置错误，但不抛出', () => {
    expect(readRendererBundleStatus(dataDir, {
      [RENDERER_BUNDLE_CHANNEL_ENV]: '../beta',
    } as NodeJS.ProcessEnv)).toMatchObject({
      source: {
        channel: '../beta',
        errorReason: 'invalid-renderer-bundle-channel',
        errorTarget: `${RENDERER_BUNDLE_CHANNEL_ENV}=../beta`,
      },
    });
  });

  it('active 有 meta 但缺 index.html → 不健康，fallback builtin', () => {
    seedActive({ version: '0.16.91', contentHash: 'abc' }, false);
    expect(resolveRendererServeDir(dataDir, builtinDir)).toBe(builtinDir);
    expect(resolveRendererServeDecision(dataDir, builtinDir)).toMatchObject({
      source: 'builtin',
      reason: 'active-index-missing',
      activeBundle: { version: '0.16.91', contentHash: 'abc' },
    });
  });

  it('active meta 畸形 JSON → null + fallback builtin', () => {
    seedActive('{not valid json', true);
    expect(readActiveBundleMeta(dataDir)).toBeNull();
    expect(resolveRendererServeDir(dataDir, builtinDir)).toBe(builtinDir);
    expect(resolveRendererServeDecision(dataDir, builtinDir)).toMatchObject({
      source: 'builtin',
      reason: 'invalid-active-meta',
      activeBundle: null,
    });
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
