export interface SidebarGroupExpansionSignals {
  hasCurrentSession: boolean;
  hasSearchFilters: boolean;
  unfinishedCount: number;
}

export type SidebarGroupExpansionPhase = 'expanded' | 'collapsing' | 'collapsed' | 'forced-expanded';

export interface SidebarGroupExpansionView {
  isVisibleExpanded: boolean;
  forceExpanded: boolean;
  phase: SidebarGroupExpansionPhase;
  rowsClassName: string;
  toggleTitle: string;
  toggleAriaLabel: string;
  protectionLabel: string | null;
}

export function shouldForceExpandSidebarGroup(
  { hasCurrentSession, hasSearchFilters, unfinishedCount }: SidebarGroupExpansionSignals,
  options?: { disableForceExpand?: boolean },
): boolean {
  // D-8：未分类组关掉 force-expand，否则它常驻当前/未完成会话会被永久钉成展开、无法折叠。
  if (options?.disableForceExpand) return false;
  return hasCurrentSession || hasSearchFilters || unfinishedCount > 0;
}

export function resolveSidebarGroupExpanded(
  persistedExpanded: boolean,
  signals: SidebarGroupExpansionSignals,
  options?: { disableForceExpand?: boolean },
): boolean {
  return persistedExpanded || shouldForceExpandSidebarGroup(signals, options);
}

function getForceExpandReason({
  hasCurrentSession,
  hasSearchFilters,
  unfinishedCount,
}: SidebarGroupExpansionSignals): string {
  if (hasCurrentSession) {
    return '当前会话所在项目保持展开';
  }
  if (unfinishedCount > 0) {
    return '未完成会话所在项目保持展开';
  }
  if (hasSearchFilters) {
    return '搜索或筛选命中的项目保持展开';
  }
  return '项目保持展开';
}

export function resolveSidebarGroupExpansionView({
  persistedExpanded,
  signals,
  isCollapsing,
  displayName,
  disableForceExpand,
}: {
  persistedExpanded: boolean;
  signals: SidebarGroupExpansionSignals;
  isCollapsing: boolean;
  displayName: string;
  disableForceExpand?: boolean;
}): SidebarGroupExpansionView {
  const forceExpanded = shouldForceExpandSidebarGroup(signals, { disableForceExpand });
  const isVisibleExpanded = resolveSidebarGroupExpanded(persistedExpanded, signals, { disableForceExpand })
    || (!forceExpanded && isCollapsing);
  const phase: SidebarGroupExpansionPhase = forceExpanded
    ? 'forced-expanded'
    : isCollapsing
      ? 'collapsing'
      : isVisibleExpanded
        ? 'expanded'
        : 'collapsed';
  const forceReason = getForceExpandReason(signals);
  const phaseClassName = {
    expanded: 'sidebar-project-rows--expanded',
    collapsing: 'sidebar-project-rows--collapsing',
    collapsed: 'sidebar-project-rows--collapsed',
    'forced-expanded': 'sidebar-project-rows--forced',
  }[phase];

  return {
    isVisibleExpanded,
    forceExpanded,
    phase,
    rowsClassName: `sidebar-project-rows ${phaseClassName}`,
    toggleTitle: forceExpanded
      ? forceReason
      : isVisibleExpanded
        ? '折叠项目'
        : '展开项目',
    toggleAriaLabel: forceExpanded
      ? `${displayName} 保持展开，${forceReason}`
      : isVisibleExpanded
        ? `折叠 ${displayName}`
        : `展开 ${displayName}`,
    protectionLabel: forceExpanded && !persistedExpanded ? '保持展开' : null,
  };
}
