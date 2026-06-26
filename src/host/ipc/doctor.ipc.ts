// ============================================================================
// Doctor IPC - 旧入口，保留向后兼容
// 实际检查逻辑已迁移到 src/host/diagnostics/checks/*。
// runDiagnostics 现在委托 runDoctor 并按 environment+database+config+disk
// 过滤，保证"4 项快速诊断"和完整诊断走同一根真理。
// 新代码请直接调用 `src/host/diagnostics/doctorRunner.ts` 的 `runDoctor()`。
// ============================================================================

import { runDoctor } from '../diagnostics/doctorRunner';
import type {
  DoctorItem,
  DoctorReport,
} from '../diagnostics/types';

// 重新导出类型，方便老的 import 路径继续可用
export type { DoctorItem, DoctorReport };

/** 旧"快速诊断"包含的 category 子集（保持与改造前一致） */
const LEGACY_CATEGORIES: DoctorItem['category'][] = [
  'environment',
  'database',
  'config',
  'disk',
];

/**
 * @deprecated 仅保留向后兼容。新代码请直接调用 `runDoctor()`，覆盖更全。
 *
 * 实现方式：调 runDoctor({ skipNetwork: true }) 后只保留 4 个旧 category。
 * 这样新增 check 不会再让旧入口和新入口结果漂移。
 */
export async function runDiagnostics(): Promise<DoctorReport> {
  const full = await runDoctor({ skipNetwork: true });
  const items = full.items.filter((i) => LEGACY_CATEGORIES.includes(i.category));
  const summary = {
    pass: items.filter((i) => i.status === 'pass').length,
    warn: items.filter((i) => i.status === 'warn').length,
    fail: items.filter((i) => i.status === 'fail').length,
    skip: items.filter((i) => i.status === 'skip').length,
  };
  return {
    timestamp: full.timestamp,
    durationMs: full.durationMs,
    items,
    summary,
  };
}
