// ============================================================================
// agentBodySchemas：坏输入拒绝（goal 无 verify/review、prompt 空、toolCallId 缺失）。
// 这些 schema 是 /api/run 入口的第一道闸，此前零单测。
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  AgentCancelBodySchema,
  AgentRunBodySchema,
  AgentToolResultBodySchema,
  GoalBodySchema,
} from '../../../src/web/routes/agentBodySchemas';

describe('GoalBodySchema', () => {
  it('rejects goals that provide neither verify nor review', () => {
    const result = GoalBodySchema.safeParse({ goal: 'do stuff', budget: 3 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/verify|review/);
    }
  });

  it('accepts soft goal with only review', () => {
    const result = GoalBodySchema.safeParse({ review: 'looks good' });
    expect(result.success).toBe(true);
  });

  it('accepts hard goal with only verify', () => {
    const result = GoalBodySchema.safeParse({ verify: 'npm test' });
    expect(result.success).toBe(true);
  });

  it('rejects empty verify string even when present', () => {
    const result = GoalBodySchema.safeParse({ verify: '' });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive budget / maxTurns', () => {
    expect(GoalBodySchema.safeParse({ verify: 'x', budget: 0 }).success).toBe(false);
    expect(GoalBodySchema.safeParse({ verify: 'x', budget: -1 }).success).toBe(false);
    expect(GoalBodySchema.safeParse({ verify: 'x', maxTurns: 0 }).success).toBe(false);
    expect(GoalBodySchema.safeParse({ verify: 'x', maxTurns: 1.5 }).success).toBe(false);
  });
});

describe('AgentRunBodySchema', () => {
  it('requires a non-empty prompt', () => {
    expect(AgentRunBodySchema.safeParse({}).success).toBe(false);
    expect(AgentRunBodySchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(AgentRunBodySchema.safeParse({ prompt: 'hello' }).success).toBe(true);
  });

  it('rejects nested invalid goal payloads', () => {
    const result = AgentRunBodySchema.safeParse({
      prompt: 'run',
      goal: { goal: 'no criteria' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional sessionId and attachments as objects', () => {
    const result = AgentRunBodySchema.safeParse({
      prompt: 'run',
      sessionId: 's-1',
      attachments: [{ id: 'a1', name: 'f.txt' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('AgentCancelBodySchema', () => {
  it('accepts empty body (route may resolve run via other means) and passthrough fields', () => {
    expect(AgentCancelBodySchema.safeParse({}).success).toBe(true);
    expect(AgentCancelBodySchema.safeParse({ runId: 'r1', extra: true }).success).toBe(true);
  });
});

describe('AgentToolResultBodySchema', () => {
  it('requires toolCallId', () => {
    expect(AgentToolResultBodySchema.safeParse({}).success).toBe(false);
    expect(AgentToolResultBodySchema.safeParse({ toolCallId: '' }).success).toBe(false);
    expect(AgentToolResultBodySchema.safeParse({ toolCallId: 'tc-1' }).success).toBe(true);
  });

  it('allows nullable output/error and optional metadata', () => {
    const result = AgentToolResultBodySchema.safeParse({
      toolCallId: 'tc-1',
      success: false,
      output: null,
      error: 'boom',
      metadata: { retries: 1 },
    });
    expect(result.success).toBe(true);
  });
});
