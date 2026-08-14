// ============================================================================
// 候选能力（N-CAP1 / F1+F12）—— 探测器产出、人与 agent 共用的同一张表
// ============================================================================
// 一条 = 一个「反复在做的事」。本体不是「它缺什么」（不可观测），而是
// 「它反复在做什么」（全部可观测）——所以聚类的原料是真实执行序列。

/** 沉淀层级建议：由三测试机械判定，模型不参与（见 N-CAP1 工单修正 ⑤） */
export type CapabilityCandidateTier = 'skill' | 'workflow' | 'plugin';

/** 条目状态：拉式列表的三态 + 折叠位 */
export type CapabilityCandidateState = 'active' | 'ignored' | 'dismissed';

/** 采集到的信号种类（S1~S3） */
export interface CapabilityCandidateSignals {
  /** S1：同一组工具被反复拼凑（默认信号，任何重复都算） */
  repeated: boolean;
  /** S2：中途有步骤失败，随后换别的工具达成（降级完成） */
  degraded: boolean;
  /** S3：出现「因为没有 X」类显式失败 */
  missingDependency: boolean;
  /** S3 命中时抓到的缺失线索（去重，最多几条） */
  missingHints: string[];
}

/** 判定建议层级的三测试原始结论（列表要能解释「凭什么」） */
export interface CapabilityCandidateTierTests {
  /** 确定性：不同步骤顺序数 / 发生次数 ≤ 阈值 ⇒ 去掉模型也能跑 */
  deterministic: boolean;
  /** 边界：要用现有工具集之外的东西（由 S3 证据判定，不靠名字清单） */
  needsExternal: boolean;
  /** 失败模式：簇内失败率超阈值 ⇒ 需要硬失败 + 幂等重试 */
  faultProne: boolean;
}

/** 落盘账本里的一条候选（host 侧真源） */
export interface CapabilityCandidateRecord {
  /** 聚类键：去参数化后的工具集合（排序去重后 join） */
  clusterKey: string;
  /** 组成该簇的 shape token（去参数化后的工具标识） */
  shapeTokens: string[];
  /** 出现过的不同步骤顺序（去参数化后），用于算可参数化度与解释归并理由 */
  variants: string[];
  /** 原始发生次数（不衰减，给人看证据） */
  occurrences: number;
  /** 衰减后的重复度 n̂：每次发生增量更新，久未复现自然下沉 */
  decayedCount: number;
  /** 均步数（运行均值） */
  avgSteps: number;
  /** 均 token（运行均值；拿不到用量时为 0） */
  avgTokens: number;
  /** 均墙钟毫秒（运行均值） */
  avgWallclockMs: number;
  /** 失败步数占比（运行均值） */
  failureRate: number;
  firstSeenAt: number;
  lastSeenAt: number;
  signals: CapabilityCandidateSignals;
  tests: CapabilityCandidateTierTests;
  tier: CapabilityCandidateTier;
  state: CapabilityCandidateState;
  /** 「忽略」的冷却到期时间；到期且再次发生则回到列表 */
  ignoredUntil?: number;
  /** 「不再提示」的时间戳（终态） */
  dismissedAt?: number;
  /** 模型分：人话名。仅展示，绝不进排序 */
  displayName?: string;
  /** 模型分：一句「它是什么」。仅展示，绝不进排序 */
  summary?: string;
  /** 采样的用户原话（给模型起名用，也给人认菜） */
  sampleUserMessages: string[];
}

/** 送到渲染层的一行（已算好机械分与解释文案所需字段） */
export interface CapabilityCandidateView extends CapabilityCandidateRecord {
  /** 机械分（排序主键）：读时按衰减重算，模型分不参与 */
  mechanicalScore: number;
  /** 是否进首屏（低分默认折叠） */
  aboveFold: boolean;
}

export interface CapabilityCandidateList {
  candidates: CapabilityCandidateView[];
  /** 被折叠的低分条数 */
  foldedCount: number;
}
