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
  filesChanged?: readonly string[];
  node?: { worktreeState?: { status?: string; changedFiles?: readonly unknown[] } };
}

/** Swarm 账本 filesChanged 或 worktree.changedFiles 任一非空 = 有真实改动。 */
function rowHasFileChanges(row: MergeStateRow): boolean {
  if ((row.filesChanged?.length ?? 0) > 0) return true;
  return (row.node?.worktreeState?.changedFiles?.length ?? 0) > 0;
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
    return active.some(rowHasFileChanges) ? 'merged' : 'reported';
  }
  return null;
}
