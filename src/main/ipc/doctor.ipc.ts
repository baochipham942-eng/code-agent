// ============================================================================
// Doctor IPC - 旧入口，保留向后兼容
// 实际检查逻辑已迁移到 src/main/diagnostics/checks/environment.ts
// runDiagnostics 现在只覆盖 environment + database + disk 子集
// 完整诊断请使用 src/main/diagnostics/doctorRunner.ts 的 runDoctor()
// ============================================================================

import {
  checkNodeVersion,
  checkConfigDir,
  checkDatabase,
  checkDiskUsage,
} from '../diagnostics/checks/environment';
import type {
  DoctorItem,
  DoctorReport,
  DiagnosticItem,
  DiagnosticReport,
} from '../diagnostics/types';

// 重新导出类型，避免破坏现有引用（如 ProviderDoctorDialog.tsx）
export type { DoctorItem, DoctorReport, DiagnosticItem, DiagnosticReport };

/**
 * @deprecated 仅保留向后兼容。新代码请直接调用 `runDoctor()`，覆盖更全。
 */
export async function runDiagnostics(): Promise<DoctorReport> {
  const startedAt = Date.now();
  const items: DoctorItem[] = [];

  items.push(checkNodeVersion());
  items.push(checkConfigDir());
  items.push(await checkDatabase());
  items.push(await checkDiskUsage());

  const summary = {
    pass: items.filter(i => i.status === 'pass').length,
    warn: items.filter(i => i.status === 'warn').length,
    fail: items.filter(i => i.status === 'fail').length,
    skip: items.filter(i => i.status === 'skip').length,
  };

  return {
    timestamp: startedAt,
    durationMs: Date.now() - startedAt,
    items,
    summary,
  };
}
