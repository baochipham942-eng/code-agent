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

/**
 * 设置页上用户能点到的原文。host 不引 renderer，字面量与这些词条保持一致，
 * 单测用同一批 i18n 导出拼路径核对：
 *   sidebarZh/En.sidebar.menuSettings
 *   zhSettingsCore/enSettingsCore.tabs.model
 *   zhSettingsModels/enSettingsModels.model.providers.zhipu.name（两种语言都是「智谱 AI」）
 *   model.list.addKey
 * gui_agent 只认 env、设置页没有入口，不进这张表。
 */
const ZHIPU_SETTINGS_PATH_EN = 'Settings -> General model -> 智谱 AI (Add Key)';
const ZHIPU_SETTINGS_PATH_ZH = '设置 -> 通用模型 -> 智谱 AI（添加 Key）';

interface ToolUnlockHint {
  toolName: string;
  capabilityEn: string;
  capabilityZh: string;
  settingsPathEn: string;
  settingsPathZh: string;
}

const TOOL_UNLOCK_HINTS: readonly ToolUnlockHint[] = [
  {
    toolName: 'text_to_speech',
    capabilityEn: 'speech synthesis',
    capabilityZh: '语音合成',
    settingsPathEn: ZHIPU_SETTINGS_PATH_EN,
    settingsPathZh: ZHIPU_SETTINGS_PATH_ZH,
  },
  {
    toolName: 'video_generate',
    capabilityEn: 'video generation',
    capabilityZh: '视频生成',
    settingsPathEn: ZHIPU_SETTINGS_PATH_EN,
    settingsPathZh: ZHIPU_SETTINGS_PATH_ZH,
  },
  {
    toolName: 'visual_edit',
    capabilityEn: 'click-to-edit in preview',
    capabilityZh: '预览里点选编辑',
    settingsPathEn: ZHIPU_SETTINGS_PATH_EN,
    settingsPathZh: ZHIPU_SETTINGS_PATH_ZH,
  },
];

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

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

/**
 * 延迟工具摘要末尾的一行：列出尚未配 key、且本轮没有被拒绝的能力（能力名，不是工具名），
 * 并给出设置页路径。明确写「不要调用」。没有可提示的能力时返回空串。
 */
export function unavailableUnlockHintLine(deniedToolNames: readonly string[] = []): string {
  const denied = new Set(deniedToolNames.map((name) => name.trim().toLowerCase()));
  const locked = TOOL_UNLOCK_HINTS.filter((hint) =>
    !denied.has(hint.toolName) && !isToolAvailable(hint.toolName));
  if (locked.length === 0) return '';
  const capabilityEn = locked.map((hint) => hint.capabilityEn).join(', ');
  const capabilityZh = locked.map((hint) => hint.capabilityZh).join('、');
  const settingsPathEn = uniqueInOrder(locked.map((hint) => hint.settingsPathEn)).join('; ');
  const settingsPathZh = uniqueInOrder(locked.map((hint) => hint.settingsPathZh)).join('；');
  return [
    `The following capabilities are not enabled (do not call them): ${capabilityEn}.`,
    `Turn on: ${settingsPathEn}.`,
    `以下能力未开启（不要调用）：${capabilityZh}。`,
    `开启：${settingsPathZh}。`,
  ].join(' ');
}
