const CUA_STATE_V2_ENV = 'CODE_AGENT_CUA_STATE_V2';

/**
 * Stateful computer-use is deliberately a second gate on top of CUA itself.
 * This keeps the legacy CUA surface available as a rollback while the strict
 * observe/act contract is canaried.
 */
export function isCuaStateV2Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.CODE_AGENT_ENABLE_CUA === '1' && env[CUA_STATE_V2_ENV] === '1';
}
