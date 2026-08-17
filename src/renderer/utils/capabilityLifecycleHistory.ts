// ============================================================================
// 装卸历史投影（N-LEDGER-P5）—— 能力中心「装卸历史」tab 的纯函数层
// ----------------------------------------------------------------------------
// 输入是 fetchSessionTrace('capability-runtime') 整读回来的开放包络事件，
// 输出按能力单元分组、组内按时间倒序的时间线视图模型。
//
// 与 host 读侧同一策略：包络是开放的，读不懂的行安静丢弃并计数，不 throw、
// 不臆造——写方可能先于本进程升级。但「不是本视图的事件类型」和「是本类型
// 却读不懂」要分开算：混在一起会让空态的「读不懂 N 条」说谎。
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
  /**
   * 读不懂的装卸行数：type 是 capability_lifecycle 但 data 非对象 / 未知 action / 缺 key。
   * 只统计本视图该管的那一类——其他事件类型不是脏行，不计入（否则「读不懂」会说谎）。
   * 消费方 = 空态：账本里有内容但一行都读不懂时，空态必须和「还没有记录」区分开。
   */
  unreadable: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 'skip' = 不是本视图的事件（其他类型），'unreadable' = 是本类型但读不懂 */
type NarrowMiss = 'skip' | 'unreadable';

function narrowEntry(event: TraceLedgerEvent): CapabilityLifecycleEntry | NarrowMiss {
  if (event.type !== 'capability_lifecycle') return 'skip';
  if (!isRecord(event.data)) return 'unreadable';
  const { capabilityKey, action, detail } = event.data;
  if (typeof capabilityKey !== 'string' || !capabilityKey) return 'unreadable';
  if (typeof action !== 'string' || !ACTIONS.has(action)) return 'unreadable';
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
  let unreadable = 0;
  for (const event of events) {
    const entry = narrowEntry(event);
    if (entry === 'skip') continue;
    if (entry === 'unreadable') {
      unreadable += 1;
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
  return { groups, unreadable };
}

export type CapabilityNamespaceKey = 'nsSkill' | 'nsTool' | 'nsPlugin' | 'nsConnector' | 'nsExtension';

const NAMESPACE_LABEL_KEY: Readonly<Record<string, CapabilityNamespaceKey>> = {
  skill: 'nsSkill',
  tool: 'nsTool',
  plugin: 'nsPlugin',
  connector: 'nsConnector',
  extension: 'nsExtension',
};

/**
 * 能力 key 拆成「命名空间 + 名字」给展示层说人话用：`skill:internal-comms`
 * 屏上不该出现（命名空间是实现概念）。认不出的命名空间返回 null，让展示层
 * 原样露出整串——宁可露原文，也不臆造一个人话标签。
 */
export function splitCapabilityKey(
  capabilityKey: string,
): { namespaceKey: CapabilityNamespaceKey; name: string } | null {
  const separator = capabilityKey.indexOf(':');
  if (separator <= 0) return null;
  const namespaceKey = NAMESPACE_LABEL_KEY[capabilityKey.slice(0, separator)];
  const name = capabilityKey.slice(separator + 1);
  return namespaceKey && name ? { namespaceKey, name } : null;
}
