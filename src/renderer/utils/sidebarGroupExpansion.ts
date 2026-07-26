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
  { hasSearchFilters }: SidebarGroupExpansionSignals,
  options?: { disableForceExpand?: boolean },
): boolean {
  // 2026-07-26 语义修正：force-expand 只保留给搜索/筛选命中（临时视图态）。
  // 当前会话/未完成会话不再钉死分组——默认本来就是展开（isWorkspaceExpanded
  // 缺省 true），persisted false 只可能来自用户显式收起，显式操作必须赢，
  // 否则任何有活动的分组永久无法收起（D-8 在未分类组修过一次的同款病，全量修掉）。
  // 未完成信号仍由分组头的色球+数字承载，收起不丢信息。
  if (options?.disableForceExpand) return false;
  return hasSearchFilters;
}

export function resolveSidebarGroupExpanded(
  persistedExpanded: boolean,
  signals: SidebarGroupExpansionSignals,
  options?: { disableForceExpand?: boolean },
): boolean {
  return persistedExpanded || shouldForceExpandSidebarGroup(signals, options);
}

function getForceExpandReason(_signals: SidebarGroupExpansionSignals): string {
  // force-expand 现在只有搜索/筛选一个来源（见 shouldForceExpandSidebarGroup）。
  // 措辞避开「命中」二字：搜索态的 DOM 断言用它排查旧版计数 chip 回归。
  return '搜索/筛选结果所在项目保持展开';
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
