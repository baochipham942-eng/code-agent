// ============================================================================
// 沙箱（OS 级隔离）相关常量
// ============================================================================

/**
 * OS 沙箱开关。
 * 注意：与 `tools.ts` 的 `SANDBOX`（Codex 工具超时）、`CODEX_SANDBOX`（Codex 交叉验证沙箱）
 * 都是独立机制，故用 `OS_SANDBOX` 命名避让，勿混淆。
 *
 * 默认开启。`OS_SANDBOX_ENABLED=false` 是紧急关闭（write-fence 除外），不是日常开关。
 * 读 env 必须在调用时发生：import-time 常量会让反向变异测不到「关 env」。
 */
export function isOsSandboxEnabled(): boolean {
  if (typeof process === 'undefined') return true;
  return process.env.OS_SANDBOX_ENABLED !== 'false';
}

/** Doctor / 设置页用的稳定检查项名；渲染层按 name 查找，不要改字符串。 */
export const OS_SANDBOX_DOCTOR_ITEM_NAME = 'OS sandbox';

/**
 * 稳定原因码。host 只传 code，文案在 renderer i18n。
 * 新增码必须同时登记 agentError / decisionCard。
 */
export const OS_SANDBOX_CODES = {
  APPLIED: 'OS_SANDBOX_APPLIED',
  DEGRADED_UNSANDBOXABLE: 'OS_SANDBOX_DEGRADED_UNSANDBOXABLE',
  DEGRADED_UNAVAILABLE: 'OS_SANDBOX_DEGRADED_UNAVAILABLE',
  DEGRADED_DISABLED: 'OS_SANDBOX_DEGRADED_DISABLED',
  UNAVAILABLE: 'SANDBOX_UNAVAILABLE',
  MODE_NOT_IN_ROLLOUT: 'OS_SANDBOX_MODE_NOT_IN_ROLLOUT',
} as const;

export type OsSandboxCode = (typeof OS_SANDBOX_CODES)[keyof typeof OS_SANDBOX_CODES];

/** 灰度翻默认覆盖的日常档。bypass / unattended / write-fence / eval / 多根仍走强制沙箱。 */
export const OS_SANDBOX_ROLLOUT_MODES = ['default', 'acceptEdits'] as const;
