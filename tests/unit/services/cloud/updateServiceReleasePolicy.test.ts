// ============================================================================
// applyReleasePolicyToUpdateInfo —— release policy 的 sha256 必须与其 downloadUrl 同源，
// 不得让 policy sha 盖掉来源（Vercel/OSS）资产 sha 却不换 URL（R2 codex finding）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { applyReleasePolicyToUpdateInfo } from '../../../../src/host/services/cloud/updateService';
import type { UpdateInfo } from '../../../../src/host/services/cloud/updateService';

const source: UpdateInfo = {
  hasUpdate: true,
  currentVersion: '0.22.1',
  latestVersion: '0.22.2',
  downloadUrl: 'https://oss.example/v0.22.2/app.dmg',
  sha256: 'a'.repeat(64),
};

describe('applyReleasePolicyToUpdateInfo sha/url coupling', () => {
  it('does NOT apply policy sha256 when policy has no downloadUrl (preserve source url+sha)', () => {
    const result = applyReleasePolicyToUpdateInfo(source, {
      channel: 'stable',
      latestVersion: '0.22.2',
      sha256: 'b'.repeat(64), // policy sha 但无 policy downloadUrl
    });
    expect(result.downloadUrl).toBe('https://oss.example/v0.22.2/app.dmg');
    expect(result.sha256).toBe('a'.repeat(64)); // 保留来源 sha，绝不换成游离的 policy sha
  });

  it('applies policy downloadUrl together with policy sha256 (atomic override)', () => {
    const result = applyReleasePolicyToUpdateInfo(source, {
      channel: 'stable',
      latestVersion: '0.23.0', // 触发 policyRequiresUpdate
      downloadUrl: 'https://cdn.example/hotfix.dmg',
      sha256: 'b'.repeat(64),
    });
    expect(result.downloadUrl).toBe('https://cdn.example/hotfix.dmg');
    expect(result.sha256).toBe('b'.repeat(64));
  });

  it('clears source sha when policy downloadUrl is applied without a policy sha (fail-closed, no cross-pair)', () => {
    const result = applyReleasePolicyToUpdateInfo(source, {
      channel: 'stable',
      latestVersion: '0.23.0',
      downloadUrl: 'https://cdn.example/hotfix.dmg', // 有 url 无 sha
    });
    expect(result.downloadUrl).toBe('https://cdn.example/hotfix.dmg');
    // 源 sha 不能跟着 policy URL 走（会校验失败）；清空 → 客户端 fail-closed 拒绝
    expect(result.sha256).toBeUndefined();
  });
});
