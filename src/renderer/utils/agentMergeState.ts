// ============================================================================
// agentMergeState - 「合到一起了没」三态判定（N-L6-AGENTVIEW S5）
// ----------------------------------------------------------------------------
// 协作者语言，只有三态；其余情况返回 null（不显示，不铺第四句）：
//   conflict：有所有权冲突（两处改到同一个地方）
//   waiting：有代理卡住了在等你（waiting_input/stalled/blocked）
//   merged：≥2 个代理且全部完成、无冲突
// ============================================================================

import type { AgentTreeOwnershipConflict } from '@shared/contract/agentTree';
import type { AgentRowStatus } from './agentRows';

export type AgentMergeState = 'merged' | 'conflict' | 'waiting';

export function deriveAgentMergeState(
  rows: ReadonlyArray<{ status: AgentRowStatus }>,
  conflicts: readonly AgentTreeOwnershipConflict[],
): AgentMergeState | null {
  if (conflicts.length > 0) return 'conflict';
  // 待命（预选名单）还没开工，不参与「合没合」
  const active = rows.filter((row) => row.status !== 'standby');
  if (active.some((row) => row.status === 'waiting')) return 'waiting';
  if (active.length >= 2 && active.every((row) => row.status === 'done')) return 'merged';
  return null;
}
