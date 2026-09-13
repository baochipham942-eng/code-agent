#!/usr/bin/env node
/**
 * Packaged-desktop companion diagnostics: invitation shape, LAN listen,
 * and webServer.bundle.cjs assembly markers. Pure verification plus
 * filesystem inspect — no process launch. The live collector lives in
 * desktop-shell-packaged-smoke.mjs.
 */

import fs from 'node:fs';

export const COMPANION_BUNDLE_MARKERS = Object.freeze([
  '/api/companion/manage',
  'companion:manage',
  'COMPANION_LAN_UNAVAILABLE',
  'COMPANION_INVALID_SCOPE',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pushFailure(failures, code, message, evidence = {}) {
  failures.push({ code, message, evidence });
}

function pushWarning(warnings, code, message, evidence = {}) {
  warnings.push({ code, message, evidence });
}

export function inspectCompanionBundle(bundlePath) {
  if (typeof bundlePath !== 'string' || bundlePath.length === 0 || !fs.existsSync(bundlePath)) {
    return {
      bundlePath: bundlePath ?? null,
      readable: false,
      found: [],
      missing: [...COMPANION_BUNDLE_MARKERS],
    };
  }
  const source = fs.readFileSync(bundlePath, 'utf8');
  const found = COMPANION_BUNDLE_MARKERS.filter((marker) => source.includes(marker));
  const missing = COMPANION_BUNDLE_MARKERS.filter((marker) => !source.includes(marker));
  return { bundlePath, readable: true, found, missing };
}

export function sanitizeCompanionInvitation(raw) {
  if (!isRecord(raw)) return null;
  const pskHex = typeof raw.psk === 'string' && /^[0-9a-f]+$/i.test(raw.psk) ? raw.psk : '';
  const hostKeyHex = typeof raw.hostKey === 'string' && /^[0-9a-f]+$/i.test(raw.hostKey) ? raw.hostKey : '';
  return {
    version: raw.version,
    endpoint: raw.endpoint,
    altEndpoint: raw.altEndpoint,
    inviteId: raw.inviteId,
    expiresAt: raw.expiresAt,
    hasPsk: pskHex.length === 64,
    hasHostKey: hostKeyHex.length === 64,
    pskBytes: pskHex.length / 2,
    hostKeyBytes: hostKeyHex.length / 2,
  };
}

export function assertNoCompanionSecrets(value) {
  const walk = (node, trail) => {
    if (typeof node === 'string') {
      if (/^[0-9a-f]{64}$/i.test(node) && /(psk|hostKey|invitation)/i.test(trail)) {
        throw new Error(`companion diagnostic leaked a 32-byte hex secret at ${trail}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      walk(child, trail ? `${trail}.${key}` : key);
    }
  };
  walk(value, '');
}

function invitationLooksValid(invitation, nowMs) {
  if (!isRecord(invitation)) return false;
  if (invitation.version !== 1) return false;
  if (typeof invitation.endpoint !== 'string' || !/^http:\/\/.+:\d+$/.test(invitation.endpoint)) return false;
  if (typeof invitation.inviteId !== 'string' || !/^[0-9a-f-]{36}$/i.test(invitation.inviteId)) return false;
  if (!Number.isSafeInteger(invitation.expiresAt)) return false;
  if (invitation.expiresAt <= nowMs) return false;
  if (invitation.hasPsk !== true || invitation.pskBytes !== 32) return false;
  if (invitation.hasHostKey !== true || invitation.hostKeyBytes !== 32) return false;
  if ('psk' in invitation && typeof invitation.psk === 'string') return false;
  if ('hostKey' in invitation && typeof invitation.hostKey === 'string' && /^[0-9a-f]{64}$/i.test(invitation.hostKey)) {
    return false;
  }
  return true;
}

export function verifyPackagedCompanionEvidence(evidence, nowMs = Date.now()) {
  const failures = [];
  const warnings = [];
  const markers = isRecord(evidence?.markers) ? evidence.markers : null;
  const session = isRecord(evidence?.session) ? evidence.session : null;
  const invite = isRecord(evidence?.invite) ? evidence.invite : null;
  const invitation = isRecord(evidence?.invitation) ? evidence.invitation : null;
  const listen = isRecord(evidence?.listen) ? evidence.listen : null;
  const roundtrip = isRecord(evidence?.roundtrip) ? evidence.roundtrip : null;

  if (!markers || markers.readable !== true) {
    pushFailure(failures, 'companion_bundle_unreadable', 'Packaged webServer.bundle.cjs was not readable.', {
      bundlePath: markers?.bundlePath ?? null,
    });
  } else if (Array.isArray(markers.missing) && markers.missing.length > 0) {
    pushFailure(failures, 'companion_bundle_markers_missing', 'Packaged webServer bundle is missing companion assembly markers.', {
      bundlePath: markers.bundlePath,
      missing: markers.missing,
    });
  }

  if (!session || session.ok !== true || typeof session.sessionId !== 'string' || session.sessionId.length === 0) {
    pushFailure(failures, 'companion_session_create_failed', 'Packaged app did not create a session for the companion invite.', {
      status: session?.status ?? null,
      error: session?.error ?? null,
    });
  }

  if (!invite || invite.ok !== true) {
    pushFailure(failures, 'companion_invite_failed', 'manage invite did not return HTTP success.', {
      status: invite?.status ?? null,
      error: invite?.error ?? null,
      kind: invite?.kind ?? null,
    });
  } else if (invite.kind !== 'invitation') {
    pushFailure(failures, 'companion_invite_not_invitation', `manage invite returned kind=${invite.kind ?? 'missing'}, not invitation.`, {
      kind: invite.kind ?? null,
    });
  }

  if (!invitationLooksValid(invitation, nowMs)) {
    pushFailure(failures, 'companion_invitation_invalid', 'manage invite payload is not a valid LAN QR invitation (secrets redacted).', {
      invitation,
    });
  }

  if (!listen || listen.listening !== true) {
    pushFailure(failures, 'companion_lan_not_listening', 'Companion LAN port is not listening after invite.', {
      endpoint: listen?.endpoint ?? invitation?.endpoint ?? null,
      host: listen?.host ?? null,
      port: listen?.port ?? null,
      error: listen?.error ?? null,
    });
  }

  if (roundtrip && roundtrip.attempted === true) {
    if (roundtrip.paired !== true) {
      pushFailure(failures, 'companion_roundtrip_pair_failed', 'Simulated LAN client did not complete pairing against the packaged process.', {
        error: roundtrip.error ?? null,
      });
    } else if (roundtrip.approval?.status === 'NOT_RUN') {
      pushWarning(warnings, 'companion_approval_not_run', roundtrip.approval.reason ?? 'Approval round-trip was not attempted.', {
        paired: true,
      });
    }
  }

  const result = {
    ok: failures.length === 0,
    summary: {
      markersFound: Array.isArray(markers?.found) ? markers.found.length : 0,
      markersMissing: Array.isArray(markers?.missing) ? markers.missing.length : 0,
      sessionIdPresent: typeof session?.sessionId === 'string' && session.sessionId.length > 0,
      inviteKind: invite?.kind ?? null,
      lanListening: listen?.listening === true,
      lanPort: listen?.port ?? null,
      paired: roundtrip?.paired === true,
      approval: roundtrip?.approval?.status ?? 'NOT_RUN',
    },
    failures,
    warnings,
    evidence: {
      markers: markers ? { bundlePath: markers.bundlePath, found: markers.found, missing: markers.missing, readable: markers.readable } : null,
      session: session ? { ok: session.ok, status: session.status, sessionId: session.sessionId } : null,
      invite: invite ? { ok: invite.ok, status: invite.status, kind: invite.kind } : null,
      invitation,
      listen: listen ? {
        endpoint: listen.endpoint,
        host: listen.host,
        port: listen.port,
        listening: listen.listening,
        error: listen.error ?? null,
        lsofSample: Array.isArray(listen.lsofSample) ? listen.lsofSample.slice(0, 4) : undefined,
      } : null,
      roundtrip: roundtrip ?? null,
    },
  };
  assertNoCompanionSecrets(result);
  return result;
}
