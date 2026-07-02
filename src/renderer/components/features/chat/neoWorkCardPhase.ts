import type { NeoWorkCardStatus } from '@shared/contract/tag';

// ============================================================================
// Neo Tag 四相运行态（轻量化重设计的共享真源）
// 把 11 个内部 work card 状态收敛成用户视角的 5 个相位。审批态已砍，
// 卡片、topic 目录列表/详情共用同一映射，避免各处再造语义。
// ============================================================================

export type NeoWorkCardPhase = 'running' | 'needs_input' | 'done' | 'failed' | 'closed';

const PHASE_BY_STATUS: Record<NeoWorkCardStatus, NeoWorkCardPhase> = {
  draft: 'running',
  needs_review: 'running',
  approved: 'running',
  queued: 'running',
  working: 'running',
  waiting_for_user: 'needs_input',
  in_result_review: 'done',
  completed: 'done',
  failed: 'failed',
  cancelled: 'closed',
  archived: 'closed',
};

export const NEO_WORK_CARD_PHASE_LABEL: Record<NeoWorkCardPhase, string> = {
  running: '运行中',
  needs_input: '待你确认',
  done: '已完成',
  failed: '失败',
  closed: '已结束',
};

export const NEO_WORK_CARD_PHASE_CHIP_STYLE: Record<NeoWorkCardPhase, string> = {
  running: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  needs_input: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  done: 'border-zinc-700 bg-zinc-900 text-zinc-300',
  failed: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  closed: 'border-zinc-800 bg-zinc-950 text-zinc-500',
};

export function statusPhase(status: NeoWorkCardStatus): NeoWorkCardPhase {
  return PHASE_BY_STATUS[status] ?? 'running';
}

/** 运行中 / 待确认 = 还在活动，尚未收尾。 */
export function isActivePhase(phase: NeoWorkCardPhase): boolean {
  return phase === 'running' || phase === 'needs_input';
}

// 运行时生命周期内部标记，不是用户视角的工作项，从清单里滤掉。
const INTERNAL_COMPLETED_MARKERS = [
  /^Queued approved revision/i,
  /^Local Neo runtime run finished/i,
];

export function isInternalCompletedMarker(item: string): boolean {
  return INTERNAL_COMPLETED_MARKERS.some((pattern) => pattern.test(item.trim()));
}

// 运行时记账文案全集（neoTagRuntimeService 写进 delta 的英文生命周期字符串）。
// 它们是引擎自言自语，不是执行结果——列表摘要/详情一律不展示给用户。
const INTERNAL_RUNTIME_TEXT_MARKERS = [
  ...INTERNAL_COMPLETED_MARKERS,
  /^Review the result and accept/i,
  /^Start local runtime execution/i,
  /^Approved work card entered/i,
  /^Runtime result is ready/i,
  /^Fix the runtime\/provider error/i,
  /^Answer the pending runtime request/i,
  /^Check provider credentials/i,
  /^Runtime paused for user input/i,
  /^Context audit:/i,
];

export function isInternalRuntimeText(text: string): boolean {
  return INTERNAL_RUNTIME_TEXT_MARKERS.some((pattern) => pattern.test(text.trim()));
}
