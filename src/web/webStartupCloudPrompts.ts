// ============================================================================
// 云端 System Prompt 下发 —— 发行版路径接线（**默认关闭**）
//
// promptService 从云端拉 system prompt、本地缓存、拉不到降级到内置，下发内容经控制面
// 签名校验（verifyControlPlaneEnvelope）后由 setTrustedRemotePromptFragments 注入
// prompt builder。它原本只在 app/initBackgroundServices.ts 启动，那条 Electron main
// 路径不在任何发行版中执行（见 src/host/index.ts 头注释）——即发行版里这条通道从未生效，
// 一直走内置 prompt。
//
// **为什么接了却默认关闭**（2026-07-25 产品判断）：
// 这条通道的价值是「不发版就能热修 prompt」，风险是它绕过全部质量门——prompt 改动没有
// CI、没有 eval、没有棘轮，改错了对全量用户立刻生效，而症状是「agent 变笨了」这种最难
// 归因的形态。当前没有需要热修 prompt 的运营节奏，所以把通道建好待命、默认不通电：
// 真要用时打开开关即可，而不是现在就把一条无人看管的旁路接到所有用户身上。
//
// 开启方式：环境变量 CODE_AGENT_CLOUD_PROMPTS=1（与 CODEX_SANDBOX_ENABLED /
// CROSS_VERIFY_ENABLED 同一惯例：能力默认关，显式开启）。开启后每次拉取结果都会
// 打一条 info 日志（来源 + 版本），保证下发有痕可查。
// ============================================================================

import { createLogger } from '../host/services/infra/logger';

const logger = createLogger('WebStartupCloudPrompts');

/** 开关读取独立成函数，便于单测覆盖「默认关」这条语义。 */
export function isCloudPromptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_CLOUD_PROMPTS === '1';
}

/**
 * fire-and-forget 初始化云端 prompt 下发。
 * 未开启时直接返回（不发任何网络请求）；失败只 warn，降级到内置 prompt。
 */
export function kickoffCloudPrompts(): void {
  if (!isCloudPromptsEnabled()) {
    logger.info('Cloud prompts disabled (set CODE_AGENT_CLOUD_PROMPTS=1 to enable); using builtin prompts');
    return;
  }
  void import('../host/services/cloud/promptService')
    .then(async ({ initPromptService, getPromptsInfo }) => {
      const { getAuthService } = await import('../host/services/auth/authService');
      await initPromptService({ getAccessToken: () => getAuthService().getAccessToken() });
      const info = getPromptsInfo();
      // 留痕：下发生效时必须能从日志看出来源与版本，否则「agent 变笨了」无从归因。
      logger.info('Cloud prompts initialized', { source: info.source, version: info.version || 'builtin' });
    })
    .catch((error) => logger.warn('Cloud prompts init failed (falling back to builtin):', (error as Error).message));
}
