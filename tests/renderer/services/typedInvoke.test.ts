import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTaskSchemas } from '../../../src/shared/ipc/schemas';
import { typedInvokeDomain } from '../../../src/renderer/services/typedInvoke';

const mockDomainInvoke = vi.fn();

describe('typedInvokeDomain', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: {
        invoke: mockDomainInvoke,
      },
    };
  });

  it('invokes the domain bridge with channel, action, and payload from the typed request', async () => {
    mockDomainInvoke.mockResolvedValue({
      success: true,
      data: [],
    });

    const response = await typedInvokeDomain(BackgroundTaskSchemas.LIST_TASKS, {
      action: 'listTasks',
      payload: { sessionId: 'session-1' },
    });

    expect(mockDomainInvoke).toHaveBeenCalledWith(
      'domain:backgroundTasks',
      'listTasks',
      { sessionId: 'session-1' },
    );
    expect(response).toEqual({ success: true, data: [] });
  });

  it('validates response payloads in non-production mode', async () => {
    mockDomainInvoke.mockResolvedValue({
      success: true,
      data: [{ id: 'missing-required-task-fields' }],
    });

    await expect(
      typedInvokeDomain(BackgroundTaskSchemas.LIST_TASKS, { action: 'listTasks' }),
    ).rejects.toThrow('response validation failed');
  });
});
