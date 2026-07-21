import { resolve } from 'node:path';

export interface CrossSurfaceComputerPermissionDecision {
  ready: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  screenRecordingCapturable: boolean;
  source: string;
  sourceExecutable: string | null;
  sourceTrusted: boolean;
  missing: string[];
}

export interface CrossSurfaceAcceptanceInvariantInput {
  browserSessionId: string;
  computerSessionId: string;
  computerParentSessionId?: string;
  computerSwitchFromSessionId?: string;
  browserSwitchFromSessionId?: string;
  browserContinuationSessionId: string;
  ownerIsolationBlocked: boolean;
  browserBusinessReadback: boolean;
  cleanupCompleted: boolean;
  permission: CrossSurfaceComputerPermissionDecision;
  computerMutationAttempted: number;
  computerMutationForwarded: number;
}

export function evaluateCrossSurfaceComputerPermissions(
  structured: Record<string, unknown>,
  expectedHelperPath: string,
): CrossSurfaceComputerPermissionDecision {
  const accessibility = structured.accessibility === true;
  const screenRecording = structured.screen_recording === true;
  const screenRecordingCapturable = structured.screen_recording_capturable === true;
  const sourceRecord = structured.source && typeof structured.source === 'object'
    && !Array.isArray(structured.source)
    ? structured.source as Record<string, unknown>
    : null;
  const source = typeof structured.source === 'string'
    ? structured.source
    : typeof sourceRecord?.attribution === 'string'
      ? sourceRecord.attribution
      : 'unknown';
  const sourceExecutable = typeof sourceRecord?.executable === 'string'
    ? sourceRecord.executable
    : null;
  const sourceTrusted = (/daemon|agentneo|com\.agentneo/i.test(source)
    && !/terminal|shell/i.test(source))
    || Boolean(sourceExecutable && resolve(sourceExecutable) === resolve(expectedHelperPath));
  const missing = [
    ...(!accessibility ? ['accessibility'] : []),
    ...(!screenRecording ? ['screen_recording'] : []),
    ...(!screenRecordingCapturable ? ['screen_recording_capturable'] : []),
    ...(!sourceTrusted ? ['trusted_helper_tcc_identity'] : []),
  ];
  return {
    ready: missing.length === 0,
    accessibility,
    screenRecording,
    screenRecordingCapturable,
    source,
    sourceExecutable,
    sourceTrusted,
    missing,
  };
}

export function crossSurfaceExternalPermissionBlock(
  permission: CrossSurfaceComputerPermissionDecision,
): {
  code: 'COMPUTER_PERMISSION_REQUIRED';
  message: string;
  missing: string[];
  userActionRequired: true;
} | null {
  if (permission.ready) return null;
  return {
    code: 'COMPUTER_PERMISSION_REQUIRED',
    message: `Computer permission probe is not ready: ${permission.missing.join(', ')}`,
    missing: [...permission.missing],
    userActionRequired: true,
  };
}

export function assertCrossSurfaceAcceptanceInvariants(
  input: CrossSurfaceAcceptanceInvariantInput,
): void {
  if (!input.browserSessionId || !input.computerSessionId) {
    throw new Error('Cross-Surface acceptance requires Browser and Computer session identities');
  }
  if (input.computerParentSessionId !== input.browserSessionId
    || input.computerSwitchFromSessionId !== input.browserSessionId) {
    throw new Error('Computer Surface was not linked to the originating Browser session');
  }
  if (input.browserSwitchFromSessionId !== input.computerSessionId
    || input.browserContinuationSessionId !== input.browserSessionId) {
    throw new Error('Browser continuation did not switch back from the Computer session');
  }
  if (!input.ownerIsolationBlocked) throw new Error('Cross-agent Browser target was not blocked');
  if (!input.browserBusinessReadback) throw new Error('Browser continuation business readback failed');
  if (!input.cleanupCompleted) throw new Error('Cross-Surface cleanup did not complete');
  if (!input.permission.ready
    && (input.computerMutationAttempted !== 0 || input.computerMutationForwarded !== 0)) {
    throw new Error('Computer mutation was attempted while required permissions were unavailable');
  }
}
