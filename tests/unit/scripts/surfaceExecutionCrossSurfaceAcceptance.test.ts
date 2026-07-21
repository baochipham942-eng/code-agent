import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertCrossSurfaceAcceptanceInvariants,
  crossSurfaceExternalPermissionBlock,
  evaluateCrossSurfaceComputerPermissions,
  type CrossSurfaceAcceptanceInvariantInput,
} from '../../../scripts/acceptance/fixtures/surface-execution-cross-surface';

const helperPath = '/opt/Agent Neo Computer Use.app/Contents/MacOS/cua-driver';
const smokeSource = readFileSync(resolve(
  'scripts/acceptance/surface-execution-cross-surface-smoke.ts',
), 'utf8');

function invariantInput(
  overrides: Partial<CrossSurfaceAcceptanceInvariantInput> = {},
): CrossSurfaceAcceptanceInvariantInput {
  return {
    browserSessionId: 'browser-session',
    computerSessionId: 'computer-session',
    computerParentSessionId: 'browser-session',
    computerSwitchFromSessionId: 'browser-session',
    browserSwitchFromSessionId: 'computer-session',
    browserContinuationSessionId: 'browser-session',
    ownerIsolationBlocked: true,
    browserBusinessReadback: true,
    cleanupCompleted: true,
    permission: {
      ready: false,
      accessibility: true,
      screenRecording: true,
      screenRecordingCapturable: false,
      source: 'AgentNeo helper daemon',
      sourceExecutable: helperPath,
      sourceTrusted: true,
      missing: ['screen_recording_capturable'],
    },
    computerMutationAttempted: 0,
    computerMutationForwarded: 0,
    ...overrides,
  };
}

describe('Surface Execution cross-Surface acceptance invariants', () => {
  it('classifies non-capturable Screen Recording as a structured external block', () => {
    const permission = evaluateCrossSurfaceComputerPermissions({
      accessibility: true,
      screen_recording: true,
      screen_recording_capturable: false,
      source: {
        attribution: 'AgentNeo helper daemon',
        executable: helperPath,
      },
    }, helperPath);

    expect(permission).toMatchObject({
      ready: false,
      accessibility: true,
      screenRecording: true,
      screenRecordingCapturable: false,
      sourceTrusted: true,
      missing: ['screen_recording_capturable'],
    });
    expect(crossSurfaceExternalPermissionBlock(permission)).toEqual({
      code: 'COMPUTER_PERMISSION_REQUIRED',
      message: 'Computer permission probe is not ready: screen_recording_capturable',
      missing: ['screen_recording_capturable'],
      userActionRequired: true,
    });
  });

  it('accepts a blocked Computer probe only when mutation stays at zero and Browser resumes', () => {
    expect(() => assertCrossSurfaceAcceptanceInvariants(invariantInput())).not.toThrow();
    expect(() => assertCrossSurfaceAcceptanceInvariants(invariantInput({
      computerMutationAttempted: 1,
    }))).toThrow('Computer mutation was attempted while required permissions were unavailable');
    expect(() => assertCrossSurfaceAcceptanceInvariants(invariantInput({
      computerMutationForwarded: 1,
    }))).toThrow('Computer mutation was attempted while required permissions were unavailable');
  });

  it('requires parent linkage, switch-back reason scope, owner isolation, readback, and cleanup', () => {
    expect(() => assertCrossSurfaceAcceptanceInvariants(invariantInput({
      computerParentSessionId: 'foreign-browser',
    }))).toThrow('Computer Surface was not linked');
    expect(() => assertCrossSurfaceAcceptanceInvariants(invariantInput({
      browserSwitchFromSessionId: 'foreign-computer',
    }))).toThrow('Browser continuation did not switch back');
    expect(() => assertCrossSurfaceAcceptanceInvariants(invariantInput({
      ownerIsolationBlocked: false,
    }))).toThrow('Cross-agent Browser target was not blocked');
    expect(() => assertCrossSurfaceAcceptanceInvariants(invariantInput({
      browserBusinessReadback: false,
    }))).toThrow('Browser continuation business readback failed');
    expect(() => assertCrossSurfaceAcceptanceInvariants(invariantInput({
      cleanupCompleted: false,
    }))).toThrow('Cross-Surface cleanup did not complete');
  });

  it('clears the external block when the signed helper can really capture the screen', () => {
    const permission = evaluateCrossSurfaceComputerPermissions({
      accessibility: true,
      screen_recording: true,
      screen_recording_capturable: true,
      source: {
        attribution: 'AgentNeo helper daemon',
        executable: helperPath,
      },
    }, helperPath);

    expect(permission.ready).toBe(true);
    expect(permission.missing).toEqual([]);
    expect(crossSurfaceExternalPermissionBlock(permission)).toBeNull();
  });

  it('keeps the executable smoke on the production Computer provider and business-verification path', () => {
    expect(smokeSource).toContain('new CuaStatefulComputerUseHandler(');
    expect(smokeSource).toContain('new CuaStateAdapter(recordingPort)');
    expect(smokeSource).toContain("operation: 'observe'");
    expect(smokeSource).toContain("operation: 'act'");
    expect(smokeSource).toContain("kind: 'set_value'");
    expect(smokeSource).toContain("expect: {");
    expect(smokeSource).toContain("verification === 'satisfied'");
    expect(smokeSource).toContain('verifiedComputerInput.value === COMPUTER_BUSINESS_VALUE');
    expect(smokeSource).toContain("event.operation?.action === 'computer_input_lock_acquire'");
    expect(smokeSource).toContain("event.operation?.action === 'computer_input_lock_release'");
    expect(smokeSource).not.toContain("const providerCalls = [{ toolName: 'check_permissions'");
  });

  it('sources completion-gate assertions from runtime contract and legacy message reads', () => {
    const contractAssertion = smokeSource.indexOf(
      'assertions.surfaceContractRoutedBrowserAndComputer = true',
    );
    const routedEvents = smokeSource.indexOf('const routedEvents = owner.events.filter');
    const legacyAssertion = smokeSource.indexOf('assertions.legacyProjectionRemainsReadable = true');
    const legacyRead = smokeSource.indexOf('await projectionService.getSnapshot');

    expect(routedEvents).toBeGreaterThan(-1);
    expect(contractAssertion).toBeGreaterThan(routedEvents);
    expect(legacyRead).toBeGreaterThan(-1);
    expect(legacyAssertion).toBeGreaterThan(legacyRead);
    expect(smokeSource).toContain("proof.blockClassification = 'blocked_external'");
    expect(smokeSource).toContain("proof.status = 'blocked'");
    expect(smokeSource).toContain("code: 'COMPUTER_PERMISSION_REQUIRED'");
  });
});
