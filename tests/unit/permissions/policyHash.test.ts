import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getPermissionModeManager,
  resetPermissionModeManager,
} from '../../../src/host/permissions/modes';
import {
  getPolicyEngine,
  resetPolicyEngine,
  type PolicyRule,
} from '../../../src/host/permissions/policyEngine';
import { computePolicyHash } from '../../../src/host/permissions/policyHash';
import { computeActionFingerprint, getDenialRegistry } from '../../../src/host/security/denialRegistry';
import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

function userRule(
  id: string,
  action: PolicyRule['action'],
  matcher: PolicyRule['matcher'],
): PolicyRule {
  return {
    id,
    name: id,
    priority: 100,
    matcher,
    action,
    overridable: true,
    audit: false,
  };
}

describe('computePolicyHash', () => {
  beforeEach(() => {
    resetPolicyEngine();
    resetPermissionModeManager();
    resetDecisionHistory();
    getDenialRegistry().clearAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPolicyEngine();
    resetPermissionModeManager();
    resetDecisionHistory();
    getDenialRegistry().clearAll();
  });

  it('same policy yields the same hash and rule order does not matter', () => {
    const engine = getPolicyEngine();
    const idsBefore = engine.getRules().map((rule) => rule.id);
    const modeBefore = getPermissionModeManager().getMode();
    engine.addRule(userRule('zzz', 'deny', { tool: 'Z' }));
    engine.addRule(userRule('aaa', 'allow', { tool: 'A' }));
    const first = computePolicyHash('session-a');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(computePolicyHash('session-a')).toBe(first);
    expect(engine.getRules().map((rule) => rule.id)).toEqual([...idsBefore, 'zzz', 'aaa']);
    expect(getPermissionModeManager().getMode()).toBe(modeBefore);

    resetPolicyEngine();
    const flipped = getPolicyEngine();
    flipped.addRule(userRule('aaa', 'allow', { tool: 'A' }));
    flipped.addRule(userRule('zzz', 'deny', { tool: 'Z' }));
    expect(computePolicyHash('session-a')).toBe(first);
  });

  it('changing a rule or the mode changes the hash', () => {
    const engine = getPolicyEngine();
    engine.addRule(userRule('custom', 'allow', { tool: 'Custom' }));
    const baseline = computePolicyHash();
    engine.removeRule('custom');
    engine.addRule(userRule('custom', 'deny', { tool: 'Custom' }));
    const changedRule = computePolicyHash();
    expect(changedRule).not.toBe(baseline);
    getPermissionModeManager().setMode('plan');
    expect(computePolicyHash()).not.toBe(changedRule);
  });

  it('a session mode changes only that session hash', () => {
    getPermissionModeManager().setRolePresetSession('session-a', 'plan');
    const hashed = computePolicyHash('session-a');
    expect(hashed).not.toBe(computePolicyHash('session-b'));
  });

  it('drops matcher functions and keeps regex source and flags distinct', () => {
    const engine = getPolicyEngine();
    engine.addRule(userRule('fn', 'deny', { tool: 'T', custom: () => true }));
    const withFunction = computePolicyHash();
    engine.removeRule('fn');
    engine.addRule(userRule('fn', 'deny', { tool: 'T', custom: () => false }));
    expect(computePolicyHash()).toBe(withFunction);
    engine.removeRule('fn');
    engine.addRule(userRule('fn', 'deny', { tool: 'T' }));
    expect(computePolicyHash()).toBe(withFunction);

    engine.removeRule('fn');
    engine.addRule(userRule('re', 'deny', { commandPattern: /echo/i }));
    const flagged = computePolicyHash();
    engine.removeRule('re');
    engine.addRule(userRule('re', 'deny', { commandPattern: /echo/ }));
    expect(computePolicyHash()).not.toBe(flagged);
  });

  it('returns undefined instead of throwing when policy state cannot be read', () => {
    vi.spyOn(getPolicyEngine(), 'getRules').mockImplementation(() => {
      throw new Error('rules unavailable');
    });
    expect(computePolicyHash('session-a')).toBeUndefined();
  });

  it('a denial-registry record carries the policy hash', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-hash-deny-'));
    const previousSafety = process.env.CODE_AGENT_SHELL_SAFETY_MODE;
    process.env.CODE_AGENT_SHELL_SAFETY_MODE = 'strict';
    try {
      await fs.writeFile(path.join(workspace, 'dummy.tmp'), 'x', 'utf8');
      getProtocolRegistry();
      getPermissionModeManager().setMode('readOnly');
      const sessionId = 'policy-hash-deny';
      const executor = new ToolExecutor({
        workingDirectory: workspace,
        requestPermission: async () => false,
      });
      executor.setAuditEnabled(false);
      const command = 'find . -name dummy.tmp -delete';
      const result = await executor.execute('Bash', { command }, { sessionId });
      expect(result.success).toBe(false);
      const fingerprint = computeActionFingerprint('Bash', { command }, workspace);
      expect(fingerprint).toBeTruthy();
      const recorded = fingerprint ? getDenialRegistry().find(sessionId, fingerprint) : undefined;
      expect(recorded?.policyHash).toBe(computePolicyHash(sessionId));
      expect(recorded?.policyHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (previousSafety === undefined) delete process.env.CODE_AGENT_SHELL_SAFETY_MODE;
      else process.env.CODE_AGENT_SHELL_SAFETY_MODE = previousSafety;
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
