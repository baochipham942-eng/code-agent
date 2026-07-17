import { describe, expect, it, vi } from 'vitest';

const persist = vi.fn();
vi.mock('../../../../src/host/session/browserComputerProofStore', () => ({
  persistBrowserComputerProofFromResult: (...args: unknown[]) => persist(...args),
}));

import { finalizeBrowserActionResult } from '../../../../src/host/tools/vision/browserActionFinalize';

describe('finalizeBrowserActionResult (ADR-041 M4)', () => {
  it('attaches proof + pointer and redacts binary-looking metadata for relay', () => {
    persist.mockClear();
    const result = finalizeBrowserActionResult({
      result: {
        success: true,
        output: 'Clicked button',
        metadata: {
          provider: 'browser-relay',
          data: 'A'.repeat(400),
          authToken: 'secret-token',
          selector: '#submit',
        },
      },
      action: 'click',
      params: { action: 'click', selector: '#submit', engine: 'relay' },
      provider: 'browser-relay',
      engineRoute: {
        selectedEngine: 'relay',
        requestedEngine: 'relay',
        reason: 'explicit_relay',
      },
      context: {
        sessionId: 'sess-1',
        currentToolCallId: 'tc-1',
      } as never,
    });

    expect(result.metadata?.provider).toBe('browser-relay');
    expect(result.metadata?.engine).toBe('relay');
    expect(result.metadata?.agentPointerEvent).toBeTruthy();
    expect(result.metadata?.browserComputerProof).toBeTruthy();
    expect(result.metadata?.authToken).toBe('[redacted]');
    expect(result.metadata?.data).toBe('[redacted-binary]');
    expect(persist).toHaveBeenCalledOnce();
    const persisted = persist.mock.calls[0]?.[0];
    expect(JSON.stringify(persisted)).not.toContain('secret-token');
  });

  it('includes structured recovery on failed engine routing', () => {
    const result = finalizeBrowserActionResult({
      result: {
        success: false,
        error: 'Relay not connected',
      },
      action: 'click',
      params: { action: 'click', engine: 'relay' },
      provider: 'browser-relay',
      recovery: {
        code: 'relay_not_connected',
        requestedEngine: 'relay',
        selectedEngine: null,
        recoverable: true,
        recommendedAction: 'start_browser_relay',
        availableEngines: ['auto', 'managed'],
        reason: 'Browser relay extension is not connected.',
      },
    });

    expect(result.success).toBe(false);
    expect(result.metadata?.recovery).toMatchObject({
      code: 'relay_not_connected',
      recommendedAction: 'start_browser_relay',
    });
    expect(result.metadata?.browserComputerProof).toBeTruthy();
  });
});
