import type { PriceSource } from '../pricing/resolveModelPrice';

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
}

export type TurnCostEstimateInput = Omit<TurnCostEstimate, 'id' | 'createdAt'> & {
  /** 可注入时间戳，便于迁移、回放和确定性测试。 */
  createdAt?: number;
};

export interface TodayCost {
  usd: number;
  unknownTurns: number;
}

export interface ModelCostStats {
  modelId: string;
  turns: number;
  usd: number;
  unknownTurns: number;
}
