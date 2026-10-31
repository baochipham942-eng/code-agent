// @vitest-environment jsdom
// ============================================================================
// N-EXTHISTORY-IMPORT-CHATS-RESUME-FU2-FU1 —— openBudgetSettings 迟到定时器守卫：
// 0/200ms 两段 focus 定时器晚于使用它的环境（jsdom 卸载）才 fire 时变成 no-op，
// 生产 happy path（document 在、section 在）不受守卫影响。只走公开导出。
// （与 cronCloudSettingsNavigation 兄弟测试同构；guard 本体见 PR #2655 同款修复。）
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openBudgetSettings } from '../../../src/renderer/utils/budgetSettingsNavigation';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('openBudgetSettings late-timer guard (FU2-FU1)', () => {
  let openSettingsTab: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    openSettingsTab = vi.fn();
    useAppStore.setState({ openSettingsTab } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('document 不可用（环境已卸载）→ 定时器跑到 250ms 也不 throw，导航行为不受守卫影响', () => {
    openBudgetSettings();
    expect(openSettingsTab).toHaveBeenCalledTimes(1);
    expect(openSettingsTab).toHaveBeenCalledWith('general');
    vi.stubGlobal('document', undefined);
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
  });

  it('document stub 含 section 元素 → 两段定时器跑完后 focus/scrollIntoView 各被调用（0ms+200ms two-shot）', () => {
    const focus = vi.fn();
    const scrollIntoView = vi.fn();
    vi.stubGlobal('document', {
      getElementById: (id: string) => (id === 'budget-settings-section' ? { id, focus, scrollIntoView } : null),
    });
    openBudgetSettings();
    vi.advanceTimersByTime(250);
    expect(focus).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
  });
});
