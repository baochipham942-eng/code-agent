// ============================================================================
// sidebarSessionTiers —— 侧栏历史会话三分区（ADR-053 词表落地，批P 第三波）。
// 判据单一真源（禁止 UI 层各自猜）：
//   group.projectId 为空                → 'quick'（快速对话，散会话）
//   project.spacePromotedAt 非空        → 'space'（协作空间，项目的升级形态）
//   其余（有 projectId、未升级）        → 'project'（独立空间）
// meta 尚未拉回的组先按 'project' 落位，meta 到达后重算即可——与分组名/摘要同款异步语义。
// ============================================================================

import type { SidebarProjectMeta } from './sidebarProjectSummary';
import type { WorkspaceGroup } from './workspaceGrouping';

export type SidebarSessionTier = 'space' | 'project' | 'quick';

/** 分区顺序固定：协作空间 → 独立空间 → 快速对话（ADR-053）。 */
export const SIDEBAR_SESSION_TIER_ORDER: readonly SidebarSessionTier[] = ['space', 'project', 'quick'];

export interface SidebarSessionTierSection {
  tier: SidebarSessionTier;
  groups: WorkspaceGroup[];
  /** 分区内会话总数（过滤态下即命中数），节头计数用。 */
  sessionCount: number;
}

export function resolveSidebarGroupTier(
  group: Pick<WorkspaceGroup, 'projectId'>,
  projectMetaById: Record<string, SidebarProjectMeta>,
): SidebarSessionTier {
  const projectId = group.projectId?.trim();
  if (!projectId) {
    return 'quick';
  }
  return projectMetaById[projectId]?.spacePromotedAt != null ? 'space' : 'project';
}

/**
 * 分组归位到三分区：只重排组的分桶，**组间相对顺序与组内会话排序一律不动**
 * （沿用 groupByWorkspace 的活动度排序；过滤态下「命中即显」的过滤结果同样按 tier 归位）。
 * 空分区整节省略（含节头）——返回数组里根本没有它。
 */
export function buildSidebarSessionTierSections(
  groups: WorkspaceGroup[],
  projectMetaById: Record<string, SidebarProjectMeta>,
): SidebarSessionTierSection[] {
  const byTier = new Map<SidebarSessionTier, WorkspaceGroup[]>();
  for (const group of groups) {
    const tier = resolveSidebarGroupTier(group, projectMetaById);
    const bucket = byTier.get(tier);
    if (bucket) {
      bucket.push(group);
    } else {
      byTier.set(tier, [group]);
    }
  }
  return SIDEBAR_SESSION_TIER_ORDER.flatMap((tier) => {
    const tierGroups = byTier.get(tier);
    if (!tierGroups || tierGroups.length === 0) return [];
    return [
      {
        tier,
        groups: tierGroups,
        sessionCount: tierGroups.reduce((total, group) => total + group.sessions.length, 0),
      },
    ];
  });
}
