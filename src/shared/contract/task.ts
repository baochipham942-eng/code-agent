/**
 * MasterTask 状态枚举（用户级工作单元）
 * 对应 Qoder Quest 13 状态机
 */
export type MasterTaskStatus =
  | 'created'
  | 'pending'
  | 'queued'
  | 'waiting'
  | 'running'
  | 'paused'
  | 'review'
  | 'completed'
  | 'done'
  | 'cancelled'
  | 'failed'
  | 'error';

/** 所有 MasterTaskStatus 字面量的运行时数组（用于 SQL CHECK / 校验） */
export const MASTER_TASK_STATUSES: readonly MasterTaskStatus[] = [
  'created', 'pending', 'queued', 'waiting', 'running', 'paused',
  'review', 'completed', 'done', 'cancelled', 'failed', 'error',
] as const;

/** 终态：进入后不再转换 */
export const MASTER_TASK_TERMINAL_STATUSES: ReadonlySet<MasterTaskStatus> = new Set([
  'completed', 'done', 'cancelled', 'failed', 'error',
]);
