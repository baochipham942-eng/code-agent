import type { PriceSource } from '../pricing/resolveModelPrice';

/**
 * 本轮相对上一轮的 prompt-cache 前缀是否被打断。
 * model-switch：模型变了。prefix-changed：动态边界之前的静态前缀变了。none：没断。
 */
export type CacheBreakReason = 'model-switch' | 'prefix-changed' | 'none';

/** 一轮模型调用的刊例费用估算；usd=null 表示没有可信价格。 */
export interface TurnCostEstimate {
  id: number;
  sessionId: string;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  source: PriceSource;
  createdAt: number;
  /** 可 JSON 序列化的断缓存原因。旧行缺省按 none 读出。 */
  cacheBreakReason: CacheBreakReason;
}

export type TurnCostEstimateInput = Omit<TurnCostEstimate, 'id' | 'createdAt' | 'cacheBreakReason'> & {
  /** 可注入时间戳，便于迁移、回放和确定性测试。 */
  createdAt?: number;
  cacheBreakReason?: CacheBreakReason;
};

export interface TodayCost {
  usd: number;
  unknownTurns: number;
}

export interface ModelCostStats {
  provider: string;
  modelId: string;
  turns: number;
  usd: number;
  unknownTurns: number;
}
