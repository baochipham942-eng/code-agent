import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ContextEventRecord } from '../../../src/host/context/contextEventLedger';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly/shared';
import { CONTEXT_LEDGER } from '../../../src/shared/constants';

type PromptBudgetModule =
  typeof import('../../../src/host/agent/runtime/contextAssembly/promptBudget');

let promptBudgetModule: PromptBudgetModule;
const originalBudget = process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS;

function makeCtx(turnId: string): ContextAssemblyCtx {
  const droppedPromptBlocks: string[] = [];
  return {
    runtime: {
      sessionId: 'session-prompt-ledger',
      agentId: 'agent-prompt-ledger',
      modelConfig: { model: 'test-model' },
      turn: { currentTurnId: turnId },
      stats: { queueDiagnostic: vi.fn() },
      contextHealth: {
        droppedPromptBlocks,
        recordDroppedPromptBlock: (label: string) => droppedPromptBlocks.push(label),
      },
    },
  } as unknown as ContextAssemblyCtx;
}

function flush(ctx: ContextAssemblyCtx): ContextEventRecord[] {
  const records: ContextEventRecord[] = [];
  promptBudgetModule.flushPromptLayerRecords(ctx, {
    upsertEvents: (events) => records.push(...events),
  });
  return records;
}

describe('prompt budget context ledger', () => {
  beforeAll(async () => {
    process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS = '30';
    vi.resetModules();
    promptBudgetModule = await import(
      '../../../src/host/agent/runtime/contextAssembly/promptBudget'
    );
  });

  afterAll(() => {
    if (originalBudget === undefined) {
      delete process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS;
    } else {
      process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS = originalBudget;
    }
  });

  it('records included, dropped, and trimmed prompt layer outcomes', () => {
    const ctx = makeCtx('turn-outcomes');
    const skillsBlock = 'skill '.repeat(15);
    const requiredBlock = 'required '.repeat(20);
    let prompt = promptBudgetModule.appendPromptBlockWithinBudget(
      'base',
      skillsBlock,
      'skills',
      ctx,
    );
    promptBudgetModule.appendPromptBlockWithinBudget(
      prompt,
      'oversized '.repeat(80),
      'repo map',
      ctx,
    );
    const required = promptBudgetModule.appendPromptBlockWithinBudgetWithStatus(
      prompt,
      requiredBlock,
      'artifact contract',
      new Map([['skills', skillsBlock]]),
      ctx,
      { kind: 'required', trimCandidates: ['skills'] },
    );
    prompt = required.prompt;

    expect(prompt).toContain(requiredBlock);
    expect(required.trimmed).toEqual(['skills']);
    expect(flush(ctx)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        layer: 'skills',
        promptLayerOutcome: CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.TRIMMED,
      }),
      expect.objectContaining({
        layer: 'repo map',
        promptLayerOutcome: CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.DROPPED,
      }),
      expect.objectContaining({
        layer: 'artifact contract',
        promptLayerOutcome: CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.INCLUDED,
      }),
    ]));
  });

  it('restores cached layers under the current invocation id', () => {
    const firstCtx = makeCtx('turn-first');
    promptBudgetModule.recordBasePromptLayer(
      firstCtx,
      'base prompt',
      CONTEXT_LEDGER.BASE_SOURCE.TASK,
    );
    const cached = promptBudgetModule.snapshotPromptLayerRecords(firstCtx);

    const secondCtx = makeCtx('turn-cache-hit');
    promptBudgetModule.restorePromptLayerRecords(secondCtx, cached);
    const restored = flush(secondCtx);

    expect(restored).toEqual([
      expect.objectContaining({
        invocationId: 'turn-cache-hit',
        layer: CONTEXT_LEDGER.BASE_SOURCE.TASK,
        promptLayerOutcome: CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.INCLUDED,
      }),
    ]);
  });
});
