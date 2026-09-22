import { describe, expect, it, vi } from 'vitest';
import { OS_SANDBOX_DOCTOR_ITEM_NAME } from '../../../../src/shared/constants/sandbox';
import { getSandboxManager } from '../../../../src/host/sandbox';
import { checkOsSandbox } from '../../../../src/host/diagnostics/checks/sandbox';

describe('checkOsSandbox', () => {
  it('passes when the manager reports available', () => {
    const spy = vi.spyOn(getSandboxManager(), 'getStatus').mockReturnValue({
      platform: 'darwin',
      available: true,
      technology: 'Seatbelt',
      version: 'sandbox-exec',
    });
    try {
      const item = checkOsSandbox();
      expect(item.name).toBe(OS_SANDBOX_DOCTOR_ITEM_NAME);
      expect(item.category).toBe('environment');
      expect(item.status).toBe('pass');
      expect(item.message).toMatch(/Seatbelt/);
    } finally {
      spy.mockRestore();
    }
  });

  it('warns when unavailable instead of failing closed at doctor time', () => {
    const spy = vi.spyOn(getSandboxManager(), 'getStatus').mockReturnValue({
      platform: 'linux',
      available: false,
      error: 'bwrap missing',
    });
    try {
      const item = checkOsSandbox();
      expect(item.status).toBe('warn');
      expect(item.suggestion).toMatch(/bubblewrap|bwrap/);
    } finally {
      spy.mockRestore();
    }
  });
});
