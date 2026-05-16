import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
  },
}));

import { useHandoffStore } from '../../../src/renderer/stores/handoffStore';
import { HANDOFF_CHANNELS } from '../../../src/shared/ipc/channels';
import type { HandoffProposal } from '../../../src/shared/contract/handoff';

const item: HandoffProposal = {
  id: 'handoff:session-1:assistant-1',
  sessionId: 'session-1',
  sourceMessageId: 'assistant-1',
  source: 'assistant_tail',
  status: 'pending',
  title: '继续验证',
  prompt: '继续验证。',
  reason: '结果还没回读。',
  createdAt: 100,
  updatedAt: 100,
};

describe('handoffStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHandoffStore.getState().reset();
  });

  it('loads pending proposals through handoff IPC', async () => {
    invokeMock.mockResolvedValueOnce([item]);

    await useHandoffStore.getState().load({ sessionId: 'session-1' });

    expect(invokeMock).toHaveBeenCalledWith(HANDOFF_CHANNELS.LIST, {
      status: 'pending',
      limit: 20,
      sessionId: 'session-1',
    });
    expect(useHandoffStore.getState().items).toEqual([item]);
  });

  it('removes a proposal locally when it is accepted', async () => {
    useHandoffStore.setState({ items: [item] });
    invokeMock.mockResolvedValueOnce({ ...item, status: 'accepted' });

    await useHandoffStore.getState().updateStatus(item.id, 'accepted');

    expect(invokeMock).toHaveBeenCalledWith(HANDOFF_CHANNELS.UPDATE_STATUS, {
      id: item.id,
      status: 'accepted',
    });
    expect(useHandoffStore.getState().items).toEqual([]);
  });
});
