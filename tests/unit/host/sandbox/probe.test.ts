import { describe, expect, it, vi } from 'vitest';
import { formatOsSandboxProbe, osSandboxInstallHint, probeOsSandbox } from '../../../../src/host/sandbox/probe';
import { getSandboxManager } from '../../../../src/host/sandbox';

describe('OS sandbox probe', () => {
  it('install hint names bubblewrap on Linux when unavailable', () => {
    expect(osSandboxInstallHint('linux', false)).toMatch(/bubblewrap/);
    expect(osSandboxInstallHint('darwin', true)).toMatch(/ready/i);
  });

  it('probe snapshot includes rollout modes and sensitive denies with ~ prefix', () => {
    const probe = probeOsSandbox({ homeDir: '/Users/tester' });
    expect(probe.rolloutModes).toEqual(['default', 'acceptEdits']);
    expect(probe.sensitiveDeny.some((entry) => entry.path === '~/.npmrc')).toBe(true);
    expect(formatOsSandboxProbe(probe)).toContain('OS sandbox');
  });

  it('reports manager availability', () => {
    const manager = getSandboxManager();
    const spy = vi.spyOn(manager, 'getStatus').mockReturnValue({
      platform: 'darwin',
      available: false,
      technology: 'Seatbelt',
      error: 'sandbox-exec missing',
    });
    try {
      const probe = probeOsSandbox({ homeDir: '/Users/tester' });
      expect(probe.available).toBe(false);
      expect(probe.installHint).toMatch(/Seatbelt|sandbox-exec/i);
    } finally {
      spy.mockRestore();
    }
  });
});
