import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const platformState = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  return {
    handlers,
    reset() {
      handlers.clear();
    },
  };
});

const workflowLaunchApprovalState = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
}));

const scriptRuntimeState = vi.hoisted(() => ({
  cancelRun: vi.fn(),
}));

const eventBusState = vi.hoisted(() => ({
  subscribe: vi.fn(),
}));

vi.mock('../../../src/main/platform', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      platformState.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../../../src/main/services/eventing/bus', () => ({
  getEventBus: () => eventBusState,
}));

vi.mock('../../../src/main/agent/workflowLaunchApproval', () => ({
  getWorkflowLaunchApprovalGate: () => workflowLaunchApprovalState,
}));

vi.mock('../../../src/main/agent/scriptRuntime', () => ({
  cancelRun: (...args: unknown[]) => scriptRuntimeState.cancelRun(...args),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import { registerWorkflowHandlers } from '../../../src/main/ipc/workflow.ipc';

describe('workflow.ipc', () => {
  beforeEach(() => {
    workflowLaunchApprovalState.approve.mockReset();
    workflowLaunchApprovalState.reject.mockReset();
    scriptRuntimeState.cancelRun.mockReset();
    eventBusState.subscribe.mockReset();
    registerWorkflowHandlers();
  });

  it('cancels a workflow run through the scriptRuntime control plane', async () => {
    scriptRuntimeState.cancelRun.mockReturnValue(true);
    const handler = platformState.handlers.get(IPC_CHANNELS.WORKFLOW_CANCEL_RUN);
    expect(handler).toBeDefined();

    await expect(handler?.({}, { runId: 'wf-1', sessionId: 'sess-A' })).resolves.toBe(true);
    expect(scriptRuntimeState.cancelRun).toHaveBeenCalledWith('wf-1', { sessionId: 'sess-A' });
  });

  it('fails closed when cancel payload has no runId', async () => {
    const handler = platformState.handlers.get(IPC_CHANNELS.WORKFLOW_CANCEL_RUN);
    await expect(handler?.({}, { sessionId: 'sess-A' })).resolves.toBe(false);
    expect(scriptRuntimeState.cancelRun).not.toHaveBeenCalled();
  });
});
