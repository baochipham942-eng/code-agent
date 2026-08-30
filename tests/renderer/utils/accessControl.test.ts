import { describe, expect, it } from 'vitest';
import {
  ACCESS_CONTROL_REGISTRY,
  canAccessFeature,
  createAccessSubject,
} from '../../../src/renderer/utils/accessControl';

describe('renderer access control registry', () => {
  it('keeps internal capability packages admin-only without registering eval surfaces in core', () => {
    expect(canAccessFeature('capability.internal')).toBe(false);
    expect(canAccessFeature('capability.internal', { isAdmin: false })).toBe(false);
    expect(canAccessFeature('capability.internal', { isAdmin: true })).toBe(true);
    expect(ACCESS_CONTROL_REGISTRY).not.toHaveProperty('eval.center');
    expect(ACCESS_CONTROL_REGISTRY).not.toHaveProperty('eval.telemetry');
    expect(ACCESS_CONTROL_REGISTRY).not.toHaveProperty('eval.replay');
    expect(canAccessFeature('telemetry.replay', { isAdmin: false })).toBe(false);
    expect(canAccessFeature('telemetry.replay', { isAdmin: true })).toBe(true);
  });

  it('keeps prompt manager admin-only', () => {
    expect(canAccessFeature('prompt.manager', { isAdmin: false })).toBe(false);
    expect(canAccessFeature('prompt.manager', { isAdmin: true })).toBe(true);
  });

  it('管理组迁 admin-console 后不再注册 settings.users/invites/controlPlane/capabilities（2026-07 方案 9C）', () => {
    expect(ACCESS_CONTROL_REGISTRY).not.toHaveProperty('settings.users');
    expect(ACCESS_CONTROL_REGISTRY).not.toHaveProperty('settings.invites');
    expect(ACCESS_CONTROL_REGISTRY).not.toHaveProperty('settings.controlPlane');
    expect(ACCESS_CONTROL_REGISTRY).not.toHaveProperty('settings.capabilities');
  });

  it('keeps plugins admin-only while hooks remain available to regular users', () => {
    expect(canAccessFeature('settings.plugins', { isAdmin: false })).toBe(false);
    expect(canAccessFeature('settings.plugins', { isAdmin: true })).toBe(true);
    expect(canAccessFeature('settings.hooks', { isAdmin: false })).toBe(true);
  });

  it('normalizes loose user-like objects to an access subject', () => {
    expect(createAccessSubject({ isAdmin: true })).toEqual({ isAdmin: true });
    expect(createAccessSubject({ isAdmin: null })).toEqual({ isAdmin: false });
    expect(createAccessSubject(null)).toEqual({ isAdmin: false });
  });
});
