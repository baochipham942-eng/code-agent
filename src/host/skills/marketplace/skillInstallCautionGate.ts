import { createHash } from 'crypto';
import { createLogger } from '../../services/infra/logger';
import type {
  SkillCautionConfirmationRequired,
  SkillInstallCautionHit,
} from '../../../shared/contract/skillInstallCaution';
import type { SkillInstallSourceTrust } from './skillInstallContentGuard';

const logger = createLogger('SkillInstallCautionGate');

export class SkillCautionConfirmationRequiredError extends Error {
  readonly result: SkillCautionConfirmationRequired;

  constructor(result: SkillCautionConfirmationRequired) {
    super(result.code);
    this.name = 'SkillCautionConfirmationRequiredError';
    this.result = result;
  }
}

function cautionConfirmationToken(args: {
  pluginSpec: string;
  sourceTrust: string;
  contentHash: string;
  cautionHits: readonly SkillInstallCautionHit[];
}): string {
  const lines = args.cautionHits
    .map((hit) => `${hit.file}|${hit.ruleId}|${hit.snippet}`)
    .sort();
  const payload = `${args.pluginSpec}\n${args.sourceTrust}\n${args.contentHash}\n${lines.join('\n')}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Confirmation hard-gate switch for unsigned sources, default OFF (same
 * convention as CODEX_SANDBOX_ENABLED / CODE_AGENT_PERMISSION_LLM_CLASSIFIER:
 * ship dark, flip on when the surface exists). The renderer confirmation modal
 * (part B) is not merged yet, so no caller can obtain or echo a
 * confirmationToken: with the gate enforced, any skill whose content trips a
 * caution rule (`rm -rf ./dist`, `curl localhost`, prose `shutdown`, ...) from
 * GitHub marketplace or a local zip fails with "install failed" and no retry
 * path. Default-off keeps those installs working on the official-registry
 * policy (proceed + distinguishable warn + cautionHits in the result). Part B
 * flips this default to enforced.
 */
function isSkillCautionConfirmationGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_SKILL_CAUTION_CONFIRMATION_ENABLED === '1';
}

/**
 * Empty hits and builtin skip the gate. official-registry proceeds with a warn
 * and no audit. Unsigned archive and local marketplace throw until the caller
 * repeats the install with the token from the latest scan — but only while the
 * confirmation gate is enabled; with it off (see above) they take the
 * official-registry policy. `force` is not an input: overwrite never satisfies
 * this gate.
 */
export async function applySkillCautionGate(args: {
  pluginSpec: string;
  sourceTrust: SkillInstallSourceTrust;
  contentHash: string;
  cautionHits: SkillInstallCautionHit[];
  confirmationToken?: string;
}): Promise<SkillInstallCautionHit[]> {
  const { cautionHits } = args;
  if (cautionHits.length === 0 || args.sourceTrust === 'builtin') return cautionHits;

  if (args.sourceTrust === 'official-registry') {
    logger.warn('Official registry skill install proceeding with caution findings', {
      pluginSpec: args.pluginSpec,
      ruleIds: cautionHits.map((hit) => hit.ruleId),
    });
    return cautionHits;
  }

  if (!isSkillCautionConfirmationGateEnabled()) {
    logger.warn('Skill install proceeding with caution findings before the confirmation gate is enabled', {
      pluginSpec: args.pluginSpec,
      sourceTrust: args.sourceTrust,
      ruleIds: cautionHits.map((hit) => hit.ruleId),
    });
    return cautionHits;
  }

  const expected = cautionConfirmationToken({
    pluginSpec: args.pluginSpec,
    sourceTrust: args.sourceTrust,
    contentHash: args.contentHash,
    cautionHits,
  });
  if (args.confirmationToken !== expected) {
    throw new SkillCautionConfirmationRequiredError({
      success: false,
      code: 'SKILL_CAUTION_CONFIRMATION_REQUIRED',
      pluginSpec: args.pluginSpec,
      sourceTrust: args.sourceTrust,
      cautionHits,
      confirmationToken: expected,
    });
  }

  // Loaded only on a confirmed install. A static import pulls auth and the audit
  // logger into every IPC module that references this gate, and those modules
  // are loaded by tests whose platform mock does not export `app`.
  const { getAuthService } = await import('../../services/auth/authService');
  const { getAuditLogger } = await import('../../security/auditLogger');
  const userId = getAuthService().getCurrentUser()?.id ?? null;
  getAuditLogger().logSecurityIncident({
    sessionId: 'skill-install',
    toolName: 'skill_install_caution_confirmed',
    incident: `Skill install caution confirmed for ${args.pluginSpec}`,
    details: {
      pluginSpec: args.pluginSpec,
      sourceTrust: args.sourceTrust,
      userId,
      confirmedAt: new Date().toISOString(),
      rules: cautionHits.map((hit) => ({
        file: hit.file,
        ruleId: hit.ruleId,
        snippet: hit.snippet,
      })),
    },
    riskLevel: 'medium',
  });
  return cautionHits;
}
