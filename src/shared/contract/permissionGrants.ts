// ============================================================================
// 统一授权台账（N-PERM-GRANT-LEDGER）—— 三个「允许」存档的归一视图
// ============================================================================
// 三个后端（app_permission_grants 表 / automation config_json.standingGrants /
// ConfirmationGate 内存 sessionApprovals）各自的记录，都折成这一个形状给设置页
// 「你授权过的权限」列表消费。id 是撤销键：`<variant>:<uri-encoded 分段>`，段内
// 冒号已转义，split(':') 无歧义（grantLedger.ts 是 id 的唯一拼/拆点）。

/** 授权条目的种类：按应用的操作授权 / automation 上的 (tool,target) 长期授权 / 会话内工具放行。 */
type PermissionGrantKind = 'app' | 'tool-target' | 'tool-session';

/**
 * 归一化授权条目。
 * - label：给用户看的「是什么」（应用名或工具名）
 * - detail：缩窄信息（bundleId / standing 授权的 target），可缺省
 * - source：'conversation'（本次对话）| 'settings'（始终允许）| automation 标题
 * - expiresAt：null = 不过期；已过期条目不列出也不匹配
 */
export interface PermissionGrantEntry {
  id: string;
  kind: PermissionGrantKind;
  label: string;
  detail?: string;
  source: string;
  grantedAt: number;
  expiresAt: number | null;
}
