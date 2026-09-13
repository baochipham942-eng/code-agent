import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error —— 纯 JS 释放门脚本，无类型声明
import { verifyPackagedCompanionEvidence, sanitizeCompanionInvitation, COMPANION_BUNDLE_MARKERS } from '../../scripts/lib/desktop-shell-packaged-companion.mjs';
// @ts-expect-error —— 纯 JS 释放门脚本，无类型声明
import { verifyPackagedDesktopShellEvidence } from '../../scripts/desktop-shell-packaged-smoke.mjs';

const NOW = 1_800_000_000_000;

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    endpoint: 'http://192.168.1.20:8182',
    altEndpoint: 'http://host.local:8182',
    inviteId: '11111111-1111-4111-8111-111111111111',
    expiresAt: NOW + 60_000,
    hasPsk: true,
    hasHostKey: true,
    pskBytes: 32,
    hostKeyBytes: 32,
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    markers: {
      bundlePath: '/app/dist/web/webServer.bundle.cjs',
      readable: true,
      found: [...COMPANION_BUNDLE_MARKERS],
      missing: [],
    },
    session: { ok: true, status: 200, sessionId: 'sess_packaged' },
    invite: { ok: true, status: 200, kind: 'invitation' },
    invitation: invitation(),
    listen: {
      endpoint: 'http://192.168.1.20:8182',
      host: '192.168.1.20',
      port: 8182,
      listening: true,
    },
    roundtrip: null,
    ...overrides,
  };
}

describe('packaged companion diagnostics', () => {
  it('accepts a sanitized invitation when the LAN port is listening and the bundle still has companion assembly', () => {
    const result = verifyPackagedCompanionEvidence(evidence(), NOW);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.summary).toMatchObject({
      inviteKind: 'invitation',
      lanListening: true,
      lanPort: 8182,
    });
    expect(JSON.stringify(result)).not.toMatch(/"psk":/);
    expect(JSON.stringify(result)).not.toMatch(/"hostKey":/);
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{64}/i);
  });

  it('rejects a manage payload that is not an invitation', () => {
    const result = verifyPackagedCompanionEvidence(evidence({
      invite: { ok: true, status: 200, kind: 'status' },
    }), NOW);
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({
      code: 'companion_invite_not_invitation',
    }));
  });

  it('rejects a missing LAN listener after invite', () => {
    const result = verifyPackagedCompanionEvidence(evidence({
      listen: {
        endpoint: 'http://192.168.1.20:8182',
        host: '192.168.1.20',
        port: 8182,
        listening: false,
        error: 'ECONNREFUSED',
      },
    }), NOW);
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({
      code: 'companion_lan_not_listening',
    }));
  });

  it('rejects a packaged bundle that dropped companion assembly markers', () => {
    const result = verifyPackagedCompanionEvidence(evidence({
      markers: {
        bundlePath: '/app/dist/web/webServer.bundle.cjs',
        readable: true,
        found: [],
        missing: ['/api/companion/manage', 'COMPANION_LAN_UNAVAILABLE'],
      },
    }), NOW);
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({
      code: 'companion_bundle_markers_missing',
    }));
  });

  it('redacts psk and hostKey from the invitation payload', () => {
    const sanitized = sanitizeCompanionInvitation({
      version: 1,
      endpoint: 'http://192.168.1.20:8182',
      inviteId: '11111111-1111-4111-8111-111111111111',
      expiresAt: NOW + 60_000,
      psk: 'ab'.repeat(32),
      hostKey: 'cd'.repeat(32),
    });
    expect(sanitized).toMatchObject({
      hasPsk: true,
      hasHostKey: true,
      pskBytes: 32,
      hostKeyBytes: 32,
    });
    expect(sanitized).not.toHaveProperty('psk');
    expect(sanitized).not.toHaveProperty('hostKey');
    expect(JSON.stringify(sanitized)).not.toContain('ab'.repeat(32));
    expect(JSON.stringify(sanitized)).not.toContain('cd'.repeat(32));
  });

  it('fails closed when a 32-byte hex secret is left on the invitation object', () => {
    expect(() => verifyPackagedCompanionEvidence(evidence({
      invitation: invitation({ psk: 'ab'.repeat(32) }),
    }), NOW)).toThrow(/leaked a 32-byte hex secret/);
  });

  it('records pairing success with approval NOT_RUN as a warning, not a failure', () => {
    const result = verifyPackagedCompanionEvidence(evidence({
      roundtrip: {
        attempted: true,
        paired: true,
        deviceId: 'dev_1',
        approval: {
          status: 'NOT_RUN',
          reason: 'isolated packaged profile has no pending permission island',
        },
      },
    }), NOW);
    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'companion_approval_not_run',
    }));
  });

  it('fails when the simulated LAN client was asked to pair and did not', () => {
    const result = verifyPackagedCompanionEvidence(evidence({
      roundtrip: {
        attempted: true,
        paired: false,
        error: 'HTTP_403',
        approval: { status: 'NOT_RUN', reason: 'pairing did not complete' },
      },
    }), NOW);
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({
      code: 'companion_roundtrip_pair_failed',
    }));
  });

  it('keeps packaged-smoke CLI flags for companion diagnostics in the family script', () => {
    const smoke = fs.readFileSync(path.resolve('scripts/desktop-shell-packaged-smoke.mjs'), 'utf8');
    expect(smoke).toContain('--companion');
    expect(smoke).toContain('--companion-roundtrip');
    expect(smoke).toContain('verifyPackagedCompanionEvidence');
    expect(typeof verifyPackagedDesktopShellEvidence).toBe('function');
  });

  it('pins inner-executable launch to Contents/Resources so the packaged webServer can boot', () => {
    const src = fs.readFileSync(path.resolve('src-tauri/src/main.rs'), 'utf8');
    expect(src).toContain('fn packaged_exe_roots');
    expect(src).toContain('contents.join("Resources")');
  });
});
