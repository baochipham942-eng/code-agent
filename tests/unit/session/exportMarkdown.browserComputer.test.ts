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

  it('applies the shared Sensitive Data Guard to exported conversation text', () => {
    const result = exportSessionToMarkdown({
      sessionId: 'session-1',
      startedAt: 1,
      lastActivityAt: 2,
      totalTokens: 0,
      messages: [{
        id: 'msg-1',
        role: 'user',
        content: 'Contact alice@example.com with token=secret-token at /Users/linchen/private.txt via https://example.com/path?token=secret-token',
        timestamp: 1,
      }],
    }, {
      includeMetadata: false,
      includeTimestamps: false,
    });

    expect(result.success).toBe(true);
    expect(result.markdown).not.toContain('alice@example.com');
    expect(result.markdown).not.toContain('secret-token');
    expect(result.markdown).not.toContain('/Users/linchen');
    expect(result.markdown).toContain('https://example.com/path');
  });

  it('redacts Browser/Computer proof refs in markdown exports', () => {
    const result = exportSessionToMarkdown({
      sessionId: 'session-1',
      startedAt: 1,
      lastActivityAt: 2,
      totalTokens: 0,
      metadata: {
        evidenceRefs: [{
          id: 'evidence-path',
          kind: 'screenshot',
          ref: '/Users/linchen/Desktop/private.png',
          source: 'screenshot',
          freshness: { capturedAtMs: 1, state: 'fresh' },
          redactionStatus: 'clean',
        }, {
          id: 'evidence-base64',
          kind: 'screenshot',
          ref: 'data:image/png;base64,abcdef',
          source: 'screenshot',
          freshness: { capturedAtMs: 1, state: 'fresh' },
          redactionStatus: 'clean',
        }],
      },
      messages: [{
        id: 'msg-1',
        role: 'assistant',
        content: 'Proof test',
        timestamp: 1,
        metadata: {
          toolExecution: {
            tool: 'screenshot',
            input: { analyze: false },
            output: 'Screenshot saved',
          },
        },
      }],
    }, {
      includeToolDetails: true,
      includeMetadata: true,
      includeTimestamps: false,
    });

    expect(result.success).toBe(true);
    expect(result.markdown).not.toContain('/Users/linchen');
    expect(result.markdown).not.toContain('base64,abcdef');
  });

  it('exports sanitized Browser/Computer pointer timeline lines', () => {
    const result = exportSessionToMarkdown({
      sessionId: 'session-1',
      startedAt: 1,
      lastActivityAt: 2,
      totalTokens: 0,
      messages: [{
        id: 'msg-1',
        role: 'assistant',
        content: 'Pointer test',
        timestamp: 1,
        metadata: {
          toolExecution: {
            tool: 'computer_use',
            input: {
              action: 'type',
              targetApp: 'Notes',
              text: 'secret@example.com',
            },
            metadata: {
              agentPointerTimeline: [{
                id: 'pointer-export',
                surface: 'computer',
                tone: 'computer',
                phase: 'type',
                coordSpace: 'windowLocal',
                point: { x: 40, y: 24, unit: 'px' },
                targetLabel: 'secret@example.com',
                targetSource: 'axPath',
                traceId: 'trace-export',
                success: true,
                occurredAtMs: 1,
              }, {
                id: 'pointer-export-scroll',
                surface: 'browser',
                tone: 'browser',
                phase: 'scroll',
                coordSpace: 'browserViewport',
                point: { x: 30, y: 70, unit: 'px' },
                targetLabel: 'cookie=session-secret data:image/png;base64,abcdef',
                targetSource: 'selector',
                traceId: 'trace-export',
                success: true,
                occurredAtMs: 2,
              }],
            },
            output: 'Typed secret@example.com',
          },
        },
      }],
    }, {
      includeToolDetails: true,
      includeMetadata: false,
      includeTimestamps: false,
      guardSensitiveData: false,
    });

    expect(result.success).toBe(true);
    expect(result.markdown).toContain('**Pointer:**');
    expect(result.markdown).toContain('Computer input');
    expect(result.markdown).toContain('Browser scroll');
    expect(result.markdown).toContain('[redacted 18 chars]');
    expect(result.markdown).not.toContain('secret@example.com');
    expect(result.markdown).not.toContain('session-secret');
    expect(result.markdown).not.toContain('base64,abcdef');
  });

  it('exports Browser/Computer evidence card status without raw proof refs', () => {
    const result = exportSessionToMarkdown({
      sessionId: 'session-1',
      startedAt: 1,
      lastActivityAt: 2,
      totalTokens: 0,
      messages: [{
        id: 'msg-1',
        role: 'assistant',
        content: 'Evidence card test',
        timestamp: 1,
        metadata: {
          toolExecution: {
            tool: 'browser_action',
            input: {
              action: 'type',
              selector: '#password',
              text: 'secret@example.com',
            },
            metadata: {
              browserComputerEvidenceCard: {
                title: 'Browser/Computer Evidence',
                status: 'manual_takeover',
                summary: 'Manual takeover required: login_required',
                evidenceRefIds: ['evidence_dom', 'evidence_path'],
              },
              browserComputerProof: {
                evidenceRefs: [{
                  id: 'evidence_path',
                  kind: 'screenshot',
                  ref: '/Users/linchen/Desktop/private.png',
                  source: 'browserAction.screenshot',
                  freshness: { capturedAtMs: 1, state: 'fresh' },
                  redactionStatus: 'clean',
                }],
              },
            },
            output: 'Typed secret@example.com',
          },
        },
      }],
    }, {
      includeToolDetails: true,
      includeMetadata: false,
      includeTimestamps: false,
      guardSensitiveData: false,
    });

    expect(result.success).toBe(true);
    expect(result.markdown).toContain('**Evidence:**');
    expect(result.markdown).toContain('Browser/Computer Evidence: manual_takeover');
    expect(result.markdown).toContain('Manual takeover required: login_required');
    expect(result.markdown).toContain('refs evidence_dom, evidence_path');
    expect(result.markdown).not.toContain('/Users/linchen');
    expect(result.markdown).not.toContain('secret@example.com');
  });
});
