// @vitest-environment jsdom
// ============================================================================
// N-EXTHISTORY-IMPORT-CHATS-RESUME-FU2 —— openCloudCronSettings 迟到定时器守卫：
// 0/200ms 两段 focus 定时器晚于使用它的环境（jsdom 卸载）才 fire 时变成 no-op，
// 生产 happy path（document 在、section 在）不受守卫影响。只走公开导出。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCloudCronSettings } from '../../../src/renderer/utils/cronCloudSettingsNavigation';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('openCloudCronSettings late-timer guard (FU2)', () => {
  let openSettingsWithReturn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    openSettingsWithReturn = vi.fn();
    useAppStore.setState({ openSettingsWithReturn } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('document 不可用（环境已卸载）→ 定时器跑到 250ms 也不 throw，导航行为不受守卫影响', () => {
    openCloudCronSettings();
    expect(openSettingsWithReturn).toHaveBeenCalledTimes(1);
    vi.stubGlobal('document', undefined);
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
  });

  it('document stub 含 section 元素 → 两段定时器跑完后 focus 被调用（0ms+200ms two-shot 各一次）', () => {
    const focus = vi.fn();
    const scrollIntoView = vi.fn();
    vi.stubGlobal('document', {
      getElementById: (id: string) => (id === 'cron-cloud-settings-section' ? { id, focus, scrollIntoView } : null),
    });
    openCloudCronSettings();
    vi.advanceTimersByTime(250);
    expect(focus).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
  });
});
