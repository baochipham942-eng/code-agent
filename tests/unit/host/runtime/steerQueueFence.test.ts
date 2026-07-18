import { describe, expect, it, vi } from 'vitest';
import type {
  ConversationEnvelope,
  ConversationEnvelopeContext,
  WorkbenchMessageMetadata,
} from '../../../../src/shared/contract/conversationEnvelope';
import type { MessageAttachment, MessageMetadata } from '../../../../src/shared/contract';
import { SteerRejectedError } from '../../../../src/host/agent/runtime/conversationRuntime';
import { SteerUnsupportedError } from '../../../../src/host/runtime/runContext';
import {
  queuePendingSteerMessages,
  steerOrQueue,
  workbenchMetadataToEnvelopeContext,
} from '../../../../src/host/runtime/steerQueueFence';

function createRepository() {
  return { enqueue: vi.fn() };
}

function createAttachment(id: string, name: string): MessageAttachment {
  return {
    id,
    type: 'file',
    category: 'document',
    name,
    size: 10,
    mimeType: 'text/plain',
    data: `${name} data`,
  };
}

function enqueuedEnvelope(repository: ReturnType<typeof createRepository>): ConversationEnvelope {
  const call = repository.enqueue.mock.calls[0]?.[0];
  if (!call) {
    throw new Error('Expected repository.enqueue to have been called');
  }
  return call.envelope as ConversationEnvelope;
}

describe('workbenchMetadataToEnvelopeContext', () => {
  it('returns undefined for missing or empty metadata', () => {
    expect(workbenchMetadataToEnvelopeContext()).toBeUndefined();
    expect(workbenchMetadataToEnvelopeContext({})).toBeUndefined();
  });

  it('inverts every field handled by AgentAppServiceImpl.toWorkbenchMetadata', () => {
    const workbench: WorkbenchMessageMetadata = {
      workingDirectory: '/workspace',
      preferredAgentId: 'agent-1',
      preferredAgentName: 'Builder',
      selectedAgent: { id: 'agent-2', name: 'Reviewer', via: 'agent_chip' },
      selectedPromptCommand: {
        name: 'review',
        source: 'builtin',
        hints: ['focus on lifecycle'],
        via: 'slash_picker',
      },
      routingMode: 'parallel',
      targetAgentIds: ['agent-2', 'agent-3'],
      selectedSkillIds: ['skill-1'],
      selectedConnectorIds: ['connector-1'],
      selectedMcpServerIds: ['mcp-1'],
      turnCapabilityScopeMode: 'manual',
      designBrief: { intent: 'Keep the queue durable', source: 'manual' },
      executionIntent: { preferDesktopContext: true, allowBrowserAutomation: false },
      runtimeInputMode: 'redirect',
      runtimeInputDelivery: 'queued_next_turn',
      voiceInput: { inputSource: 'voice', language: 'zh-CN', transcriptChars: 12 },
    };

    expect(workbenchMetadataToEnvelopeContext(workbench)).toEqual({
      workingDirectory: '/workspace',
      preferredAgentId: 'agent-1',
      preferredAgentName: 'Builder',
      selectedAgent: { id: 'agent-2', name: 'Reviewer', via: 'agent_chip' },
      selectedPromptCommand: {
        name: 'review',
        source: 'builtin',
        hints: ['focus on lifecycle'],
        via: 'slash_picker',
      },
      routing: { mode: 'parallel', targetAgentIds: ['agent-2', 'agent-3'] },
      selectedSkillIds: ['skill-1'],
      selectedConnectorIds: ['connector-1'],
      selectedMcpServerIds: ['mcp-1'],
      turnCapabilityScopeMode: 'manual',
      designBrief: { intent: 'Keep the queue durable', source: 'manual' },
      executionIntent: { preferDesktopContext: true, allowBrowserAutomation: false },
      runtimeInput: { mode: 'redirect', delivery: 'queued_next_turn' },
      voiceInput: { inputSource: 'voice', language: 'zh-CN', transcriptChars: 12 },
    });
  });
});

