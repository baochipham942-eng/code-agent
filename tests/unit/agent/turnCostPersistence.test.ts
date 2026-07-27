import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { AgentEvent } from '../../../src/shared/contract';
import {
  estimateTurnCostUsd,
  resolveModelPrice,
} from '../../../src/shared/pricing/resolveModelPrice';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { TurnCostRepository } from '../../../src/host/services/core/repositories/TurnCostRepository';
import { createTurnCostEventHandler } from '../../../src/host/agent/runtime/turnCostPersistence';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('turn cost production event handler', () => {
  let db: BetterSqlite3.Database;
  let repo: TurnCostRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    // 本地 logger 只 mock debug/info/warn/error 四个被测路径用到的方法；applySchema 要求完整服务 Logger（含 level/setLevel/log/dispose），沿用 desktopQueuedInputDrain.persistence.test.ts 的 as never 先例。
    applySchema(db, logger as never);
    repo = new TurnCostRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('persists one real row when stream_usage reaches turn_end', () => {
    const downstream = vi.fn();
    const onEvent = createTurnCostEventHandler({
      sessionId: 'session-real-path',
      onEvent: downstream,
      sink: repo,
    });

    onEvent({ type: 'turn_start', data: { turnId: 'turn-1', iteration: 1 } });
    onEvent({
      type: 'model_decision',
      data: {
        requestedProvider: 'deepseek',
        requestedModel: 'deepseek-v4-pro',
        resolvedProvider: 'deepseek',
        resolvedModel: 'deepseek-v4-pro',
        role: null,
        reason: 'user-selected',
        billingMode: 'payg',
        fallbackFrom: null,
        turnId: 'turn-1',
      },
    } as AgentEvent);
    onEvent({
      type: 'stream_usage',
      data: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        turnId: 'turn-1',
      },
    });
    onEvent({
      type: 'model_response',
      data: {
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
        responseType: 'text',
        duration: 10,
        toolCalls: [],
        textLength: 2,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      },
    });
    onEvent({ type: 'turn_end', data: { turnId: 'turn-1' } });
    onEvent({ type: 'turn_end', data: { turnId: 'turn-1' } });

    const rows = repo.listBySession('session-real-path');
    const price = resolveModelPrice('deepseek', 'deepseek-v4-pro');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      usd: estimateTurnCostUsd(price, {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      }),
      source: price.source,
    });
    expect(downstream).toHaveBeenCalledTimes(6);
  });

  it('stores NULL for an unknown model and uses model_response usage on non-streaming calls', () => {
    const onEvent = createTurnCostEventHandler({
      sessionId: 'session-non-stream',
      onEvent: vi.fn(),
      sink: repo,
    });

    onEvent({ type: 'turn_start', data: { turnId: 'turn-2', iteration: 1 } });
    onEvent({
      type: 'model_response',
      data: {
        model: 'private-model',
        provider: 'custom',
        responseType: 'text',
        duration: 10,
        toolCalls: [],
        textLength: 2,
        inputTokens: 20,
        outputTokens: 5,
      },
    });
    onEvent({ type: 'turn_end', data: { turnId: 'turn-2' } });

    expect(repo.listBySession('session-non-stream')[0]).toMatchObject({
      provider: 'custom',
      modelId: 'private-model',
      inputTokens: 20,
      outputTokens: 5,
      usd: null,
      source: 'unknown',
    });
  });
});
