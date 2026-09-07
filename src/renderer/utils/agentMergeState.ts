// ============================================================================
// agentMergeState - 「合到一起了没」判定（N-L6-AGENTVIEW S5 / N-MERGEDCHIP-READONLY）
// ----------------------------------------------------------------------------
// 协作者语言；其余情况返回 null（不显示）：
//   conflict：有所有权冲突（两处改到同一个地方）
//   waiting：有代理卡住了在等你（waiting_input/stalled/blocked）
//   merged：≥2 个代理全部完成、无冲突，且有真实文件改动
//   reported：≥2 个代理全部完成、无冲突，但无 worktree / 0 改动（只读 explore）
// ============================================================================

import type { AgentTreeOwnershipConflict } from '@shared/contract/agentTree';
import type { AgentRowStatus } from './agentRows';

export type AgentMergeState = 'merged' | 'reported' | 'conflict' | 'waiting';

interface MergeStateRow {
  status: AgentRowStatus;
  roleId?: string;
  filesChanged?: readonly string[];
  node?: {
    role?: string;
    worktreeState?: { status?: string; changedFiles?: readonly unknown[] };
  };
}

/** Swarm 账本 filesChanged 或 worktree.changedFiles 任一非空 = 有真实改动。 */
function rowHasFileChanges(row: MergeStateRow): boolean {
  if ((row.filesChanged?.length ?? 0) > 0) return true;
  return (row.node?.worktreeState?.changedFiles?.length ?? 0) > 0;
}

/** 内置只读角色（与 host BUILTIN_TOOL_READONLY_ROLES 对齐，不从 host 倒进口）。 */
const READONLY_ROLES = new Set(['explore', 'explorer', 'reviewer']);

function rowIsReadonlyRole(row: MergeStateRow): boolean {
  const role = (row.roleId ?? row.node?.role ?? '').toLowerCase();
  return READONLY_ROLES.has(role);
}

export function deriveAgentMergeState(
  rows: ReadonlyArray<MergeStateRow>,
  conflicts: readonly AgentTreeOwnershipConflict[],
): AgentMergeState | null {
  if (conflicts.length > 0) return 'conflict';
  // 待命（预选名单）还没开工，不参与「合没合」
  const active = rows.filter((row) => row.status !== 'standby');
  if (active.some((row) => row.status === 'waiting')) return 'waiting';
  if (active.length >= 2 && active.every((row) => row.status === 'done')) {
    if (active.some(rowHasFileChanges)) return 'merged';
    // 完成事件经常不填 filesChanged。缺记录 ≠ 零改动：普通角色保持 merged。
    // 只读 explore/reviewer 默认无 worktree（ROLE_DEFAULT_ISOLATION explorer=none），
    // 全员只读且无改动证据才报已汇报。
    return active.every(rowIsReadonlyRole) ? 'reported' : 'merged';
  }
  return null;
}
