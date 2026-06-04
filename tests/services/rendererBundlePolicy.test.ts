import { describe, expect, it } from 'vitest';
import { shouldApplyRendererBundle } from '../../src/main/services/renderer/rendererBundlePolicy';

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

  it('contentHash 与本地 active 相同 → skip（已最新）', () => {
    expect(
      shouldApplyRendererBundle(validManifest, {
        currentShellVersion: '0.16.90',
        activeContentHash: 'abc123',
      }),
    ).toEqual({ apply: false, reason: 'already-current' });
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
  });
});
