// ============================================================================
// CUA helper 的渠道身份（生产 / dev）
// ============================================================================
// macOS TCC 按 bundle id 记账，系统设置按 bundle 只渲染一行。生产包与 dev 包各带
// 一份重签拷贝时，若共用同一个 bundle id：用户授权其中一份后启动另一份仍会重弹，
// 且设置页里两者同名同图标同一行、无法分别辨认或关闭（2026-07-31 实测）。
//
// 生产 bundle id 永远不变——改了会让所有存量用户的授权失效。
// shell 侧同源实现在 scripts/lib/cua-channel.sh，两边必须一起改。
// ============================================================================

type CuaHelperChannel = 'production' | 'dev';

const CUA_HELPER_IDENTITY: Record<CuaHelperChannel, { bundleId: string; appName: string }> = {
  production: { bundleId: 'com.agentneo.computeruse', appName: 'Agent Neo Computer Use' },
  dev: { bundleId: 'com.agentneo.computeruse.dev', appName: 'Agent Neo Computer Use Dev' },
};

/**
 * 打包产物里可能出现的 helper .app 目录名（生产在前）。
 *
 * 运行时不能用 NEO_CHANNEL 判渠道：Tauri 由 launchd 拉起，env 是空的。改用
 * 「按名字逐个探」——生产包 Resources 里只有生产那份、dev 包里只有 dev 那份，
 * 各自命中自己的；只有开发树的 staging 目录可能两份并存，此时取生产那份。
 */
export const CUA_HELPER_APP_NAMES: readonly string[] = [
  CUA_HELPER_IDENTITY.production.appName,
  CUA_HELPER_IDENTITY.dev.appName,
].map((name) => `${name}.app`);

/**
 * 当前渠道的 helper 身份，源头与 scripts/lib/cua-channel.sh 完全一致（NEO_CHANNEL，
 * 缺省=生产）。给构建期 / 验收期用——这两个场景跑在真实 shell 里，读得到 NEO_CHANNEL。
 *
 * 未知取值直接抛错，不回退到生产：验收断言拿错期望值等于把门拆了。
 */
export function cuaHelperIdentity(env: NodeJS.ProcessEnv = process.env): {
  bundleId: string;
  appName: string;
} {
  const raw = env.NEO_CHANNEL?.trim().toLowerCase();
  if (!raw || raw === 'production') return CUA_HELPER_IDENTITY.production;
  if (raw === 'dev') return CUA_HELPER_IDENTITY.dev;
  throw new Error(`Unknown NEO_CHANNEL=${env.NEO_CHANNEL} (expected "production" or "dev")`);
}
