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

/**
 * 分组头展开/收起相关文案。本文件是纯工具（不依赖 i18n hook），
 * 词条由调用方（SidebarProjectGroup，持有 t）按当前语言注入——禁硬编码。
 */
export interface SidebarGroupExpansionLabels {
  /** force-expand 原因说明（搜索/筛选命中时）。 */
  forceExpandReason: string;
  /** 收起/展开按钮的 tooltip。 */
  collapseTitle: string;
  expandTitle: string;
  /** aria 模板，{name} 替换为分组显示名。 */
  collapseAriaLabel: string;
  expandAriaLabel: string;
  /** force-expand aria 模板，{name}/{reason} 双占位。 */
  forceExpandAriaLabel: string;
  /** force-expand 且用户曾显式收起时的保护标签。 */
  protectionLabel: string;
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

function fillName(template: string, displayName: string): string {
  return template.replace('{name}', displayName);
}

export function resolveSidebarGroupExpansionView({
  persistedExpanded,
  signals,
  isCollapsing,
  displayName,
  disableForceExpand,
  labels,
}: {
  persistedExpanded: boolean;
  signals: SidebarGroupExpansionSignals;
  isCollapsing: boolean;
  displayName: string;
  disableForceExpand?: boolean;
  labels: SidebarGroupExpansionLabels;
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
      ? labels.forceExpandReason
      : isVisibleExpanded
        ? labels.collapseTitle
        : labels.expandTitle,
    toggleAriaLabel: forceExpanded
      ? fillName(labels.forceExpandAriaLabel, displayName).replace('{reason}', labels.forceExpandReason)
      : isVisibleExpanded
        ? fillName(labels.collapseAriaLabel, displayName)
        : fillName(labels.expandAriaLabel, displayName),
    protectionLabel: forceExpanded && !persistedExpanded ? labels.protectionLabel : null,
  };
}
