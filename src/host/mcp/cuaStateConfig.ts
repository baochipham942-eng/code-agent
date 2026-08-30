import { isComputerUseCapabilityInstalledSync } from '../plugins/builtin/computerUse/installState';

const CUA_STATE_V2_ENV = 'CODE_AGENT_CUA_STATE_V2';

/**
 * Stateful computer-use is deliberately a second gate on top of CUA itself.
 * This keeps the legacy CUA surface available as a rollback while the strict
 * observe/act contract is canaried.
 */
export function isCuaStateV2Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isComputerUseCapabilityInstalledSync(env) && env[CUA_STATE_V2_ENV] === '1';
}
