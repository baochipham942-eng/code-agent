import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, SessionTask } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  updateMessage: vi.fn(),
  replaceTasksAtomically: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: mocks.getMessages,
    updateMessage: mocks.updateMessage,
  }),
}));

vi.mock('../../../src/host/services/planning/taskStore', () => ({
  replaceTasksAtomically: mocks.replaceTasksAtomically,
}));

import { resolvePlanApproval } from '../../../src/host/services/planning/planApprovalService';

function planMessage(status: 'pending' | 'approved' = 'pending'): Message {
  return {
    id: 'message-plan',
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolCalls: [{
      id: 'tool-plan',
      name: 'exit_plan_mode',
      arguments: { plan: '1. Read code\n2. Implement UI' },
      result: {
        toolCallId: 'tool-plan',
        success: true,
        metadata: {
          confirmationType: 'plan_approval',
          plan: '1. Read code\n2. Implement UI',
          planApproval: {
            status,
            originalPlan: '1. Read code\n2. Implement UI',
            steps: [
              { id: 'step-1', content: 'Read code', originalContent: 'Read code' },
              { id: 'step-2', content: 'Implement UI', originalContent: 'Implement UI' },
            ],
          },
        },
      },
    }],
  };
}

const tasks: SessionTask[] = [{
  id: '1',
  subject: 'Read host code',
  description: 'Read host code',
  activeForm: 'Read host code',
  status: 'in_progress',
  priority: 'normal',
  blocks: [],
  blockedBy: [],
  metadata: { source: 'plan_approval' },
  createdAt: 1,
  updatedAt: 1,
}];

describe('resolvePlanApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMessages.mockResolvedValue([planMessage()]);
    mocks.updateMessage.mockResolvedValue(undefined);
    mocks.replaceTasksAtomically.mockReturnValue(tasks);
  });

  it('persists edited steps, atomically replaces the ledger, and starts a new approved user turn', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitAgentEventForSession = vi.fn();
    const response = await resolvePlanApproval({
      sessionId: 'session-1',
      messageId: 'message-plan',
      toolCallId: 'tool-plan',
      decision: 'approve',
      steps: [
        { id: 'step-1', content: 'Read host code', originalContent: 'Read code', edited: true },
        { id: 'step-2', content: 'Implement UI', originalContent: 'Implement UI' },
      ],
    }, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession } as never,
    });

    expect(mocks.replaceTasksAtomically).toHaveBeenCalledWith(
      'session-1',
      ['Read host code', 'Implement UI'],
    );
    expect(response.approval.status).toBe('approved');
    expect(response.tasks).toEqual(tasks);
    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    expect(emitAgentEventForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'task_update' }),
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      content: expect.stringContaining('<approved-plan>\n1. Read host code\n2. Implement UI\n</approved-plan>'),
      options: expect.objectContaining({ historyVisibility: 'meta' }),
    }));
  });

  it('cancels structurally without replacing tasks or continuing the agent', async () => {
    const sendMessage = vi.fn();
    const response = await resolvePlanApproval({
      sessionId: 'session-1',
      messageId: 'message-plan',
      toolCallId: 'tool-plan',
      decision: 'cancel',
    }, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    });

    expect(response.approval.status).toBe('cancelled');
    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    expect(mocks.replaceTasksAtomically).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects replay after the approval is already resolved', async () => {
    mocks.getMessages.mockResolvedValue([planMessage('approved')]);
    await expect(resolvePlanApproval({
      sessionId: 'session-1',
      messageId: 'message-plan',
      toolCallId: 'tool-plan',
      decision: 'cancel',
    }, {
      appService: { sendMessage: vi.fn() } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    })).rejects.toMatchObject({ code: 'ALREADY_RESOLVED' });
  });
});
