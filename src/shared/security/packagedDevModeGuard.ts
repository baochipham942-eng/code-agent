/**
 * Tauri 打包壳通过 boot token 标识自身。任何能旁路真实鉴权或改写生产上游的
 * dev 模式都必须在壳内拒绝；compile warmup 只豁免它自身强制开启的 E2E 模式。
 */
export function shouldRefusePackagedDevMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!env.CODE_AGENT_TAURI_BOOT_TOKEN) return false;
  if (env.CODE_AGENT_ENABLE_DEV_API === 'true') return true;
  return env.CODE_AGENT_E2E === '1' && env.CODE_AGENT_COMPILE_WARMUP !== '1';
}