describe('steerOrQueue', () => {
  it('returns steered without touching the durable queue when steer succeeds', async () => {
    const repository = createRepository();
    const steer = vi.fn().mockResolvedValue(undefined);

    await expect(steerOrQueue(
      { steer },
      { sessionId: 'session-1', content: 'new direction', clientMessageId: 'message-1' },
      repository,
    )).resolves.toEqual({ outcome: 'steered' });

    expect(steer).toHaveBeenCalledWith('new direction', 'message-1', undefined, undefined);
    expect(repository.enqueue).not.toHaveBeenCalled();
  });

  it('queues a settled-run rejection with generated identity and the original payload', async () => {
    const repository = createRepository();
    const attachments = [createAttachment('attachment-1', 'brief.txt')];
    const context: ConversationEnvelopeContext = { workingDirectory: '/web-workspace' };
    const metadata: MessageMetadata = {
      workbench: { workingDirectory: '/metadata-workspace' },
    };

    await expect(steerOrQueue(
      { steer: vi.fn().mockRejectedValue(new SteerRejectedError()) },
      {
        sessionId: 'session-settled',
        content: 'continue after settlement',
        attachments,
        metadata,
        context,
      },
      repository,
      { generateId: () => 'generated-message-id', now: () => 123 },
    )).resolves.toEqual({ outcome: 'queued', queuedInputId: 'generated-message-id' });

    expect(repository.enqueue).toHaveBeenCalledOnce();
    expect(repository.enqueue).toHaveBeenCalledWith({
      id: 'generated-message-id',
      sessionId: 'session-settled',
      envelope: {
        content: 'continue after settlement',
        clientMessageId: 'generated-message-id',
        sessionId: 'session-settled',
        attachments,
        context,
      },
      now: 123,
    });
    expect(enqueuedEnvelope(repository).context).toBe(context);
  });

  it('queues an unsupported steer with a stable caller id and context derived from metadata', async () => {
    const repository = createRepository();
    const metadata: MessageMetadata = {
      workbench: {
        workingDirectory: '/desktop-workspace',
        routingMode: 'direct',
        targetAgentIds: ['agent-4'],
        runtimeInputMode: 'supplement',
        runtimeInputDelivery: 'in_flight',
      },
    };

    await expect(steerOrQueue(
      { steer: vi.fn().mockRejectedValue(new SteerUnsupportedError('run-external')) },
      {
        sessionId: 'session-external',
        content: 'next external turn',
        clientMessageId: 'caller-message-id',
        metadata,
      },
      repository,
    )).resolves.toEqual({ outcome: 'queued', queuedInputId: 'caller-message-id' });

    expect(repository.enqueue).toHaveBeenCalledOnce();
    expect(repository.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: 'caller-message-id',
      sessionId: 'session-external',
    }));
    expect(enqueuedEnvelope(repository)).toEqual({
      content: 'next external turn',
      clientMessageId: 'caller-message-id',
      sessionId: 'session-external',
      attachments: undefined,
      context: {
        workingDirectory: '/desktop-workspace',
        routing: { mode: 'direct', targetAgentIds: ['agent-4'] },
        runtimeInput: { mode: 'supplement', delivery: 'in_flight' },
      },
    });
  });

  it('rethrows an unrelated error unchanged and does not queue it', async () => {
    const repository = createRepository();
    const error = new Error('db write failed');

    await expect(steerOrQueue(
      { steer: vi.fn().mockRejectedValue(error) },
      { sessionId: 'session-bug', content: 'do not hide this failure' },
      repository,
    )).rejects.toBe(error);

    expect(repository.enqueue).not.toHaveBeenCalled();
  });
});

describe('queuePendingSteerMessages', () => {
  it('queues every pending message independently in order without merging their payloads', () => {
    const repository = createRepository();
    const attachments = [
      [createAttachment('attachment-1', 'first.txt')],
      [createAttachment('attachment-2', 'second.txt')],
      [createAttachment('attachment-3', 'third.txt')],
    ];
    const metadata: MessageMetadata[] = [
      { workbench: { workingDirectory: '/one' } },
      { workbench: { selectedSkillIds: ['skill-two'] } },
      { workbench: { runtimeInputMode: 'redirect', runtimeInputDelivery: 'queued_next_turn' } },
    ];
    const generatedIds = ['generated-1', 'generated-3'];

    const ids = queuePendingSteerMessages(
      'session-pending',
      [
        {
          content: 'first pending steer',
          attachments: attachments[0],
          metadata: metadata[0],
        },
        {
          content: 'second pending steer',
          clientMessageId: 'stable-second-id',
          attachments: attachments[1],
          metadata: metadata[1],
        },
        {
          content: 'third pending steer',
          attachments: attachments[2],
          metadata: metadata[2],
        },
      ],
      repository,
      { generateId: () => generatedIds.shift() ?? 'unexpected-id', now: () => 456 },
    );

    expect(ids).toEqual(['generated-1', 'stable-second-id', 'generated-3']);
    expect(repository.enqueue).toHaveBeenCalledTimes(3);
    expect(repository.enqueue.mock.calls.map(([input]) => input)).toEqual([
      {
        id: 'generated-1',
        sessionId: 'session-pending',
        envelope: {
          content: 'first pending steer',
          clientMessageId: 'generated-1',
          sessionId: 'session-pending',
          attachments: attachments[0],
          context: { workingDirectory: '/one' },
        },
        now: 456,
      },
      {
        id: 'stable-second-id',
        sessionId: 'session-pending',
        envelope: {
          content: 'second pending steer',
          clientMessageId: 'stable-second-id',
          sessionId: 'session-pending',
          attachments: attachments[1],
          context: { selectedSkillIds: ['skill-two'] },
        },
        now: 456,
      },
      {
        id: 'generated-3',
        sessionId: 'session-pending',
        envelope: {
          content: 'third pending steer',
          clientMessageId: 'generated-3',
          sessionId: 'session-pending',
          attachments: attachments[2],
          context: {
            runtimeInput: { mode: 'redirect', delivery: 'queued_next_turn' },
          },
        },
        now: 456,
      },
    ]);
  });
});
