import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/host/tools/types';
import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';
import { BrowserPoolBusyError, browserPool } from '../../../../src/host/services/infra/browserPool';

const busyMessage = new BrowserPoolBusyError(4).message;

afterEach(() => {
  vi.restoreAllMocks();
});

function failAcquire(): void {
  vi.spyOn(browserPool, 'acquire').mockImplementation(() => {
    throw new BrowserPoolBusyError(4);
  });
}

describe('browser_action returns a failed tool result when the pool is busy', () => {
  it('managed acquire site carries the busy message', async () => {
    failAcquire();
    const result = await browserActionTool.execute(
      { action: 'list_tabs' },
      {
        sessionId: 'conversation-busy',
        runId: 'run-busy',
        agentId: 'agent-busy',
        workingDirectory: '/tmp',
        requestPermission: async () => true,
      } as ToolContext,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(busyMessage);
  });

  it('legacy agentId acquire site carries the busy message', async () => {
    failAcquire();
    const result = await browserActionTool.execute(
      { action: 'list_tabs' },
      {
        agentId: 'legacy-agent',
        workingDirectory: '/tmp',
        requestPermission: async () => true,
      } as ToolContext,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(busyMessage);
  });
});
