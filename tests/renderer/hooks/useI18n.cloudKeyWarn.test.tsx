// 云端扁平 kv 的缺 key 告警：云端 key 不在内置文案树里 = 配置错位/过期，
// 必须留痕（降级留痕规则），但不弹窗、不拦渲染。
// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appStoreState = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  setLanguage: vi.fn(),
  cloudUIStrings: null as Record<string, Record<string, string>> | null,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => appStoreState,
}));

import { useI18n } from '../../../src/renderer/hooks/useI18n';

describe('useI18n 云端 kv 缺 key 告警', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appStoreState.language = 'zh';
    appStoreState.cloudUIStrings = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('云端 key 不在内置文案树里时 warn 留痕（含 key 名与语言）', () => {
    appStoreState.cloudUIStrings = {
      zh: { 'common.save': '存', 'typo.key.notExists': 'x' },
    };
    renderHook(() => useI18n());

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('typo.key.notExists');
    expect(message).not.toContain('common.save'); // 有效 key 不点名
    expect(message).toContain('zh');
  });

  it('云端 key 全部命中内置树时不告警', () => {
    appStoreState.cloudUIStrings = { zh: { 'common.save': '存' } };
    renderHook(() => useI18n());

    expect(warn).not.toHaveBeenCalled();
  });

  it('cloudUIStrings 为 null（没有云端层）时不告警', () => {
    renderHook(() => useI18n());

    expect(warn).not.toHaveBeenCalled();
  });

  it('当前语言的 kv 为空对象时不告警', () => {
    appStoreState.cloudUIStrings = { en: { 'typo.onlyInEn': 'x' }, zh: {} };
    renderHook(() => useI18n());

    expect(warn).not.toHaveBeenCalled();
  });
});
