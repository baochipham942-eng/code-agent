import { describe, expect, it } from 'vitest';
import {
  resolveSidebarGroupExpansionView,
  resolveSidebarGroupExpanded,
  shouldForceExpandSidebarGroup,
} from '../../../src/renderer/utils/sidebarGroupExpansion';

describe('sidebarGroupExpansion', () => {
  it('只有搜索/筛选命中才 force-expand；当前会话与未完成不再钉死分组（2026-07-26 语义修正）', () => {
    expect(shouldForceExpandSidebarGroup({
      hasCurrentSession: true,
      hasSearchFilters: false,
      unfinishedCount: 0,
    })).toBe(false);

    expect(shouldForceExpandSidebarGroup({
      hasCurrentSession: false,
      hasSearchFilters: true,
      unfinishedCount: 0,
    })).toBe(true);

    expect(shouldForceExpandSidebarGroup({
      hasCurrentSession: false,
      hasSearchFilters: false,
      unfinishedCount: 1,
    })).toBe(false);
  });

  it('显式收起对含当前会话/未完成会话的组同样生效（用户操作赢过活动信号）', () => {
    const activeSignals = {
      hasCurrentSession: true,
      hasSearchFilters: false,
      unfinishedCount: 3,
    };

    expect(resolveSidebarGroupExpanded(false, activeSignals)).toBe(false);

    const view = resolveSidebarGroupExpansionView({
      persistedExpanded: false,
      signals: activeSignals,
      isCollapsing: false,
      displayName: 'work',
    });
    expect(view.forceExpanded).toBe(false);
    expect(view.isVisibleExpanded).toBe(false);
    expect(view.phase).toBe('collapsed');
    expect(view.toggleAriaLabel).toBe('展开 work');
  });

  it('未分类组 disableForceExpand 连搜索命中也不钉（D-8）', () => {
    expect(shouldForceExpandSidebarGroup(
      { hasCurrentSession: false, hasSearchFilters: true, unfinishedCount: 0 },
      { disableForceExpand: true },
    )).toBe(false);
  });

  it('lets completed non-current groups follow persisted collapse state', () => {
    const signals = {
      hasCurrentSession: false,
      hasSearchFilters: false,
      unfinishedCount: 0,
    };

    expect(resolveSidebarGroupExpanded(true, signals)).toBe(true);
    expect(resolveSidebarGroupExpanded(false, signals)).toBe(false);
  });

  it('搜索命中的已收起组保持可见展开并展示保护标签', () => {
    const view = resolveSidebarGroupExpansionView({
      persistedExpanded: false,
      signals: {
        hasCurrentSession: false,
        hasSearchFilters: true,
        unfinishedCount: 0,
      },
      isCollapsing: false,
      displayName: 'code-agent',
    });

    expect(view.isVisibleExpanded).toBe(true);
    expect(view.forceExpanded).toBe(true);
    expect(view.phase).toBe('forced-expanded');
    expect(view.rowsClassName).toContain('sidebar-project-rows--forced');
    expect(view.toggleAriaLabel).toContain('code-agent 保持展开');
    expect(view.protectionLabel).toBe('保持展开');
  });

  it('models the two-step collapse phase before persisting the closed state', () => {
    const view = resolveSidebarGroupExpansionView({
      persistedExpanded: true,
      signals: {
        hasCurrentSession: false,
        hasSearchFilters: false,
        unfinishedCount: 0,
      },
      isCollapsing: true,
      displayName: 'archive',
    });

    expect(view.isVisibleExpanded).toBe(true);
    expect(view.forceExpanded).toBe(false);
    expect(view.phase).toBe('collapsing');
    expect(view.rowsClassName).toContain('sidebar-project-rows--collapsing');
    expect(view.toggleAriaLabel).toBe('折叠 archive');
  });

  it('marks ordinary persisted-collapsed groups as hidden', () => {
    const view = resolveSidebarGroupExpansionView({
      persistedExpanded: false,
      signals: {
        hasCurrentSession: false,
        hasSearchFilters: false,
        unfinishedCount: 0,
      },
      isCollapsing: false,
      displayName: 'archive',
    });

    expect(view.isVisibleExpanded).toBe(false);
    expect(view.phase).toBe('collapsed');
    expect(view.toggleAriaLabel).toBe('展开 archive');
  });
});
