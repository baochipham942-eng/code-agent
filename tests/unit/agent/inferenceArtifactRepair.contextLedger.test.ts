import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly/shared';
import type { ContextEventRecord } from '../../../src/host/context/contextEventLedger';
import { CONTEXT_LEDGER } from '../../../src/shared/constants';

// 显式给 mock 定型：否则 mock.calls[0][0] 是 any，下游 .find(event => …) 的回调参数
// 隐式 any 会被 tsc-tests-ratchet 拦下（tests/ 不在 npm run typecheck 范围内）。
const ledgerMocks = vi.hoisted(() => ({
  upsertEvents: vi.fn<(events: ContextEventRecord[]) => void>(),
}));

vi.mock('../../../src/host/context/contextEventLedger', () => ({
  getContextEventLedger: () => ledgerMocks,
}));

import { emitToolSchemaSnapshot } from '../../../src/host/agent/runtime/contextAssembly/inferenceArtifactRepair';

function makeTool(name: string, property: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      type: 'object',
      properties: {
        [property]: { type: 'string' },
      },
      required: [property],
    },
    requiresPermission: false,
    permissionLevel: 'read',
  };
}

function makeCtx(turnId: string): ContextAssemblyCtx {
  return {
    runtime: {
      sessionId: 'session-tools',
      agentId: 'agent-tools',
      modelConfig: {
        provider: 'test-provider',
        model: 'test-model',
      },
      turn: { currentTurnId: turnId },
      onEvent: vi.fn(),
    },
  } as unknown as ContextAssemblyCtx;
}

/** 找不到就抛（测试真红），而不是用 ! 把「可能没记录」这件事抹平。 */
function requireToolSnapshot(events: ContextEventRecord[]): ContextEventRecord {
  const found = events.find(
    (event) => event.sourceKind === CONTEXT_LEDGER.SOURCE_KIND.TOOL_SCHEMA_SNAPSHOT,
  );
  if (!found) throw new Error('ledger 未记录 tool schema snapshot 事件');
  return found;
}

describe('emitToolSchemaSnapshot context ledger', () => {
  beforeEach(() => {
    ledgerMocks.upsertEvents.mockClear();
  });

  it('persists sorted active tools, a stable schema hash, and model binding', () => {
    const read = makeTool('Read', 'path');
    const write = makeTool('Write', 'content');

    emitToolSchemaSnapshot(makeCtx('turn-a'), [write, read]);
    const firstEvents = ledgerMocks.upsertEvents.mock.calls[0][0];
    emitToolSchemaSnapshot(makeCtx('turn-b'), [read, write]);
    const secondEvents = ledgerMocks.upsertEvents.mock.calls[1][0];

    const firstTools = requireToolSnapshot(firstEvents);
    const secondTools = requireToolSnapshot(secondEvents);
    expect(firstTools).toMatchObject({
      invocationId: 'turn-a',
      toolNames: ['Read', 'Write'],
    });
    expect(firstTools.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(secondTools.schemaHash).toBe(firstTools.schemaHash);
    expect(firstEvents).toContainEqual(expect.objectContaining({
      sourceKind: CONTEXT_LEDGER.SOURCE_KIND.MODEL_BINDING,
      model: 'test-model',
      provider: 'test-provider',
    }));
  });
});
