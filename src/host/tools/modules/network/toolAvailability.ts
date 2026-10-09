// ============================================================================
// Key-gated tool availability —— 外部 key 缺失的工具不进工具表、不可被 ToolSearch 搜到
// ----------------------------------------------------------------------------
// 与 decideAvailability.ts 同一套收敛哲学：注册面（protocol registry /
// DEFERRED_TOOLS_META）是无条件的，「这一轮能不能用」由本谓词在枚举处收敛：
// getDeferredToolDefinitions / getLoadedDeferredToolDefinitions /
// getDeferredToolsSummary / toolSearchService.getAllSearchableTools。
// 只收「handler 硬依赖外部 key、缺 key 调用必失败」的工具；有 keyless 降级路径的
// 工具（read_pdf 本地 pdftotext、youtube_transcript 公共 fallback API）刻意不进表
// ——把还能用的工具藏掉，模型就会对可用能力谎报「没这个能力」。
// 独立成文件 + 直接 import services/core/configService（不走 services barrel），
// 让 services/toolSearch 引它时不把 barrel 的重依赖拉进 import 期（同 decideAvailability）。
// ============================================================================

import { getConfigService } from '../../../services/core/configService';
import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('ToolAvailability');

/** visual_edit / text_to_speech 共用的智谱 key 查找（模型设置 / env 同源）。 */
export function getConfiguredZhipuApiKey(): string | undefined {
  return getConfigService().getApiKey('zhipu');
}

/** gui_agent 的火山/豆包 key（非标准 provider，只认 env，不进 configService）。 */
export function getGuiAgentVolcengineApiKey(): string | undefined {
  return process.env.VOLCENGINE_API_KEY || process.env.DOUBAO_API_KEY;
}

/** video_generate 的智谱官方视频 key：env 优先；0ki/代理前缀 oki- 不认。 */
export function getZhipuOfficialVideoApiKey(): string | undefined {
  const officialKey = process.env.ZHIPU_OFFICIAL_API_KEY;
  if (officialKey) return officialKey;
  const zhipuKey = getConfigService().getApiKey('zhipu');
  if (zhipuKey && !zhipuKey.startsWith('oki-')) return zhipuKey;
  return undefined;
}

function visualEditCheck(): boolean {
  return Boolean(getConfiguredZhipuApiKey());
}

function guiAgentCheck(): boolean {
  return Boolean(getGuiAgentVolcengineApiKey());
}

function textToSpeechCheck(): boolean {
  return Boolean(getConfiguredZhipuApiKey());
}

function videoGenerateCheck(): boolean {
  return Boolean(getZhipuOfficialVideoApiKey());
}

// 键是工具名（snake_case 是工具命名约定，经 property 选择器放行）
const TOOL_KEY_CHECKS: Record<string, () => boolean> = {
  visual_edit: visualEditCheck,
  gui_agent: guiAgentCheck,
  text_to_speech: textToSpeechCheck,
  video_generate: videoGenerateCheck,
};

const warnedTools = new Set<string>();

/**
 * 工具是否可用 = 其外部 key 是否已配置。未登记的名字一律 true（本表只做减法，
 * 永不把本可用的工具误藏）。key 查找抛错按「不可用」处理，每工具只 warn 一次——
 * 枚举路径绝不能因一次 key 读取失败炸掉整张工具表（范式同 isDecideToolAvailable）。
 * 直选（select:）仍可命中，但加载后进不了工具表；handler 侧的 fail-loud
 * dependency hint 原样保留作兜底。
 */
export function isToolAvailable(name: string): boolean {
  const check = TOOL_KEY_CHECKS[name];
  if (!check) return true;
  try {
    return check();
  } catch (error) {
    if (!warnedTools.has(name)) {
      warnedTools.add(name);
      logger.warn(`availability check failed for ${name}; treating it as unavailable`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }
}
