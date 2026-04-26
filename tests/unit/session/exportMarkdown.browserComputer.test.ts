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

  it('summarizes Browser/Computer profile paths in markdown metadata headers', () => {
    const result = exportSessionToMarkdown({
      sessionId: 'session-1',
      startedAt: 1,
      lastActivityAt: 2,
      totalTokens: 0,
      metadata: {
        profileDir: '/Users/linchen/Library/Application Support/code-agent/managed-browser-profile',
        artifactDir: '/Users/linchen/Downloads/ai/code-agent/.workbench/artifacts/run-42',
        workspacePath: '/Users/linchen/Downloads/ai/code-agent',
        cookie: 'cookie-secret',
      },
      messages: [{
        id: 'msg-1',
        role: 'assistant',
        content: 'Metadata test',
        timestamp: 1,
      }],
    }, {
      includeToolDetails: false,
      includeMetadata: true,
      includeTimestamps: false,
    });

    expect(result.success).toBe(true);
    expect(result.markdown).toContain('artifactDir: .../run-42');
    expect(result.markdown).toContain('workspacePath: .../code-agent');
    expect(result.markdown).not.toContain('/Users/linchen');
    expect(result.markdown).not.toContain('cookie-secret');
    expect(result.markdown).not.toContain('profileDir');
  });
});
