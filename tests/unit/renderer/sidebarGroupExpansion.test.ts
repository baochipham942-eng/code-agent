import { describe, expect, it } from 'vitest';
import {
  resolveSidebarGroupExpansionView,
  resolveSidebarGroupExpanded,
  shouldForceExpandSidebarGroup,
} from '../../../src/renderer/utils/sidebarGroupExpansion';

describe('sidebarGroupExpansion', () => {
  it('keeps current, filtered, and unfinished groups expanded', () => {
    expect(shouldForceExpandSidebarGroup({
      hasCurrentSession: true,
      hasSearchFilters: false,
      unfinishedCount: 0,
    })).toBe(true);

    expect(shouldForceExpandSidebarGroup({
      hasCurrentSession: false,
      hasSearchFilters: true,
      unfinishedCount: 0,
    })).toBe(true);

    expect(shouldForceExpandSidebarGroup({
      hasCurrentSession: false,
      hasSearchFilters: false,
      unfinishedCount: 1,
    })).toBe(true);
  });

  it('lets the uncategorized group collapse even when it holds the current session (D-8)', () => {
    const forcingSignals = {
      hasCurrentSession: true,
      hasSearchFilters: false,
      unfinishedCount: 2,
    };

    // 普通项目组：被钉成展开
    expect(shouldForceExpandSidebarGroup(forcingSignals)).toBe(true);
    // 未分类组：关掉 force-expand，遵从持久折叠状态
    expect(shouldForceExpandSidebarGroup(forcingSignals, { disableForceExpand: true })).toBe(false);

    const view = resolveSidebarGroupExpansionView({
      persistedExpanded: false,
      signals: forcingSignals,
      isCollapsing: false,
      displayName: '未分类',
      disableForceExpand: true,
    });
    expect(view.forceExpanded).toBe(false);
    expect(view.isVisibleExpanded).toBe(false);
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

  it('keeps a protected group visibly expanded even when the user collapsed it', () => {
    const view = resolveSidebarGroupExpansionView({
      persistedExpanded: false,
      signals: {
        hasCurrentSession: true,
        hasSearchFilters: false,
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
