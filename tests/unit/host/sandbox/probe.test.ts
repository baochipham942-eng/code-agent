import { describe, expect, it, vi } from 'vitest';
import { formatOsSandboxProbe, probeOsSandbox } from '../../../../src/host/sandbox/probe';
import { getSandboxManager } from '../../../../src/host/sandbox';

describe('OS sandbox probe', () => {
  it('install hint names bubblewrap on Linux when unavailable', () => {
    const manager = getSandboxManager();
    const spy = vi.spyOn(manager, 'getStatus').mockReturnValue({
      platform: 'linux',
      available: false,
      error: 'bwrap missing',
    });
    try {
      expect(probeOsSandbox({ homeDir: '/Users/tester' }).installHint).toMatch(/bubblewrap/);
    } finally {
      spy.mockRestore();
    }
    const spyReady = vi.spyOn(manager, 'getStatus').mockReturnValue({
      platform: 'darwin',
      available: true,
      technology: 'Seatbelt',
    });
    try {
      expect(probeOsSandbox({ homeDir: '/Users/tester' }).installHint).toMatch(/ready/i);
    } finally {
      spyReady.mockRestore();
    }
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
