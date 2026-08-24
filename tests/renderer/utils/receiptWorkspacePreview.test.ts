import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { buildWorkspacePreviewSections } from '../../../src/renderer/utils/workspacePreview';

describe('receipt workspace preview third bucket', () => {
  it('uses the first recipient plus total on the card and keeps all recipients in expanded detail only', () => {
    const preview = [
      '已发送邮件：周报',
      'To: zhang@example.com, li@example.com, wang@example.com',
    ].join('\n');
    const messages: Message[] = [{
      id: 'message-mail',
      role: 'assistant',
      content: '',
      timestamp: 1_700_000_000_000,
      toolCalls: [{
        id: 'tool-mail',
        name: 'mail_send',
        arguments: {},
        result: {
          toolCallId: 'tool-mail',
          success: true,
          metadata: {
            to: ['zhang@example.com', 'li@example.com', 'wang@example.com'],
            toCount: 3,
            previewItem: {
              kind: 'message_draft',
              title: '不应旁路进产物桶',
              status: 'ready',
            },
            artifact: {
              artifactId: 'receipt-mail',
              kind: 'text',
              role: 'receipt',
              sourceTool: 'mail_send',
              name: '已发送邮件：周报',
              preview,
              metadata: { connector: 'mail' },
            },
          },
        },
      }],
    }];

    const { items, materialItems, receiptItems } = buildWorkspacePreviewSections({ messages });

    expect(items).toEqual([]);
    expect(materialItems).toEqual([]);
    expect(receiptItems).toHaveLength(1);
    expect(receiptItems[0]).toMatchObject({
      title: '已发送邮件：周报',
      status: 'ready',
      content: { text: preview },
      receipt: {
        connector: 'mail',
        recipient: { first: 'zhang@example.com', count: 3 },
      },
    });
    expect(receiptItems[0].title).not.toContain('li@example.com');
    expect(receiptItems[0].title).not.toContain('wang@example.com');
  });

  it('deduplicates the same receipt across current-turn and historical projections', () => {
    const artifact = {
      artifactId: 'receipt-one',
      kind: 'text',
      role: 'receipt' as const,
      sourceTool: 'calendar_create_event',
      name: '已创建日历事件：评审会',
      preview: '已创建日历事件：评审会',
      metadata: { connector: 'calendar' },
    };
    const messages: Message[] = [{
      id: 'message-calendar',
      role: 'assistant',
      content: '',
      timestamp: 100,
      toolCalls: [{
        id: 'tool-calendar',
        name: 'calendar_create_event',
        arguments: {},
        result: { toolCallId: 'tool-calendar', success: true, metadata: { artifact } },
      }],
    }];

    const sections = buildWorkspacePreviewSections({
      messages,
      currentTurnArtifacts: {
        turnNumber: 1,
        artifactOwnership: [{
          kind: 'artifact',
          label: artifact.name,
          role: 'receipt',
          ownerKind: 'tool',
          ownerLabel: artifact.sourceTool,
          artifactId: artifact.artifactId,
          receipt: {
            status: 'succeeded',
            summary: artifact.name,
            detail: artifact.preview,
            sourceTool: artifact.sourceTool,
          },
        }],
      },
    });

    expect(sections.receiptItems).toHaveLength(1);
  });
});
