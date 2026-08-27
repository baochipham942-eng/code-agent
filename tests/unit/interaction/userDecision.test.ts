import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const broadcastMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/platform/windowBridge', () => ({
  broadcastToRenderer: broadcastMock,
}));

import {
  markDecisionRequestExpired,
  notifyIfLateDecisionResponse,
} from '../../../src/host/interaction/userDecision';

beforeEach(() => vi.clearAllMocks());

describe('late user decision feedback', () => {
  it('超时请求的迟到应答只提示一次可见反馈', async () => {
    markDecisionRequestExpired('expired-1', 'MCP 输入请求');
    expect(notifyIfLateDecisionResponse('expired-1')).toBe(true);
    expect(notifyIfLateDecisionResponse('expired-1')).toBe(false);

    await vi.waitFor(() => expect(broadcastMock).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_NOTICE,
      expect.objectContaining({
        reasonCode: 'interaction_response_expired',
        params: { kind: 'MCP 输入请求' },
      }),
    ));
  });
});
