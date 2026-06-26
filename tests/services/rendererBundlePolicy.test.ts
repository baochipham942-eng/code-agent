import { describe, expect, it } from 'vitest';
import { shouldApplyRendererBundle } from '../../src/host/services/renderer/rendererBundlePolicy';

const validManifest = {
  version: '0.16.91',
  contentHash: 'abc123',
  minShellVersion: '0.16.0',
  bundleUrl: 'https://oss.example.com/renderer-bundle/latest/bundle.tar.gz',
};

describe('shouldApplyRendererBundle（前端热更契约门 + 兜底铁律）', () => {
  it('壳满足 minShellVersion 且 hash 不同 → 应用', () => {
    expect(
      shouldApplyRendererBundle(validManifest, {
        currentShellVersion: '0.16.90',
        activeContentHash: null,
      }),
    ).toEqual({ apply: true });
  });

  it('minShellVersion 高于当前壳 → 拒绝（防新前端配旧壳崩）', () => {
    expect(
      shouldApplyRendererBundle(
        { ...validManifest, minShellVersion: '0.17.0' },
        { currentShellVersion: '0.16.90', activeContentHash: null },
      ),
    ).toEqual({ apply: false, reason: 'shell-too-old' });
  });

  it('壳版本恰好等于 minShellVersion → 应用（边界）', () => {
    expect(
      shouldApplyRendererBundle(
        { ...validManifest, minShellVersion: '0.16.90' },
        { currentShellVersion: '0.16.90', activeContentHash: null },
      ),
    ).toEqual({ apply: true });
  });

  it('manifest 声明的壳能力全部满足 → 应用', () => {
    expect(
      shouldApplyRendererBundle(
        {
          ...validManifest,
          requiredShellCapabilities: ['domain:update/check'],
          requiredRuntimeAssets: ['playwright-browser-runtime'],
          requiredResources: ['resources/browser-relay-extension'],
        },
        {
          currentShellVersion: '0.16.90',
          activeContentHash: null,
          shellCapabilities: ['domain:update/check'],
          availableRuntimeAssets: ['playwright-browser-runtime'],
          availableResources: ['resources/browser-relay-extension'],
        },
      ),
    ).toEqual({ apply: true });
  });

  it('manifest 声明了旧壳没有的能力 → 拒绝', () => {
    expect(
      shouldApplyRendererBundle(
        {
          ...validManifest,
          requiredShellCapabilities: ['domain:update/check', 'domain:local/newAction'],
        },
        {
          currentShellVersion: '0.16.90',
          activeContentHash: null,
          shellCapabilities: ['domain:update/check'],
        },
      ),
    ).toEqual({
      apply: false,
      reason: 'missing-shell-capability',
      missingShellCapabilities: ['domain:local/newAction'],
    });
  });

  it('manifest 声明了本机缺失的 runtime asset → 拒绝', () => {
    expect(
      shouldApplyRendererBundle(
        {
          ...validManifest,
          requiredRuntimeAssets: ['playwright-browser-runtime', 'onnxruntime-vad'],
        },
        {
          currentShellVersion: '0.16.90',
          activeContentHash: null,
          availableRuntimeAssets: ['onnxruntime-vad'],
        },
      ),
    ).toEqual({
      apply: false,
      reason: 'missing-runtime-asset',
      missingRuntimeAssets: ['playwright-browser-runtime'],
    });
  });

  it('manifest 声明了本机缺失的包内资源 → 拒绝', () => {
    expect(
      shouldApplyRendererBundle(
        {
          ...validManifest,
          requiredResources: ['resources/browser-relay-extension', 'resources/new-worker'],
        },
        {
          currentShellVersion: '0.16.90',
          activeContentHash: null,
          availableResources: ['resources/browser-relay-extension'],
        },
      ),
    ).toEqual({
      apply: false,
      reason: 'missing-resource',
      missingResources: ['resources/new-worker'],
    });
  });

  it('manifest 声明的 runtime asset 和包内资源都满足 → 应用', () => {
    expect(
      shouldApplyRendererBundle(
        {
          ...validManifest,
          requiredRuntimeAssets: ['playwright-browser-runtime'],
          requiredResources: ['resources/browser-relay-extension'],
        },
        {
          currentShellVersion: '0.16.90',
          activeContentHash: null,
          availableRuntimeAssets: ['playwright-browser-runtime'],
          availableResources: ['resources/browser-relay-extension'],
        },
      ),
    ).toEqual({ apply: true });
  });

  it('contentHash 与本地 active 相同 → skip（已最新）', () => {
    expect(
      shouldApplyRendererBundle(validManifest, {
        currentShellVersion: '0.16.90',
        activeContentHash: 'abc123',
      }),
    ).toEqual({ apply: false, reason: 'already-current' });
  });

  it('signed rollback manifest → 回包内基线', () => {
    expect(
      shouldApplyRendererBundle(
        {
          version: '0.16.93',
          minShellVersion: '0.16.93',
          rollbackToBuiltin: true,
          rollbackReason: 'bad renderer overlay',
        },
        {
          currentShellVersion: '0.16.93',
          activeContentHash: 'abc123',
        },
      ),
    ).toEqual({ apply: false, reason: 'rollback-to-builtin' });
  });

  it('manifest 畸形（非对象 / 缺字段 / 空字段）→ 拒绝', () => {
    const ctx = { currentShellVersion: '0.16.90', activeContentHash: null };
    expect(shouldApplyRendererBundle(null, ctx)).toEqual({
      apply: false,
      reason: 'invalid-manifest',
    });
    expect(shouldApplyRendererBundle({ version: '1.0.0' }, ctx)).toEqual({
      apply: false,
      reason: 'invalid-manifest',
    });
    expect(shouldApplyRendererBundle({ ...validManifest, contentHash: '' }, ctx)).toEqual({
      apply: false,
      reason: 'invalid-manifest',
    });
    expect(
      shouldApplyRendererBundle({ ...validManifest, requiredShellCapabilities: [''] }, ctx),
    ).toEqual({
      apply: false,
      reason: 'invalid-manifest',
    });
    expect(
      shouldApplyRendererBundle({ ...validManifest, requiredRuntimeAssets: [''] }, ctx),
    ).toEqual({
      apply: false,
      reason: 'invalid-manifest',
    });
    expect(
      shouldApplyRendererBundle({ ...validManifest, requiredResources: [''] }, ctx),
    ).toEqual({
      apply: false,
      reason: 'invalid-manifest',
    });
    expect(
      shouldApplyRendererBundle({ version: '1.0.0', minShellVersion: '1.0.0' }, ctx),
    ).toEqual({
      apply: false,
      reason: 'invalid-manifest',
    });
  });
});
