// ============================================================================
// Doctor 诊断 - renderer 侧类型
// 与 src/host/diagnostics/types.ts 同构（host 是唯一真源，此处仅作渲染层镜像，
// renderer 不跨层 import host）。fix code 常量直接复用 @shared/constants/doctor。
// ============================================================================

import type { DoctorFixCode } from '@shared/constants/doctor';

export const DOCTOR_CATEGORY_ORDER = [
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

export type DoctorCategory = (typeof DOCTOR_CATEGORY_ORDER)[number];

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorItem {
  category: DoctorCategory;
  name: string;
  status: DoctorStatus;
  message: string;
  details?: string;
  suggestion?: string;
  durationMs?: number;
  fix?: { code: DoctorFixCode };
}

export interface DoctorReport {
  timestamp: number;
  durationMs: number;
  items: DoctorItem[];
  summary: { pass: number; warn: number; fail: number; skip: number };
}

export interface RunDoctorOptions {
  category?: DoctorCategory;
  skipNetwork?: boolean;
  perCheckTimeoutMs?: number;
  overallTimeoutMs?: number;
}

/** 有 fail 项才亮侧栏徽标（不打扰原则：warn 不亮、全绿不亮）。类型谓词：为真时 report 非空 */
export function hasDoctorFailures(report: DoctorReport | null | undefined): report is DoctorReport {
  return (report?.summary.fail ?? 0) > 0;
}

/** 单类重检后把该类的最新 items 合并回整报告，并重算 summary */
export function mergeDoctorCategoryReport(
  base: DoctorReport | null,
  category: DoctorCategory,
  partial: DoctorReport,
): DoctorReport {
  const kept = (base?.items ?? []).filter((item) => item.category !== category);
  const items = [...kept, ...partial.items];
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const item of items) summary[item.status] += 1;
  return {
    timestamp: partial.timestamp,
    durationMs: partial.durationMs,
    items,
    summary,
  };
}
