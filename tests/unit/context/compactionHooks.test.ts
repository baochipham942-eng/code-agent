import { describe, expect, it, vi } from 'vitest';
import {
  runPostCompactHooks,
  runPreCompactHooks,
  type CompactionHookManagerLike,
} from '../../../src/host/context/compactionHooks';
import type { Message } from '../../../src/shared/contract';

const messages = [
  {
    id: 'm1',
    role: 'user' as const,
    content: 'Keep the deployment note.',
    timestamp: 1,
  },
];

describe('compaction hook helpers', () => {
  it('returns preserved context from a successful PreCompact hook', async () => {
    const hookManager: CompactionHookManagerLike = {
      triggerPreCompact: vi.fn().mockResolvedValue({
        preservedContext: 'deployment note',
      }),
    };

    const result = await runPreCompactHooks({
      hookManager,
      sessionId: 'session-1',
      messages,
      tokenCount: 1200,
      targetTokenCount: 600,
    });

    expect(result).toEqual({
      preservedContext: 'deployment note',
      warnings: [],
    });
    expect(hookManager.triggerPreCompact).toHaveBeenCalledWith(
      'session-1',
      messages,
      1200,
      600
    );
  });

  it('converts PreCompact failures to warnings', async () => {
    const logger = { warn: vi.fn() };
    const hookManager: CompactionHookManagerLike = {
      triggerPreCompact: vi.fn().mockRejectedValue(new Error('pre exploded')),
    };

    const result = await runPreCompactHooks({
      hookManager,
      sessionId: 'session-1',
      messages,
      tokenCount: 1200,
      targetTokenCount: 600,
      logger,
    });

    expect(result).toEqual({
      warnings: ['PreCompact hook failed: pre exploded'],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'PreCompact hook failed: pre exploded',
      expect.any(Error)
    );
  });

  it('preserves hookManager this binding for PreCompact and PostCompact hooks', async () => {
    const hookManager = {
      config: {
        prePrefix: 'from-config',
        postPrefix: 'post-config',
      },
      postRecords: [] as string[],
      triggerPreCompact(
        sessionId: string,
        hookMessages: Message[],
        tokenCount: number,
        targetTokenCount: number
      ) {
        return {
          preservedContext: [
            this.config.prePrefix,
            sessionId,
            hookMessages.length,
            tokenCount,
            targetTokenCount,
          ].join(':'),
        };
      },
      triggerPostCompact(
        savedTokens: number,
        strategy: string,
        sessionId: string
      ) {
        this.postRecords.push(
          [this.config.postPrefix, savedTokens, strategy, sessionId].join(':')
        );
      },
    } satisfies CompactionHookManagerLike & {
      config: {
        prePrefix: string;
        postPrefix: string;
      };
      postRecords: string[];
    };

    const preResult = await runPreCompactHooks({
      hookManager,
      sessionId: 'session-with-this',
      messages,
      tokenCount: 1200,
      targetTokenCount: 600,
    });
    const postResult = await runPostCompactHooks({
      hookManager,
      sessionId: 'session-with-this',
      savedTokens: 400,
      strategy: 'summarize',
    });

    expect(preResult).toEqual({
      preservedContext: 'from-config:session-with-this:1:1200:600',
      warnings: [],
    });
    expect(postResult).toEqual({ warnings: [] });
    expect(hookManager.postRecords).toEqual([
      'post-config:400:summarize:session-with-this',
    ]);
  });

  it('swallows PostCompact failures and reports a warning', async () => {
    const logger = { warn: vi.fn() };
    const hookManager: CompactionHookManagerLike = {
      triggerPostCompact: vi.fn().mockRejectedValue(new Error('post exploded')),
    };

    const result = await runPostCompactHooks({
      hookManager,
      sessionId: 'session-1',
      savedTokens: 400,
      strategy: 'summarize',
      logger,
    });

    expect(result).toEqual({
      warnings: ['PostCompact hook failed: post exploded'],
    });
    expect(hookManager.triggerPostCompact).toHaveBeenCalledWith(
      400,
      'summarize',
      'session-1'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'PostCompact hook failed: post exploded',
      expect.any(Error)
    );
  });
});
