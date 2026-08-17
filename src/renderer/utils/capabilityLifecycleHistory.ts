// ============================================================================
// 装卸历史投影（N-LEDGER-P5）—— 能力中心「装卸历史」tab 的纯函数层
// ----------------------------------------------------------------------------
// 输入是 fetchSessionTrace('capability-runtime') 整读回来的开放包络事件，
// 输出按能力单元分组、组内按时间倒序的时间线视图模型。
//
// 与 host 读侧同一策略：包络是开放的，脏行 / 未知 action / 缺字段一律安静
// 丢弃并计数（dropped），不 throw、不臆造——写方可能先于本进程升级。
//
// renderer 侧不 import host 的 TraceEventDataMap（renderer/host 边界纪律），
// 这里自己写窄类型，字段口径对齐 turnTrace.ts 的 capability_lifecycle 槽位。
// ============================================================================

import type { TraceLedgerEvent } from '../services/traceLedgerClient';

export type CapabilityLifecycleAction = 'loaded' | 'unloaded' | 'rolled_back' | 'failed';

const ACTIONS: ReadonlySet<string> = new Set(['loaded', 'unloaded', 'rolled_back', 'failed']);

export interface CapabilityLifecycleEntry {
  capabilityKey: string;
  action: CapabilityLifecycleAction;
  /** host 的 error.message，原文展示（不翻译不加工）；仅 failed 一般带 */
  detail?: string;
  /** 事件时间戳（毫秒）。包络 ts 缺失/非数时按 0 处理，排到组内末尾 */
  ts: number;
}

export interface CapabilityLifecycleGroup {
  capabilityKey: string;
  /** 组内最新 ts，用于组间排序 */
  latestTs: number;
  /** 组内按 ts 倒序（最新在前） */
  entries: CapabilityLifecycleEntry[];
}

export interface CapabilityLifecycleHistory {
  groups: CapabilityLifecycleGroup[];
  /** 被安静丢弃的脏行数（非 capability_lifecycle、data 非对象、未知 action、缺 key） */
  dropped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function narrowEntry(event: TraceLedgerEvent): CapabilityLifecycleEntry | null {
  if (event.type !== 'capability_lifecycle') return null;
  if (!isRecord(event.data)) return null;
  const { capabilityKey, action, detail } = event.data;
  if (typeof capabilityKey !== 'string' || !capabilityKey) return null;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return null;
  return {
    capabilityKey,
    action: action as CapabilityLifecycleAction,
    detail: typeof detail === 'string' && detail ? detail : undefined,
    ts: typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : 0,
  };
}

/**
 * 投影：过滤 → 收窄 → 按 capabilityKey 分组。
 * 组内按 ts 倒序；组间按「组内最新 ts」倒序（最近动过的能力排最前）。
 */
export function projectCapabilityLifecycleHistory(
  events: readonly TraceLedgerEvent[],
): CapabilityLifecycleHistory {
  const byKey = new Map<string, CapabilityLifecycleEntry[]>();
  let dropped = 0;
  for (const event of events) {
    const entry = narrowEntry(event);
    if (!entry) {
      dropped += 1;
      continue;
    }
    const bucket = byKey.get(entry.capabilityKey);
    if (bucket) bucket.push(entry);
    else byKey.set(entry.capabilityKey, [entry]);
  }
  const groups: CapabilityLifecycleGroup[] = [];
  for (const [capabilityKey, entries] of byKey) {
    entries.sort((a, b) => b.ts - a.ts);
    groups.push({ capabilityKey, latestTs: entries[0].ts, entries });
  }
  groups.sort((a, b) => b.latestTs - a.latestTs);
  return { groups, dropped };
}
