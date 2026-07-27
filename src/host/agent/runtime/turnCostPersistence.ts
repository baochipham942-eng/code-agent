import type { AgentEvent } from '../../../shared/contract';
import type { TurnCostEstimateInput } from '../../../shared/contract/turnCost';
import {
  estimateTurnCostUsd,
  resolveModelPrice,
} from '../../../shared/pricing/resolveModelPrice';
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
}): (event: AgentEvent) => void {
  const turns = new Map<string, PendingTurnCost>();
  const sink = options.sink ?? defaultSink();
  let activeTurnId: string | null = null;

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
