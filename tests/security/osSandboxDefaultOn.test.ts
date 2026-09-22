import { describe, expect, it } from 'vitest';
import { OS_SANDBOX_CODES, isOsSandboxEnabled } from '../../src/shared/constants/sandbox';
import { resolveOsSandboxDecision } from '../../src/host/sandbox/osSandboxPolicy';

/**
 * Reverse mutation:
 * - default/acceptEdits apply=false while enabled+available+sandboxable → this file goes red
 * - isOsSandboxEnabled() treating unset env as false → this file goes red
 */
describe('OS sandbox default-on security contract', () => {
  it('unset OS_SANDBOX_ENABLED means enabled', () => {
    const previous = process.env.OS_SANDBOX_ENABLED;
    delete process.env.OS_SANDBOX_ENABLED;
    try {
      expect(isOsSandboxEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OS_SANDBOX_ENABLED;
      else process.env.OS_SANDBOX_ENABLED = previous;
    }
  });

  it('default and acceptEdits wrap ordinary bash when the jail is available', () => {
    for (const permissionMode of ['default', 'acceptEdits'] as const) {
      const decision = resolveOsSandboxDecision({
        command: 'echo hello',
        permissionMode,
        unattended: false,
        writeFence: false,
        evalRealRoot: false,
        multiRoot: false,
        sandboxAvailable: true,
        sandboxEnabled: true,
      });
      expect(decision.apply, permissionMode).toBe(true);
      expect(decision.sandboxed).toBe(true);
      expect(decision.code).toBe(OS_SANDBOX_CODES.APPLIED);
    }
  });
});
