// ============================================================================
// 装卸历史投影（N-LEDGER-P5B）—— 能力中心「装卸历史」tab 的纯函数层
// ----------------------------------------------------------------------------
// 输入是 fetchSessionTrace('capability-runtime') 整读回来的开放包络事件，
// 输出按「批次（时间簇）」为主轴、批内列能力的视图模型（P5B 爸拍板方案 B：
// 按能力单元分组会把 13 个事实显示成 50 张一模一样的卡，主轴必须是批次）。
//
// 批次口径（真账本实测簇结构推出，定死不发明）：
//   事件按 ts 升序排（Array.prototype.sort 在现代 JS 是稳定排序，同 ts 保持
//   文件顺序 = 写入顺序，别打乱），顺序扫描，遇到任一情况开新批次：
//     ① action 与上一条不同；② 与上一条的 ts 间隔 > BATCH_GAP_MS。
//   不做「重新装载」模式推断（unloaded N 紧跟 loaded ~N 合成一行）——
//   相邻两行「卸下了 50 个 / 装上了 49 个」本身已经读得懂，推断会说谎。
//
// 与 host 读侧同一策略：包络是开放的，读不懂的行安静丢弃并计数，不 throw、
// 不臆造——写方可能先于本进程升级。但「不是本视图的事件类型」和「是本类型
// 却读不懂」要分开算：混在一起会让空态的「读不懂 N 条」说谎。
//
// renderer 侧不 import host 的 TraceEventDataMap（renderer/host 边界纪律），
// 这里自己写窄类型，字段口径对齐 turnTrace.ts 的 capability_lifecycle 槽位。
// ============================================================================

import type { TraceLedgerEvent } from '../services/traceLedgerClient';

/**
 * 聚簇间隔上限（毫秒）。依据：账本写侧 flush 节拍是 8 事件 / 2 秒，一次爆发内
 * 的 50 条是同一个同步循环里 Date.now() 打的（毫秒级），而真账本上两次用户
 * 动作之间实测隔 3s（472 → 475）——2000 能把跨秒边界的一次爆发聚成一批、
 * 又把两次动作分开。不做成配置项。
 */
const BATCH_GAP_MS = 2000;

export type CapabilityLifecycleAction = 'loaded' | 'unloaded' | 'rolled_back' | 'failed';

const ACTIONS: ReadonlySet<string> = new Set(['loaded', 'unloaded', 'rolled_back', 'failed']);

interface CapabilityLifecycleEntry {
  capabilityKey: string;
  action: CapabilityLifecycleAction;
  /** host 的 error.message，原文展示（不翻译不加工）；仅 failed 一般带 */
  detail?: string;
  /** 事件时间戳（毫秒）。包络 ts 缺失/非数时按 0 处理，聚到最老的批次 */
  ts: number;
}

export interface CapabilityLifecycleBatch {
  action: CapabilityLifecycleAction;
  /** 批内最新 ts（毫秒），用于批次间排序与行尾相对时间 */
  ts: number;
  /** 批内能力 key：按名字字母序、去重 */
  capabilityKeys: string[];
  /** failed 的 detail 按能力 key 挂（host error.message 原文）；仅 failed 一般有内容 */
  details: Record<string, string>;
}

export interface CapabilityLifecycleHistory {
  /** 批次按 ts 倒序（最近发生的在最上面） */
  batches: CapabilityLifecycleBatch[];
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
 * 投影：过滤 → 收窄 → ts 升序稳定排序 → 顺序扫描聚批次。
 * 批次按 ts 倒序输出；批内能力按 key 字母序去重。
 */
export function projectCapabilityLifecycleHistory(
  events: readonly TraceLedgerEvent[],
): CapabilityLifecycleHistory {
  const entries: CapabilityLifecycleEntry[] = [];
  let unreadable = 0;
  for (const event of events) {
    const entry = narrowEntry(event);
    if (entry === 'skip') continue;
    if (entry === 'unreadable') {
      unreadable += 1;
      continue;
    }
    entries.push(entry);
  }

  // 稳定排序：同 ts 保持文件顺序（= 写入顺序），不打乱同批内的先后
  entries.sort((a, b) => a.ts - b.ts);

  const batches: CapabilityLifecycleBatch[] = [];
  let currentAction: CapabilityLifecycleAction | null = null;
  let currentTs = 0;
  let currentKeys = new Set<string>();
  let currentDetails = new Map<string, string>();

  const flush = (): void => {
    if (currentAction === null) return;
    batches.push({
      action: currentAction,
      ts: currentTs,
      capabilityKeys: [...currentKeys].sort(),
      details: Object.fromEntries(currentDetails),
    });
    currentAction = null;
    currentKeys = new Set<string>();
    currentDetails = new Map<string, string>();
  };

  for (const entry of entries) {
    if (currentAction === null
      || entry.action !== currentAction
      || entry.ts - currentTs > BATCH_GAP_MS) {
      flush();
      currentAction = entry.action;
    }
    currentTs = entry.ts; // 升序扫描，批内最新 ts 就是最后进批的那条
    currentKeys.add(entry.capabilityKey);
    if (entry.detail) currentDetails.set(entry.capabilityKey, entry.detail);
  }
  flush();

  batches.reverse(); // 扫描产出是 ts 升序，倒序后最近发生的在最上面
  return { batches, unreadable };
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
