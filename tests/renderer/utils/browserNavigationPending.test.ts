import { describe, expect, it } from 'vitest';
import {
  createNavigationPending,
  failNavigationPending,
  navigationTargetSettled,
  resolveAddressDraft,
  shouldRestoreAddressOnBlur,
} from '../../../src/renderer/utils/browserNavigationPending';

describe('browserNavigationPending（N1 三态）', () => {
  it('pending：锁定归一化 URL，失焦不得还原清空', () => {
    const pending = createNavigationPending('https://example.com/', null);
    expect(pending.status).toBe('pending');
    expect(pending.url).toBe('https://example.com/');
    expect(shouldRestoreAddressOnBlur(pending)).toBe(false);
    expect(resolveAddressDraft({
      pending,
      activeUrl: null,
      editingDraft: 'example.com',
      addressEditing: false,
    })).toBe('https://example.com/');
  });

  it('成功：activeUrl 同源/完整匹配时视为落地', () => {
    expect(navigationTargetSettled('https://example.com/', 'https://example.com/')).toBe(true);
    expect(navigationTargetSettled('https://example.com', 'https://example.com/')).toBe(true);
    expect(navigationTargetSettled('https://example.com/path', 'https://example.com/')).toBe(true);
    expect(navigationTargetSettled('https://other.example/', 'https://example.com/')).toBe(false);
    expect(navigationTargetSettled(null, 'https://example.com/')).toBe(false);
  });

  it('失败：保留错误信息并允许还原 previousUrl', () => {
    const pending = createNavigationPending('https://bad.example/', 'https://good.example/');
    const failed = failNavigationPending(pending, '导航失败');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('导航失败');
    expect(failed.previousUrl).toBe('https://good.example/');
    // 失败态仍属 pending 记录，失焦不抢写空值；由 UI 显式还原。
    expect(shouldRestoreAddressOnBlur(failed)).toBe(false);
  });

  it('无 pending 时失焦可还原 activeUrl', () => {
    expect(shouldRestoreAddressOnBlur(null)).toBe(true);
    expect(resolveAddressDraft({
      pending: null,
      activeUrl: 'https://settled.example/',
      editingDraft: 'draft',
      addressEditing: false,
    })).toBe('https://settled.example/');
  });
});
