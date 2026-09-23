import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolModule, ToolSchema } from '../../../src/host/protocol/tools';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getToolSearchService, resetToolSearchService } from '../../../src/host/services/toolSearch';
import { injectResearchModePrompt } from '../../../src/host/agent/runtime/contextAssembly/modeInjection';
import { handleUnavailableToolCalls } from '../../../src/host/agent/runtime/messageProcessorUnavailableTools';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly/shared';

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function register(name: string): void {
  const schema: ToolSchema = {
    name,
    description: `${name} schema`,
    outputSchema: { type: 'string' },
    inputSchema: { type: 'object', properties: {} },
    category: 'network',
    permissionLevel: 'network',
    readOnly: true,
  };
  const module: ToolModule = {
    schema,
    createHandler: () => ({ schema, async execute() { return { ok: true, output: null }; } }),
  };
  getProtocolRegistry().register(schema, async () => module);
}

describe('deferred tool loads keep the caller session', () => {
  beforeEach(() => {
    resetProtocolRegistry();
    register('WebFetch');
    resetToolSearchService();
  });

  it('research-mode preload can be evicted for that session and does not pin after the session ends', () => {
    injectResearchModePrompt({
      loadResearchSkillPrompt: () => null,
      pushPersistentSystemContext: () => undefined,
      runtime: {
        sessionId: 'session-research',
        turn: { enterResearchMode: () => undefined },
      },
    } as unknown as ContextAssemblyCtx, '');

    const service = getToolSearchService();
    expect(service.isToolLoaded('WebFetch')).toBe(true);
    for (let round = 0; round < 4; round += 1) service.beginRound('session-other');
    expect(service.evictIdleDeferredToolsAtCompactionBoundary(3, 'session-other')).toEqual([]);

    service.releaseSession('session-research');
    expect(service.evictIdleDeferredToolsAtCompactionBoundary(3, 'session-other')).toEqual(['WebFetch']);
  });

  it('auto-reload after a model call records the caller session', async () => {
    const outcome = await handleUnavailableToolCalls(
      {
        ctx: {
          sessionId: 'session-reload',
          artifact: {},
          turn: {},
          toolScope: undefined,
        },
        contextAssembly: {},
        emitArtifactRepairStopError: () => undefined,
      } as unknown as Parameters<typeof handleUnavailableToolCalls>[0],
      { content: '' } as unknown as Parameters<typeof handleUnavailableToolCalls>[1],
      [{ id: 'call-1', name: 'web_fetch', arguments: {} }] as unknown as Parameters<typeof handleUnavailableToolCalls>[2],
      [{ id: 'call-1', name: 'web_fetch', arguments: {} }] as unknown as Parameters<typeof handleUnavailableToolCalls>[3],
      new Set<string>(),
    );

    expect(outcome).toBe('proceed');
    const service = getToolSearchService();
    expect(service.isToolLoaded('WebFetch')).toBe(true);
    for (let round = 0; round < 4; round += 1) service.beginRound('session-other');
    expect(service.evictIdleDeferredToolsAtCompactionBoundary(3, 'session-other')).toEqual([]);
    service.releaseSession('session-reload');
    expect(service.evictIdleDeferredToolsAtCompactionBoundary(3, 'session-other')).toEqual(['WebFetch']);
  });
});