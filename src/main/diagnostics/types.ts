// ============================================================================
// Doctor Diagnostics - 共享类型定义
// ============================================================================

/**
 * Doctor 检查项分类
 * - environment / database / config / disk: 来自原 doctor.ipc.ts
 * - network: API 连通性测试
 * - provider_health: provider 健康监控
 * - mcp: MCP server 状态
 * - hooks: hooks 配置校验
 * - version: 应用版本检查
 */
export type DoctorCategory =
  | 'environment'
  | 'database'
  | 'config'
  | 'disk'
  | 'network'
  | 'provider_health'
  | 'mcp'
  | 'hooks'
  | 'version';

/**
 * Doctor 检查项状态
 * - skip: 不计入 pass/warn/fail（如 lazy MCP server / 未配置 API Key 的 provider）
 */
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorItem {
  category: DoctorCategory;
  name: string;
  status: DoctorStatus;
  message: string;
  details?: string;
  /** 失败时给的修复建议 */
  suggestion?: string;
  /** 本项耗时，便于定位慢检查 */
  durationMs?: number;
}

export interface DoctorReport {
  timestamp: number;
  durationMs: number;
  items: DoctorItem[];
  summary: { pass: number; warn: number; fail: number; skip: number };
}

/**
 * 向后兼容别名：原 DiagnosticItem / DiagnosticReport 已被多处引用
 */
export type DiagnosticItem = DoctorItem;
export type DiagnosticReport = DoctorReport;
