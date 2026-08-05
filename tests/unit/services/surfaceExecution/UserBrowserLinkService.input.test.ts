import { describe, expect, it, vi } from 'vitest';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { UserBrowserLinkService } from '../../../../src/host/services/surfaceExecution/UserBrowserLinkService';
import type { ManagedBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import type { SurfaceConversationSnapshotV1 } from '../../../../src/shared/contract/surfaceExecution';

function snapshot(conversationId: string): SurfaceConversationSnapshotV1 {
  return {
    version: 1,
    conversationId,
    sessions: [],
    updatedAt: 1,
  };
}

function createHarness() {
  const registry = new RunRegistry();
  const execute = vi.fn(async (input: {
    executeProvider: (
      signal: AbortSignal,
      browserService: {
        getActiveTab: () => { id: string; page: unknown } | null;
        getSessionState: () => { viewport: { width: number; height: number } };
      },
    ) => Promise<{ success: boolean; output?: string }>;
  }) => {
    const click = vi.fn(async () => undefined);
    const wheel = vi.fn(async () => undefined);
    const press = vi.fn(async () => undefined);
    const insertText = vi.fn(async () => undefined);
    const page = { mouse: { click, wheel, move: vi.fn() }, keyboard: { press, insertText } };
    const result = await input.executeProvider(new AbortController().signal, {
      getActiveTab: () => ({ id: 'tab-1', page }),
      getSessionState: () => ({ viewport: { width: 1280, height: 720 } }),
    });
    return {
      success: result.success,
      output: result.output,
      metadata: { surfaceSessionId: 'surface-user-1' },
      __page: page,
    };
  });
  const runtime = {
    endRun: vi.fn(async () => undefined),
    snapshotConversation: vi.fn((conversationId: string) => snapshot(conversationId)),
  };
  const service = new UserBrowserLinkService(
    registry,
    runtime,
    { execute } as unknown as Pick<ManagedBrowserProviderAdapter, 'execute'>,
  );
  return { service, execute, registry };
}

describe('UserBrowserLinkService.dispatchUserInput', () => {
  it('透传 click 到白名单 dispatch，不接受 CDP 方法字段', async () => {
    const { service, execute } = createHarness();
    await service.dispatchUserInput({
      conversationId: 'conversation-a',
      workspace: process.cwd(),
      input: { kind: 'click', x: 12, y: 34, clickCount: 1 },
    });
    expect(execute).toHaveBeenCalledOnce();
    const first = execute.mock.calls[0];
    expect(first).toBeDefined();
    const call = first![0] as unknown as { action: string; params: Record<string, unknown> };
    expect(call.action).toBe('click');
    expect(call.params).not.toHaveProperty('cdpMethod');
    expect(call.params).not.toHaveProperty('method');
    expect(call.params.kind).toBe('click');
  });

  it('外会话/缺 conversation 拒绝；越界坐标拒绝', async () => {
    const { service } = createHarness();
    await expect(service.dispatchUserInput({
      conversationId: '',
      workspace: process.cwd(),
      input: { kind: 'click', x: 1, y: 1 },
    })).rejects.toThrow(/conversationId and workspace/i);

    await expect(service.dispatchUserInput({
      conversationId: 'conversation-a',
      workspace: process.cwd(),
      input: { kind: 'click', x: 9999, y: 1 },
    })).rejects.toThrow(/out of bounds/i);
  });

  it('拒绝任意 CDP 直通 payload', async () => {
    const { service } = createHarness();
    await expect(service.dispatchUserInput({
      conversationId: 'conversation-a',
      workspace: process.cwd(),
      input: {
        kind: 'click',
        x: 1,
        y: 1,
        cdpMethod: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed' },
      },
    })).rejects.toThrow(/Forbidden field/i);
  });
});
