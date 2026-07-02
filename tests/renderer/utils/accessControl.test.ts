import { describe, expect, it } from 'vitest';
import {
  canAccessAnyFeature,
  canAccessFeature,
  createAccessSubject,
} from '../../../src/renderer/utils/accessControl';

describe('renderer access control registry', () => {
  it('keeps internal quality surfaces admin-only', () => {
    expect(canAccessFeature('eval.center')).toBe(false);
    expect(canAccessFeature('eval.telemetry', { isAdmin: false })).toBe(false);
    expect(canAccessFeature('eval.replay', { isAdmin: true })).toBe(true);
    expect(canAccessFeature('eval.reviewQueue', { isAdmin: true })).toBe(true);
  });

  it('keeps user and invite management admin-only', () => {
    expect(canAccessFeature('settings.users', { isAdmin: false })).toBe(false);
    expect(canAccessFeature('settings.invites', { isAdmin: false })).toBe(false);
    expect(canAccessAnyFeature(['settings.users', 'settings.invites'], { isAdmin: true })).toBe(true);
  });

  it('keeps raw governance settings admin-only', () => {
    expect(canAccessFeature('settings.capabilities', { isAdmin: false })).toBe(false);
    expect(canAccessFeature('settings.controlPlane', { isAdmin: false })).toBe(false);
    expect(canAccessFeature('prompt.manager', { isAdmin: false })).toBe(false);
    expect(canAccessAnyFeature(['settings.capabilities', 'settings.controlPlane', 'prompt.manager'], { isAdmin: true })).toBe(true);
  });

  it('opens plugins/hooks configuration to all users (Settings IA v2, 2026-07-03 拍板)', () => {
    expect(canAccessFeature('settings.plugins', { isAdmin: false })).toBe(true);
    expect(canAccessFeature('settings.hooks', { isAdmin: false })).toBe(true);
  });

  it('normalizes loose user-like objects to an access subject', () => {
    expect(createAccessSubject({ isAdmin: true })).toEqual({ isAdmin: true });
    expect(createAccessSubject({ isAdmin: null })).toEqual({ isAdmin: false });
    expect(createAccessSubject(null)).toEqual({ isAdmin: false });
  });
});
