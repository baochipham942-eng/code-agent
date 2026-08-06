import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  createManagedBrowserLease,
  isManagedBrowserLeaseExpired,
  listOrphanManagedBrowserSurfaceProfileDirs,
  ORPHAN_MANAGED_BROWSER_SURFACE_PROFILE_POLICY,
  resolveManagedBrowserProfile,
  resolveManagedBrowserProxyConfig,
  shouldCleanupManagedBrowserProfile,
} from '../../../../src/host/services/infra/browserService';

describe('browser service profile resolver', () => {
  it('keeps the default persistent profile compatible with managed-browser-profile', () => {
    const userDataDir = path.join('/tmp', 'code-agent-user-data');
    const profile = resolveManagedBrowserProfile({
      userDataDir,
      profileMode: 'persistent',
      workspaceScope: 'code-agent',
      sessionId: 'browser_session_test',
    });

    expect(profile).toMatchObject({
      sessionId: 'browser_session_test',
      profileId: 'managed-browser-profile',
      profileMode: 'persistent',
      workspaceScope: 'code-agent',
      artifactDir: 'screenshots',
      temporary: false,
      isolatedRootDir: null,
    });
    expect(profile.profileDir).toBe(path.join(userDataDir, 'managed-browser-profile'));
    expect(shouldCleanupManagedBrowserProfile(profile)).toBe(false);
  });

  it('resolves isolated sessions into a temporary profile and exposes only safe state identifiers', () => {
    const userDataDir = path.join('/tmp', 'code-agent-user-data');
    const tempProfileDir = path.join('/tmp', 'code-agent-managed-browser-', 'isolated-browser-session-test-abc123');
    const profile = resolveManagedBrowserProfile({
      userDataDir,
      profileMode: 'isolated',
      workspaceScope: '/Users/alice/private/project',
      sessionId: 'browser session test',
      tmpDir: '/tmp',
      makeTempDir: () => tempProfileDir,
    });

    expect(profile.profileMode).toBe('isolated');
    expect(profile.profileId).toBe('isolated-browser-session-test');
    expect(profile.profileDir).toBe(tempProfileDir);
    expect(profile.temporary).toBe(true);
    expect(profile.isolatedRootDir).toBe(path.join('/tmp', 'code-agent-managed-browser-'));
    expect(profile.artifactDir).toBe('screenshots');
    expect(profile.workspaceScope).not.toContain('/');
    expect(profile.artifactDir).not.toContain('/');
    expect(shouldCleanupManagedBrowserProfile(profile)).toBe(true);
  });

  it('only allows cleanup for isolated profiles under the managed temporary root', () => {
    const persistent = resolveManagedBrowserProfile({
      userDataDir: path.join('/tmp', 'code-agent-user-data'),
      profileMode: 'persistent',
      workspaceScope: 'code-agent',
      sessionId: 'browser_session_test',
    });

    expect(shouldCleanupManagedBrowserProfile(persistent)).toBe(false);
    expect(shouldCleanupManagedBrowserProfile({
      ...persistent,
      profileMode: 'isolated',
      temporary: true,
      isolatedRootDir: path.join('/tmp', 'code-agent-managed-browser-'),
    })).toBe(false);
  });

  it('lists orphan managed-browser-profile-surface-* dirs without deleting (list-only policy)', () => {
    expect(ORPHAN_MANAGED_BROWSER_SURFACE_PROFILE_POLICY.action).toBe('list-only');
    expect(ORPHAN_MANAGED_BROWSER_SURFACE_PROFILE_POLICY.matchPrefix)
      .toBe('managed-browser-profile-surface-');
    const userDataDir = path.join('/tmp', 'code-agent-user-data-orphans');
    const listed = listOrphanManagedBrowserSurfaceProfileDirs(userDataDir, {
      existsSync: () => true,
      readdirSync: () => [
        'managed-browser-profile',
        'managed-browser-profile-surface-abc123',
        'managed-browser-profile-surface-def456',
        'other-dir',
        'managed-browser-profile-agent-x',
      ],
    });
    expect(listed).toEqual([
      path.join(userDataDir, 'managed-browser-profile-surface-abc123'),
      path.join(userDataDir, 'managed-browser-profile-surface-def456'),
    ]);
    // Shared personal dir and non-surface suffixes are not orphans under this policy.
    expect(listed.some((entry) => entry.endsWith('managed-browser-profile'))).toBe(false);
    expect(listed.some((entry) => entry.includes('agent-x'))).toBe(false);
  });

  it('creates managed browser leases with clamped TTL and expiry checks', () => {
    const lease = createManagedBrowserLease({
      owner: 'browser action',
      ttlMs: 1,
      nowMs: 1000,
      leaseId: 'lease-test',
    });

    expect(lease).toMatchObject({
      leaseId: 'lease-test',
      owner: 'browser-action',
      acquiredAtMs: 1000,
      lastHeartbeatAtMs: 1000,
      expiresAtMs: 6000,
      ttlMs: 5000,
      status: 'active',
    });
    expect(isManagedBrowserLeaseExpired(lease, 5999)).toBe(false);
    expect(isManagedBrowserLeaseExpired(lease, 6000)).toBe(true);
  });

  it('resolves proxy config from request/env while rejecting credentialed proxy URLs', () => {
    expect(resolveManagedBrowserProxyConfig({ env: {} })).toEqual({
      mode: 'direct',
      server: null,
      bypass: [],
      regionHint: null,
      source: 'default',
    });
    expect(resolveManagedBrowserProxyConfig({
      input: {
        server: '127.0.0.1:7890',
        bypass: 'localhost;127.0.0.1',
        regionHint: 'us-west',
      },
      env: {},
    })).toEqual({
      mode: 'http',
      server: 'http://127.0.0.1:7890',
      bypass: ['localhost', '127.0.0.1'],
      regionHint: 'us-west',
      source: 'request',
    });
    expect(() => resolveManagedBrowserProxyConfig({
      input: { server: 'http://user:pass@proxy.local:8080' },
      env: {},
    })).toThrow('proxy credentials');
  });
});
