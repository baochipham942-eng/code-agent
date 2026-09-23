import type { AgentEvent } from '../../../shared/contract';
import type { CacheBreakReason, TurnCostEstimateInput } from '../../../shared/contract/turnCost';
import {
  estimateTurnCostUsd,
  resolveModelPrice,
} from '../../../shared/pricing/resolveModelPrice';
import { detectCacheBreak } from '../../prompts/cacheBreakDetection';
import { getDatabase } from '../../services/core/databaseService';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('TurnCostPersistence');

export interface TurnCostWriteSink {
  insert(input: TurnCostEstimateInput): unknown;
}

interface PendingTurnCost {
  provider?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface TurnCachePromptSample {
  prompt: string;
  modelId: string;
}

const previousPromptBySession = new Map<string, TurnCachePromptSample>();
const MAX_PREVIOUS_PROMPT_SESSIONS = 256;

export function clearSessionCachePrompt(sessionId: string): void {
  previousPromptBySession.delete(sessionId);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function defaultSink(): TurnCostWriteSink {
  return {
    insert(input) {
      getDatabase().getTurnCostRepo().insert(input);
    },
  };
}

/**
 * 包住 AgentLoop 的真实事件出口：stream_usage/model_response 采集权威用量，
 * model_decision/model_response 采集实际路由，turn_end 时同步落一行。
 */
export function createTurnCostEventHandler(options: {
  sessionId: string;
  onEvent: (event: AgentEvent) => void;
  sink?: TurnCostWriteSink;
  /** 本轮系统提示与模型。缺省时 cacheBreakReason 记 none。 */
  readCachePrompt?: () => TurnCachePromptSample | undefined;
}): (event: AgentEvent) => void {
  const turns = new Map<string, PendingTurnCost>();
  const sink = options.sink ?? defaultSink();
  let activeTurnId: string | null = null;
  let previousPrompt = previousPromptBySession.get(options.sessionId);

  const cacheBreakReasonForTurn = (): CacheBreakReason => {
  const current = options.readCachePrompt?.();
  if (!current) return 'none';
  const previous = previousPrompt;
  previousPrompt = current;
  previousPromptBySession.delete(options.sessionId);
  if (previousPromptBySession.size >= MAX_PREVIOUS_PROMPT_SESSIONS) {
    const oldest = previousPromptBySession.keys().next().value;
    if (oldest !== undefined) previousPromptBySession.delete(oldest);
  }
  previousPromptBySession.set(options.sessionId, current);
    if (!previous) return 'none';
    return detectCacheBreak(previous.prompt, current.prompt, {
      prevModel: previous.modelId,
      currModel: current.modelId,
    }).cacheBreakReason;
  };

  const getTurn = (turnId: string): PendingTurnCost => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    const created: PendingTurnCost = {};
    turns.set(turnId, created);
    return created;
  };

  const persistTurn = (turnId: string): void => {
    const turn = turns.get(turnId);
    turns.delete(turnId);
    if (activeTurnId === turnId) activeTurnId = null;
    if (!turn || !isTokenCount(turn.inputTokens) || !isTokenCount(turn.outputTokens)) return;

    const provider = turn.provider ?? 'unknown';
    const modelId = turn.modelId ?? 'unknown';
    const price = resolveModelPrice(provider, modelId);
    const cacheBreakReason = cacheBreakReasonForTurn();
    try {
      sink.insert({
        sessionId: options.sessionId,
        provider,
        modelId,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        usd: estimateTurnCostUsd(price, {
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
        }),
        source: price.source,
        cacheBreakReason,
      });
    } catch (error) {
      logger.warn('[TurnCostPersistence] failed to persist turn cost (ignored)', {
        sessionId: options.sessionId,
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (event: AgentEvent) => {
    switch (event.type) {
      case 'turn_start':
        activeTurnId = event.data.turnId;
        getTurn(event.data.turnId);
        break;

      case 'model_decision': {
        const turnId = event.data.turnId ?? activeTurnId;
        if (turnId) {
          const turn = getTurn(turnId);
          turn.provider = event.data.resolvedProvider;
          turn.modelId = event.data.resolvedModel;
        }
        break;
      }

      case 'stream_usage': {
        const turnId = event.data.turnId ?? activeTurnId;
        if (
          turnId
          && isTokenCount(event.data.inputTokens)
          && isTokenCount(event.data.outputTokens)
        ) {
          const turn = getTurn(turnId);
          // Provider 的 usage 事件是本次调用的最终累计值；保留末值，避免重复块双计。
          turn.inputTokens = event.data.inputTokens;
          turn.outputTokens = event.data.outputTokens;
        }
        break;
      }

      case 'model_response': {
        if (activeTurnId) {
          const turn = getTurn(activeTurnId);
          turn.provider = event.data.provider ?? turn.provider;
          turn.modelId = event.data.model || turn.modelId;
          // 非流式调用没有 stream_usage，用 model_response 的同源 usage 补齐。
          if (
            turn.inputTokens === undefined
            && isTokenCount(event.data.inputTokens)
            && isTokenCount(event.data.outputTokens)
          ) {
            turn.inputTokens = event.data.inputTokens;
            turn.outputTokens = event.data.outputTokens;
          }
        }
        break;
      }

      case 'turn_end':
        persistTurn(event.data.turnId);
        break;

      case 'agent_complete':
      case 'agent_cancelled':
        turns.clear();
        activeTurnId = null;
        break;
    }

    options.onEvent(event);
  };
}
