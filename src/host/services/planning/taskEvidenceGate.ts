// ============================================================================
// 任务证据门（ADR-050）— 工具入口共用的单一收口点
//
// TaskManager 有三条写状态的路径（update / replace / patch）。校验和证据落盘都
// 在这里做，三处调同一个函数——分别实现迟早漏一条，模型就从没设门的那条路完成任务。
// ============================================================================

import type { UpdateTaskInput } from '../../../shared/contract/planning';
import { validateTaskStatusEvidence } from '../../../shared/contract/planning';
import { makeEvidenceRef } from '../../../shared/contract/evidence';
import { describeTaskBlockedReason, sanitizeTaskEvidenceText } from '../../../shared/taskReasonLanguage';

export interface TaskEvidenceArgs {
  status?: unknown;
  completionEvidence?: unknown;
  blockedReason?: unknown;
  cancelReason?: unknown;
}

export type TaskEvidenceResult =
  | { ok: true; updates: Partial<UpdateTaskInput> }
  | { ok: false; error: string };

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 校验状态所需证据，并把它翻成落盘用的字段。
 *
 * @param source EvidenceRef 的来源标识（工具名 + 任务 id）
 */
export function buildTaskEvidenceUpdates(
  args: TaskEvidenceArgs,
  source: string,
): TaskEvidenceResult {
  const error = validateTaskStatusEvidence(args.status, args);
  if (error) {
    return { ok: false, error };
  }

  const updates: Partial<UpdateTaskInput> = {};

  if (args.status === 'completed') {
    const raw = readText(args.completionEvidence);
    updates.evidenceRefs = [
      makeEvidenceRef({
        kind: 'tool',
        ref: sanitizeTaskEvidenceText(raw),
        source,
        state: 'read',
      }),
    ];
    updates.statusSummary = raw;
  }

  if (args.status === 'blocked') {
    const raw = readText(args.blockedReason);
    const described = describeTaskBlockedReason(raw);
    updates.blockedReason = described.reason;
    updates.blockedReasonCategory = described.category;
    updates.statusSummary = raw;
  }

  if (args.status === 'cancelled') {
    const raw = readText(args.cancelReason);
    if (raw) updates.statusSummary = raw;
  }

  return { ok: true, updates };
}
