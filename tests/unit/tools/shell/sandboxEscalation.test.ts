// N-SANDBOX-DENY-ESCALATE · ai-review Important (PR #2191 round 4):
// the escalation policy check runs after the first command run was denied, so the
// getPolicyEnforcer() singleton may have been rebound by a concurrent session in
// another workspace. The check must use the instance ToolExecutor bound for this call.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCanonicalRunPath } from '../../../../src/host/runtime/runContext';
import { getPolicyEnforcer, resetPolicyEnforcer } from '../../../../src/host/security/policyEnforcer';
import { shouldOfferEscalation } from '../../../../src/host/tools/shell/sandboxEscalation';

describe('shouldOfferEscalation uses the enforcer bound for this call', () => {
  const dirs: string[] = [];
  const tmp = (prefix: string): string => {
    const dir = resolveCanonicalRunPath(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    resetPolicyEnforcer();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('still hard-denies denied_paths after another workspace rebinds the singleton to null', () => {
    const projectA = tmp('escalate-race-a-');
    const parent = tmp('escalate-race-target-');
    const denied = join(parent, 'denied.txt');
    writeFileSync(denied, 'x');
    writeFileSync(join(projectA, 'code-agent-policy.toml'), [
      '[filesystem]',
      `writable_paths = ["./**", "${parent}/**"]`,
      `denied_paths = ["${denied}"]`,
      '',
    ].join('\n'));

    resetPolicyEnforcer();
    const boundForA = getPolicyEnforcer(projectA);
    expect(boundForA?.isActive).toBe(true);

    // Session B, no policy file, runs Bash while A's command is still executing.
    expect(getPolicyEnforcer(tmp('escalate-race-b-'))).toBeNull();
    expect(getPolicyEnforcer()).toBeNull();

    const input = {
      sandboxDecision: { sandboxed: true },
      foreground: true,
      pty: false,
      background: false,
      unattended: false,
      writeFence: false,
      evalRealRoot: false,
      permissionMode: 'default' as const,
      abortSignal: new AbortController().signal,
      deniedPath: denied,
      newFileGrantSupported: true,
      workingDirectory: projectA,
    };
    expect(shouldOfferEscalation({ ...input, policyEnforcer: boundForA })).toBeUndefined();
    // The singleton (what the old code read) would have offered the card.
    expect(shouldOfferEscalation({ ...input, policyEnforcer: getPolicyEnforcer() })).toBe(denied);
    // Nobody bound an enforcer: unverified, no card.
    expect(shouldOfferEscalation({ ...input, policyEnforcer: undefined })).toBeUndefined();
  });
});
