import { createContext, useContext } from 'react';

/**
 * 会话内各轮实际使用过的模型集合（由 TurnBasedTraceView 汇总该会话所有轮的
 * turnQuality.strategy 提供）。TurnQualityStrip 用它判断"这轮模型徽标是不是
 * 在重复全会话唯一的名字"——单模型会话里每轮印同一个模型名是纯噪音。
 *
 * 默认值 null = 没有会话级上下文（单测、嵌套复用等），消费方保持原行为。
 */
export const SessionModelsContext = createContext<ReadonlySet<string> | null>(null);

export function useSessionModels(): ReadonlySet<string> | null {
  return useContext(SessionModelsContext);
}
