import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(
  process.cwd(),
  'scripts/acceptance/surface-execution-computer-smoke.ts',
), 'utf8');

describe('Surface Execution Computer acceptance', () => {
  it('keeps the external permission block fail-closed before any real app mutation', () => {
    const permissionBlock = source.slice(
      source.indexOf('if (!permissionResult.success || !permissions.ready)'),
      source.indexOf("proof.stage = 'fixture'"),
    );

    expect(permissionBlock).toContain('computerMutationAttempted === 0');
    expect(permissionBlock).toContain('computerMutationForwarded === 0');
    expect(permissionBlock).toContain("status = 'blocked'");
    expect(permissionBlock).toContain("code: 'COMPUTER_PERMISSION_REQUIRED'");
    expect(permissionBlock).toContain('throw new AcceptanceBlockedError(failure)');
    expect(permissionBlock).not.toMatch(/realAppObserved\s*=/);
    expect(permissionBlock).not.toMatch(/realAppMutationDelivered\s*=/);
    expect(permissionBlock).not.toMatch(/realAppBusinessVerified\s*=/);
    expect(permissionBlock).not.toMatch(/cleanupReleasedComputerLock\s*=/);
  });

  it('derives real-app assertions from helper observations, provider delivery, and business readback', () => {
    const observedAt = source.indexOf('assertions.realAppObserved = initialScreenshot.bytes > 0');
    const observation = source.slice(source.indexOf("const initialObservation = await observe('initial-observe')"), observedAt);
    const deliveredAt = source.indexOf('assertions.realAppMutationDelivered =');
    const delivered = source.slice(source.indexOf('const businessActPromise = execute'), deliveredAt);
    const verifiedAt = source.indexOf('assertions.realAppBusinessVerified =');
    const verified = source.slice(
      source.indexOf('const businessReadback = await waitFor'),
      source.indexOf('evidence.businessVerification ='),
    );

    expect(source).toContain('const directPort = new CuaMcpDriverPort()');
    expect(observation).toContain('stateFromObserve(initialObservation');
    expect(observation).toContain('dataUrlFromResult(initialObservation)');
    expect(observation).toContain("saveDataUrl(initialImage, join(outputDir, 'before.png'))");
    expect(observation).toContain('initialState.root.pid === root.pid');
    expect(source.slice(observedAt, source.indexOf('assertions.foregroundObservationVerified =')))
      .toContain('initialState.root.pid === fixture.process.pid');
    expect(delivered).toContain("deliveryMode: 'foreground'");
    expect(delivered).toContain('foregroundProviderCall?.forwarded && foregroundProviderCall.providerSucceeded');
    expect(delivered).toContain('readFixtureState(fixture?.statePath');
    expect(verified).toContain("businessResponse.result.verification === 'satisfied'");
    expect(verified).toContain('businessSuccessorValue === BUSINESS_VALUE');
    expect(verified).toContain('afterScreenshot.bytes > 0');
    expect(source).toContain('evidence.businessVerification = {');
    expect(verifiedAt).toBeGreaterThan(source.indexOf('const businessReadback = await waitFor'));
    expect(source).not.toContain('assertions.realAppObserved = true');
    expect(source).not.toContain('assertions.realAppMutationDelivered = true');
    expect(source).not.toContain('assertions.realAppBusinessVerified = true');
  });

  it('proves foreground/background delivery and input-lock cleanup through runtime evidence', () => {
    const cleanup = source.slice(
      source.indexOf("proof.stage = 'cleanup'"),
      source.indexOf("proof.stage = 'redaction'"),
    );

    const contentionAt = source.indexOf("toolCallId: 'computer-input-lock-contention'");
    const businessReleasedAt = source.indexOf('businessLockGate.release()');

    expect(source).toContain('const foregroundActivation = await bringToFront({');
    expect(source).toContain('const foregroundFrontmost = await waitForSystemFrontmost({');
    expect(source).toContain('foregroundFrontmost.expectedActive');
    expect(source).toContain("runEvidence('/usr/bin/lsappinfo', ['front'])");
    expect(source).toContain('backgroundFrontmostBefore.expectedActive');
    expect(source).toContain('backgroundFrontmostAfter.expectedActive');
    expect(source).toContain('zOrderDiagnostic: foregroundOrder');
    expect(source).toContain("deliveryMode: 'background'");
    expect(source).toContain('backgroundProviderCall.providerSucceeded');
    expect(source).toContain('assertions.foregroundObservationVerified =');
    expect(source).toContain('assertions.backgroundFallbackVerified =');
    expect(source).toContain('evidence.foregroundBackground = {');
    expect(source).toContain('subscribeCuaInputLockLifecycle((event) =>');
    expect(source).toContain("armAfterForwardMutationGate('business-input-lock')");
    expect(source).toContain('await withTimeout(businessLockGate.entered');
    expect(source).toContain("toolCallId: 'computer-input-lock-contention'");
    expect(source).toContain('event.outcome === \'blocked\'');
    expect(contentionAt).toBeGreaterThan(source.indexOf('businessLockGate.entered'));
    expect(businessReleasedAt).toBeGreaterThan(contentionAt);
    expect(cleanup).toContain('const releasedInputLock = inputLockLifecycle.some');
    expect(cleanup).toContain("event.phase === 'release'");
    expect(cleanup).toContain('assertions.cleanupReleasedComputerLock = acquiredInputLock');
    expect(cleanup).toContain('assertions.inputLockRecovered = acquiredInputLock');
    expect(cleanup).toContain('endSessionCalls.length === 1');
    expect(cleanup).toContain('!existsSync(lockPath)');
    expect(source).not.toContain('assertions.cleanupReleasedComputerLock = true');
    expect(source).not.toContain('assertions.inputLockRecovered = true');
  });
});
