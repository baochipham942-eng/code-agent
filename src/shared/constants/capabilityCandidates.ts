/**
 * 候选能力（N-CAP1 / F1+F12）—— 缺口探测器与候选列表的全部可调量。
 *
 * 阈值口径：方案 §二.5(1) 明确「阈值不硬编码、先跑两周拿真实分布再定线」。
 * 这里的数值都是**起步线**，不是推导结果；它们只影响首屏折叠与层级建议，
 * 不影响账本记录（低于线的照样记账，只是不进首屏），所以定错了不丢数据。
 */
export const CAPABILITY_CANDIDATES = {
  /** 账本文件名（位于 ~/.code-agent/ 下，与 skill-drafts/ 平级） */
  LEDGER_FILENAME: 'capability-candidates.json',
  /** 账本最多保留条数，超出按机械分裁剪（「不再提示」条目豁免） */
  MAX_LEDGER_ENTRIES: 200,
  /** 落盘防抖 */
  WRITE_DEBOUNCE_MS: 2_000,

  /** 一轮里少于这么多步不构成「拼凑」，不进账本 */
  MIN_STEPS_PER_TURN: 2,
  /** 少于这么多种不同工具不构成「拼凑」（单工具是在用工具，不是凑替代品） */
  MIN_DISTINCT_TOOLS: 2,
  /**
   * 工具集合重合度达到该值就归并进同一个候选。
   * 真库回放（4538 条 begin / 846 会话）实测：只用精确集合键时 200 条候选里
   * 绝大多数只出现 1 次，真正反复在做的长序列永远攒不出分数。
   */
  CLUSTER_MERGE_OVERLAP: 0.7,
  /** 一个候选最多留几条不同步骤顺序（可参数化度的分母来源） */
  MAX_VARIANTS: 8,
  /** 一个候选最多留几条用户原话样例（给模型起名 + 给人认菜） */
  MAX_SAMPLE_MESSAGES: 3,
  /** S3 缺失线索最多留几条 */
  MAX_MISSING_HINTS: 3,

  /** 重复度半衰期：久未复现自动降权下沉 */
  DECAY_HALF_LIFE_MS: 14 * 24 * 60 * 60 * 1000,

  /** 确定性测试：不同步骤顺序数 / 发生次数 ≤ 该值 ⇒ 判「去掉模型也能跑」 */
  DETERMINISTIC_VARIANCE_MAX: 0.5,
  /** 失败模式测试：簇内失败步占比高于该值 ⇒ 需要硬失败 + 幂等重试 */
  FAULT_PRONE_FAILURE_RATE: 0.2,

  /** 首屏门槛：机械分低于该值默认折叠（只记账，不打扰） */
  ABOVE_FOLD_MIN_SCORE: 4,
  /** 首屏门槛：发生次数低于该值默认折叠 */
  ABOVE_FOLD_MIN_OCCURRENCES: 2,

  /** 「忽略」后的下沉冷却期（与 skillDraftQueue 的复议冷却同口径） */
  IGNORE_COOLDOWN_MS: 30 * 24 * 60 * 60 * 1000,

  /** 注入给 agent 的候选条数上限（会话首轮注入一次，不每轮重复付费） */
  AGENT_NOTICE_MAX_ENTRIES: 3,
} as const;
