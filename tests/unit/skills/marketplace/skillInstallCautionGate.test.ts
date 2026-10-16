// ============================================================================
// skillInstallCautionGate 默认值回归：确认门默认 ON（N-SKILL-CAUTION-GATE-ON）。
// part B（PR #2361）合入后所有 GUI 安装入口都能弹确认面并携 token 重发，
// 默认从 ship-dark 翻成 enforced——只有显式 '0' 退回 proceed-with-warn。
// 这里直接钉 applySkillCautionGate 的默认值：无 env → 未签名来源必抛
// confirmation-required；'0' → 放行 + 可区分 warn。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  logSecurityIncident: vi.fn(),
  currentUser: { id: 'user-gate-1' } as { id: string } | null,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({
    getCurrentUser: () => mocks.currentUser,
  }),
}));

vi.mock('../../../../src/host/security/auditLogger', () => ({
  getAuditLogger: () => ({
    logSecurityIncident: (...args: unknown[]) => mocks.logSecurityIncident(...args),
  }),
}));

import {
  applySkillCautionGate,
  SkillCautionConfirmationRequiredError,
} from '../../../../src/host/skills/marketplace/skillInstallCautionGate';

const CAUTION_HITS = [
  { file: 'demo/SKILL.md', ruleId: 'git_clean', snippet: 'git clean -fd' },
];

async function gateCall(confirmationToken?: string) {
  return applySkillCautionGate({
    pluginSpec: 'demo@local-marketplace',
    sourceTrust: 'local-marketplace',
    contentHash: 'a'.repeat(64),
    cautionHits: CAUTION_HITS,
    ...(confirmationToken ? { confirmationToken } : {}),
  });
}

/** 无 token 调用 → 捕获 confirmation-required（拿 host 下发的 token 备重发） */
async function requireConfirmation(): Promise<string> {
  try {
    await gateCall();
  } catch (error) {
    if (error instanceof SkillCautionConfirmationRequiredError) return error.result.confirmationToken;
  }
  throw new Error('expected SKILL_CAUTION_CONFIRMATION_REQUIRED — gate default is not ON');
}

describe('isSkillCautionConfirmationGateEnabled default (no env → ON)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODE_AGENT_SKILL_CAUTION_CONFIRMATION_ENABLED;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.CODE_AGENT_SKILL_CAUTION_CONFIRMATION_ENABLED;
  });

  it('no env: local-marketplace hits without a token throw confirmation-required (nothing installed)', async () => {
    await expect(gateCall()).rejects.toThrow('SKILL_CAUTION_CONFIRMATION_REQUIRED');
    await expect(gateCall()).rejects.toBeInstanceOf(SkillCautionConfirmationRequiredError);
    expect(mocks.logSecurityIncident).not.toHaveBeenCalled();
  });

  it("no env: echoing the scanned token completes the install and audits it once", async () => {
    const token = await requireConfirmation();
    await expect(gateCall(token)).resolves.toEqual(CAUTION_HITS);
    expect(mocks.logSecurityIncident).toHaveBeenCalledTimes(1);
  });

  it("explicit '1' stays enforced (legacy opt-in is a no-op under the new default)", async () => {
    vi.stubEnv('CODE_AGENT_SKILL_CAUTION_CONFIRMATION_ENABLED', '1');
    await expect(gateCall()).rejects.toBeInstanceOf(SkillCautionConfirmationRequiredError);
  });

  it("explicit '0' opts out: install proceeds with a distinguishable warn, no audit", async () => {
    vi.stubEnv('CODE_AGENT_SKILL_CAUTION_CONFIRMATION_ENABLED', '0');
    await expect(gateCall()).resolves.toEqual(CAUTION_HITS);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Skill install proceeding with caution findings before the confirmation gate is enabled',
      expect.objectContaining({
        pluginSpec: 'demo@local-marketplace',
        sourceTrust: 'local-marketplace',
      }),
    );
    expect(mocks.logSecurityIncident).not.toHaveBeenCalled();
  });

  it('empty hits and builtin skip the gate regardless of the switch', async () => {
    await expect(applySkillCautionGate({
      pluginSpec: 'demo@local-marketplace',
      sourceTrust: 'local-marketplace',
      contentHash: 'a'.repeat(64),
      cautionHits: [],
    })).resolves.toEqual([]);
    await expect(applySkillCautionGate({
      pluginSpec: 'demo@builtin',
      sourceTrust: 'builtin',
      contentHash: 'a'.repeat(64),
      cautionHits: CAUTION_HITS,
    })).resolves.toEqual(CAUTION_HITS);
  });
});
