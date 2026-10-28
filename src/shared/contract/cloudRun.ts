// ============================================================================
// Cloud run ledger contract — ADR-086 slice S1（持久云端 run 行）
// ============================================================================
// 云端 run 账本的可共享合同：状态词汇、触发来源、迁移表与准入稳定码。
// 与桌面 durable_runs（ADR-037，created/running/…/completed/failed/cancelled）
// 是两套词汇，互不借用：账本行带 account/workspace 维度（schemaCloudRunLedger
// 建表），本文件不放行结构——行与迁移记录的类型在 CloudRunRepository 上。
// 迁移表是终态守卫的唯一事实源：终态行出边为空，别处不要再叠行为性守卫，
// 否则反向变异（改表必须真红）会被第二层守卫挡成假绿。
// ============================================================================

export type CloudRunTrigger = 'manual' | 'cron' | 'channel' | 'delegate';

export const CLOUD_RUN_TRIGGERS = ['manual', 'cron', 'channel', 'delegate'] as const satisfies readonly CloudRunTrigger[];

export type CloudRunState =
  | 'queued' // 已登记未执行，不在飞、不占配额（ADR-086 合同 6）
  | 'running'
  | 'waiting-approval' // 停车（ADR-082）：等人的是同一 run，不是终态
  | 'waiting-reconnect'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'
  | 'abandoned';

/** queued 不算在飞（ADR-086 术语表：排队中的不算）。 */
const CLOUD_RUN_NON_TERMINAL_STATES = ['queued', 'running', 'waiting-approval', 'waiting-reconnect'] as const satisfies readonly CloudRunState[];

const CLOUD_RUN_TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted', 'abandoned'] as const satisfies readonly CloudRunState[];

/** 全状态集，schema 的 state CHECK 由它生成，与迁移表同源。 */
export const CLOUD_RUN_STATES = [...CLOUD_RUN_NON_TERMINAL_STATES, ...CLOUD_RUN_TERMINAL_STATES] as const satisfies readonly CloudRunState[];

/**
 * 状态迁移表。终态出边为空（ADR-086 合同 4：终态一经写下不再回在飞）；
 * waiting-approval 可回 running（ADR-082：批准之后继续同一 run）；
 * parking/reconnect 不直达 succeeded——成功必须先回到 running 执行完。
 */
const CLOUD_RUN_STATE_TRANSITIONS: Readonly<Record<CloudRunState, readonly CloudRunState[]>> = Object.freeze({
  queued: ['running', 'failed', 'cancelled', 'abandoned'],
  running: [
    'waiting-approval',
    'waiting-reconnect',
    'succeeded',
    'failed',
    'cancelled',
    'timed_out',
    'interrupted',
    'abandoned',
  ],
  'waiting-approval': ['running', 'failed', 'cancelled', 'timed_out', 'interrupted', 'abandoned'],
  'waiting-reconnect': ['running', 'failed', 'cancelled', 'timed_out', 'interrupted', 'abandoned'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  interrupted: [],
  abandoned: [],
});

export function canTransitionCloudRunState(from: CloudRunState, to: CloudRunState): boolean {
  return CLOUD_RUN_STATE_TRANSITIONS[from].includes(to);
}

export function isTerminalCloudRunState(state: CloudRunState): boolean {
  return (CLOUD_RUN_TERMINAL_STATES as readonly CloudRunState[]).includes(state);
}

/**
 * 「没有已验证账户则拒绝创建 run」的自有稳定码（ADR-086 合同 1）。
 * accountId 只能来自服务端验证结果，请求体里的用户字段不成为账户。
 */
export const CLOUD_RUN_ACCOUNT_REQUIRED = 'CLOUD_RUN_ACCOUNT_REQUIRED';

export class CloudRunAccountRequiredError extends Error {
  readonly code = CLOUD_RUN_ACCOUNT_REQUIRED;

  constructor(options?: { cause?: unknown }) {
    super('Cloud run creation requires a verified account', options);
    this.name = 'CloudRunAccountRequiredError';
  }
}
