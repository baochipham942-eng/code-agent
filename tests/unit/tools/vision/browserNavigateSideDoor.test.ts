import { describe, expect, it } from 'vitest';
import {
  browserNavigateTool,
  LEGACY_BROWSER_NAVIGATE_ERROR_CODE,
} from '../../../../src/host/tools/vision/browserNavigate';
import type { ToolContext } from '../../../../src/host/tools/types';

const legacyActions = [
  'open',
  'navigate',
  'back',
  'forward',
  'refresh',
  'close',
  'newTab',
  'switchTab',
] as const;

function context(): ToolContext {
  return {
    sessionId: 'session-side-door',
    runId: 'run-side-door',
    agentId: 'agent-side-door',
    workingDirectory: process.cwd(),
    requestPermission: async () => true,
  };
}

describe('browser_navigate Surface boundary', () => {
  it.each(legacyActions)('fails %s closed before direct OS browser control', async (action) => {
    const result = await browserNavigateTool.execute({
      action,
      url: 'https://example.com/private?token=must-not-open',
      browser: 'chrome',
      tabIndex: 0,
    }, context());

    expect(result.success).toBe(false);
    expect(result.error).toContain(LEGACY_BROWSER_NAVIGATE_ERROR_CODE);
    expect(result.metadata?.surfaceExecutionErrorV1).toMatchObject({
      version: 1,
      code: 'SURFACE_POLICY_BLOCKED',
      phase: 'prepare',
      retryable: false,
      userActionRequired: true,
      surface: 'browser',
      provider: 'legacy-os-browser',
      sessionId: 'session-side-door',
      detailsSafe: { action },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-open');
  });

  it('keeps the legacy tool name and action schema for replay compatibility', () => {
    expect(browserNavigateTool.name).toBe('browser_navigate');
    expect(browserNavigateTool.inputSchema.properties?.action).toMatchObject({
      enum: [...legacyActions],
    });
  });
});
