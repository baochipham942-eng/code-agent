import { describe, expect, it } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import { resolveDirectRouting } from '../../../src/renderer/hooks/useAgent';

const agents = [
  { id: 'agent-builder', name: 'builder' },
  { id: 'agent-reviewer', name: 'reviewer' },
];

describe('resolveDirectRouting', () => {
  it('skips non-direct messages', () => {
    const envelope: ConversationEnvelope = {
      content: '正常走 auto',
      context: {
        routing: { mode: 'auto' },
      },
    };

    expect(resolveDirectRouting(envelope, agents)).toEqual({ kind: 'skip' });
  });

  it('resolves matched direct targets and reports missing ones', () => {
    const envelope: ConversationEnvelope = {
      content: '只发给 reviewer',
      context: {
        routing: {
          mode: 'direct',
          targetAgentIds: ['agent-reviewer', 'agent-missing'],
        },
      },
    };

    const resolution = resolveDirectRouting(envelope, agents);
    expect(resolution.kind).toBe('send');
    if (resolution.kind !== 'send') {
      throw new Error('expected send resolution');
    }

    expect(resolution.targets).toEqual([{ id: 'agent-reviewer', name: 'reviewer' }]);
    expect(resolution.missingTargetIds).toEqual(['agent-missing']);
  });

  it('rejects direct routing when attachments are present', () => {
    const envelope: ConversationEnvelope = {
      content: '带附件发给 builder',
      attachments: [
        {
          id: 'file-1',
          type: 'file',
          category: 'text',
          name: 'README.md',
          size: 12,
          mimeType: 'text/markdown',
        },
      ],
      context: {
        routing: {
          mode: 'direct',
          targetAgentIds: ['agent-builder'],
        },
      },
    };

    expect(resolveDirectRouting(envelope, agents)).toEqual({
      kind: 'error',
      reason: 'attachments-not-supported',
      targetIds: ['agent-builder'],
    });
  });
});
