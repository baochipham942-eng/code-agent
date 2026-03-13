import { describe, expect, it } from 'vitest';
import { detectStructuredToolFailure } from '../../../src/main/agent/runtime/toolResultNormalization';

describe('detectStructuredToolFailure', () => {
  it('detects explicit error payloads returned inside successful tool output', () => {
    const output = JSON.stringify({
      status: 'error',
      tool: 'web_search',
      error: 'Brave Search API error (429)',
    });

    expect(detectStructuredToolFailure(output)).toBe('Brave Search API error (429)');
  });

  it('ignores authorization handshakes that require user action', () => {
    const output = JSON.stringify({
      success: true,
      awaiting_authorization: true,
      message: 'Please authorize and retry.',
    });

    expect(detectStructuredToolFailure(output)).toBeNull();
  });

  it('ignores normal successful JSON payloads', () => {
    const output = JSON.stringify({
      success: true,
      messageId: 'om_123',
      chatId: 'oc_456',
    });

    expect(detectStructuredToolFailure(output)).toBeNull();
  });
});
