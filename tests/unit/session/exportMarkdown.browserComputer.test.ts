import { describe, expect, it } from 'vitest';
import { exportSessionToMarkdown } from '../../../src/main/session/exportMarkdown';

describe('exportSessionToMarkdown Browser/Computer redaction', () => {
  it('redacts Browser/Computer tool details when markdown tool details are enabled', () => {
    const result = exportSessionToMarkdown({
      sessionId: 'session-1',
      startedAt: 1,
      lastActivityAt: 2,
      totalTokens: 0,
      messages: [{
        id: 'msg-1',
        role: 'assistant',
        content: 'Tool ran',
        timestamp: 1,
        metadata: {
          toolExecution: {
            tool: 'browser_action',
            input: {
              action: 'type',
              selector: '#email',
              text: 'secret@example.com',
            },
            output: 'Typed secret@example.com into #email',
          },
        },
      }],
    }, {
      includeToolDetails: true,
      includeMetadata: false,
      includeTimestamps: false,
    });

    expect(result.success).toBe(true);
    expect(result.markdown).toContain('[redacted 18 chars]');
    expect(result.markdown).toContain('#email');
    expect(result.markdown).not.toContain('secret@example.com');
  });
});
