import { describe, expect, it } from 'vitest';
import {
  SurfaceCapabilityRegistry,
  SurfaceCapabilityUnsupportedError,
} from '../../../../src/host/services/surfaceExecution/SurfaceCapabilityRegistry';

describe('SurfaceCapabilityRegistry', () => {
  const registry = new SurfaceCapabilityRegistry();

  it('maps existing Browser/Computer catalog entries into Host-enforceable capabilities', () => {
    expect(registry.resolve('browser_action', 'navigate', { action: 'navigate' })).toMatchObject({
      surface: 'browser',
      mutation: true,
      capabilities: expect.arrayContaining(['input', 'navigate']),
    });
    expect(registry.resolve('computer_use', 'observe', { operation: 'observe' })).toMatchObject({
      surface: 'computer',
      mutation: false,
      capabilities: ['observe'],
    });
    expect(registry.resolve('browser_action', 'type', {
      action: 'type',
      selector: '#name',
      text: 'ordinary text',
    }).capabilities).not.toContain('secret');
    expect(registry.resolve('browser_action', 'type', {
      action: 'type',
      selector: '#password',
      secretRef: 'env:TEST_PASSWORD',
    }).capabilities).toContain('secret');
    expect(registry.resolve('browser_action', 'clear_cookies', {
      action: 'clear_cookies',
    }).capabilities).toContain('destructive');
    expect(registry.resolve('browser_action', 'import_profile_cookies', {
      action: 'import_profile_cookies',
    }).capabilities).toContain('secret');
  });

  it('fails closed for unknown operations rather than inheriting a permissive default', () => {
    expect(() => registry.resolve('browser_action', 'attach_any_tab', {
      action: 'attach_any_tab',
    })).toThrow(SurfaceCapabilityUnsupportedError);
  });

  it('checks the runtime grant instead of treating the catalog as authorization', () => {
    expect(() => registry.assertGrantCapabilities(['input'], ['observe']))
      .toThrow(SurfaceCapabilityUnsupportedError);
    expect(() => registry.assertGrantCapabilities(['observe'], ['observe', 'input']))
      .not.toThrow();
  });
});
