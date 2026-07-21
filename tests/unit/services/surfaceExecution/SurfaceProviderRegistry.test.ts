import { describe, expect, it } from 'vitest';
import {
  SURFACE_PROVIDER_G4_DECISIONS_V1,
  SurfaceProviderRegistry,
  SurfaceProviderRegistryError,
} from '../../../../src/host/services/surfaceExecution/SurfaceProviderRegistry';

describe('SurfaceProviderRegistry', () => {
  it('declares current Browser and Computer providers with separate target, input, and cleanup boundaries', () => {
    const registry = new SurfaceProviderRegistry();

    expect(registry.describe('system-chrome-cdp')).toMatchObject({
      providerClass: 'browser',
      executionSurface: 'browser',
      availability: 'available',
      operations: expect.arrayContaining(['navigate', 'screenshot']),
      boundaries: {
        target: { kind: 'browser-tab-document', authority: 'host-issued' },
        input: { delivery: 'host-mediated', rawAuthority: 'forbidden' },
        cleanup: {
          owner: 'host',
          obligations: expect.arrayContaining(['close-isolated-context', 'revoke-grant']),
          failureCode: 'SURFACE_CLEANUP_FAILED',
        },
      },
    });
    expect(registry.describe('browser-relay')).toMatchObject({
      providerClass: 'browser',
      boundaries: {
        cleanup: {
          obligations: expect.arrayContaining(['return-borrowed-tab', 'revoke-tab-lease']),
        },
      },
    });
    expect(registry.describe('cua-driver')).toMatchObject({
      providerClass: 'computer',
      executionSurface: 'computer',
      operations: ['act'],
      boundaries: {
        target: { kind: 'computer-app-window', authority: 'host-issued' },
        cleanup: {
          obligations: expect.arrayContaining(['release-input-lock', 'end-provider-session']),
        },
      },
    });
  });

  it('declares future provider classes without making gated providers executable', () => {
    const registry = new SurfaceProviderRegistry();
    const future = registry.list().filter((provider) => provider.availability === 'gated');

    expect(future.map((provider) => provider.providerClass)).toEqual(expect.arrayContaining([
      'multi-browser',
      'remote-browser',
      'mobile',
      'in-app-preview',
    ]));
    expect(future.every((provider) => (
      provider.decisionGate === 'G4'
      && provider.boundaries.target.authority === 'host-issued'
      && provider.boundaries.input.rawAuthority === 'forbidden'
      && provider.boundaries.cleanup.obligations.length > 0
    ))).toBe(true);

    expect(() => registry.resolveForExecution({
      providerId: 'future:remote-managed',
      surface: 'browser',
      operation: 'screenshot',
      requiredCapabilities: ['observe'],
      payloadBytes: 100,
    })).toThrowError(expect.objectContaining({
      code: 'SURFACE_CAPABILITY_UNSUPPORTED',
      reason: 'provider_gate_pending',
    }));
  });

  it('fails closed with stable reasons for unknown providers, unsupported operations, and oversized input', () => {
    const registry = new SurfaceProviderRegistry();
    const resolve = (overrides: Partial<Parameters<SurfaceProviderRegistry['resolveForExecution']>[0]> = {}) => (
      registry.resolveForExecution({
        providerId: 'system-chrome-cdp',
        surface: 'browser',
        operation: 'screenshot',
        requiredCapabilities: ['observe'],
        payloadBytes: 100,
        ...overrides,
      })
    );

    expect(() => resolve({ providerId: 'unregistered-provider' })).toThrowError(
      expect.objectContaining({ reason: 'provider_not_registered' }),
    );
    expect(() => resolve({ operation: 'attach_any_tab' })).toThrowError(
      expect.objectContaining({ reason: 'operation_unsupported' }),
    );
    expect(() => resolve({ payloadBytes: 256 * 1024 + 1 })).toThrowError(
      expect.objectContaining({ reason: 'payload_too_large' }),
    );
    expect(() => resolve({ surface: 'computer' })).toThrowError(
      expect.objectContaining({ reason: 'surface_mismatch' }),
    );
  });

  it('supports provider-neutral registration while retaining the same fail-closed execution API', () => {
    const registry = new SurfaceProviderRegistry([]);
    registry.register({
      version: 1,
      providerId: 'vendor:multi-browser',
      providerClass: 'multi-browser',
      executionSurface: 'browser',
      availability: 'available',
      capabilities: ['observe'],
      operations: ['screenshot'],
      boundaries: {
        target: {
          kind: 'browser-tab-document',
          authority: 'host-issued',
          revisionRequired: true,
        },
        input: {
          delivery: 'host-mediated',
          rawAuthority: 'forbidden',
          secretTransport: 'reference-only',
          maxPayloadBytes: 1_024,
        },
        cleanup: {
          owner: 'provider',
          obligations: ['close-provider-context'],
          failureCode: 'SURFACE_CLEANUP_FAILED',
        },
      },
    });

    expect(registry.resolveForExecution({
      providerId: 'vendor:multi-browser',
      surface: 'browser',
      operation: 'screenshot',
      requiredCapabilities: ['observe'],
      payloadBytes: 100,
    })).toMatchObject({ providerClass: 'multi-browser', availability: 'available' });
    expect(() => registry.register(registry.describe('vendor:multi-browser')!))
      .toThrow(/duplicated/);
    expect(SurfaceProviderRegistryError).toBeDefined();
  });

  it('records G4 provider investments as evidence-backed defers with measurable gates', () => {
    expect(SURFACE_PROVIDER_G4_DECISIONS_V1.map((decision) => decision.row)).toEqual(
      expect.arrayContaining([
        'multi-browser-provider',
        'remote-managed-browser-pool',
        'mobile-device-cloud',
        'windows-linux-profile-and-computer-provider',
        'in-app-preview-provider',
      ]),
    );
    expect(SURFACE_PROVIDER_G4_DECISIONS_V1.every((decision) => (
      decision.status === 'evidence-backed-defer'
      && decision.gate === 'G4'
      && decision.reason.length > 20
      && decision.evidenceRequired.length >= 3
    ))).toBe(true);
  });
});
