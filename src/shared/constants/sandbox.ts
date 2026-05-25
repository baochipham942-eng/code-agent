// ============================================================================
// 沙箱（OS 级隔离）相关常量
// ============================================================================

/**
 * OS 沙箱开关。
 * 注意：与 `tools.ts` 的 `SANDBOX`（Codex 工具超时）、`CODEX_SANDBOX`（Codex 交叉验证沙箱）
 * 都是独立机制，故用 `OS_SANDBOX` 命名避让，勿混淆。
 */
export const OS_SANDBOX = {
  /**
   * 是否在 bypassPermissions（YOLO）档对 bash 执行启用 OS 级沙箱。
   * 默认关闭，行为零变化；需显式设置 env `OS_SANDBOX_ENABLED=true` 启用。
   */
  ENABLED: process.env.OS_SANDBOX_ENABLED === 'true',
} as const;
