// ============================================================================
// Doctor Diagnostics - 共享类型定义
// ============================================================================

import type { DoctorFixCode } from '../../shared/constants/doctor';

/**
 * Doctor 检查项分类（与 DOCTOR_CATEGORIES 数组同构）
 * - environment / database / config / disk: 来自原 doctor.ipc.ts
 * - network: API 连通性测试
 * - provider_health: provider 健康监控
 * - mcp: MCP server 状态
 * - hooks: hooks 配置校验
 * - version: 应用版本检查
 */
export const DOCTOR_CATEGORIES = [
  'environment',
  'database',
  'config',
  'disk',
  'network',
  'provider_health',
  'mcp',
  'hooks',
  'version',
] as const;

export type DoctorCategory = (typeof DOCTOR_CATEGORIES)[number];

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
  /**
   * 前端可解释的修复动作码。完整清单：
   * - open-runtime-help
   * - open-data-directory
   * - open-provider-settings
   * - open-proxy-help
   * - open-mcp-settings
   * - open-browser-relay-settings
   * - open-hooks-settings
   * - open-update-settings
   */
  fix?: { code: DoctorFixCode };
}

export interface DoctorReport {
  timestamp: number;
  durationMs: number;
  items: DoctorItem[];
  summary: { pass: number; warn: number; fail: number; skip: number };
}

/**
 * `runDoctor()` 调用选项
 */
export interface RunDoctorOptions {
  /** 仅运行指定分类；不传时运行全部分类 */
  category?: DoctorCategory;
  /** 跳过需要网络的 check（network / version）。CLI 默认 false，启动检查可传 true */
  skipNetwork?: boolean;
  /** 单项 check 超时（毫秒），默认 10s */
  perCheckTimeoutMs?: number;
  /** 整份报告超时（毫秒），默认 30s；超时后未完成项以 warn 返回 */
  overallTimeoutMs?: number;
}
