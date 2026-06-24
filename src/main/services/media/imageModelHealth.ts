// ============================================================================
// imageModelHealth — 内置生图模型「健康优先选型 + 单步兜底」（2a #3）
// ----------------------------------------------------------------------------
// 背景：handleGenerateDesignImage 原先盲目默认 wanx-t2i，DashScope 余额不足/未配 key 时
// 整个出图直接抛错。本模块提供两件事：
//   1) 健康选型：只在「API key 已配置」的内置模型里挑默认（schema 所谓 unavailable 即未配）；
//   2) 单步兜底：chosen 模型因「余额/配额」类错误失败时，换下一个健康模型重试一次（非循环）。
//
// 仅覆盖内置静态表（wanx/cogview/gptimage/flux）。custom（openai-compat）有各自独立 key、
// 无同族可兜底，不进本模块——由 handler 的 custom 分支单独处理。
//
// billing 不变量：兜底只针对「余额/配额」类错误，这类错误在出图付费**之前**被端点拒绝
// （没出图=没扣费），故「A 失败 → B 重试」净扣 1 次，不会双扣。其它类错误（auth/network/
// timeout 等）不触发换模型，自然也不会重复付费。
// ============================================================================

import { getConfigService } from '../core/configService';
import {
  getDashscopeApiKey,
  getZhipuOfficialApiKey,
  getGptImageConfig,
} from './imageGenerationService';
import { imageModelById, defaultImageModelId } from '../../../shared/constants/visualModels';

// 图像专用「余额/欠费」错误白名单（审计 MED-1）：不复用通用 LLM 的 classifyProviderFallbackReason
// quota 分类——它含裸 `credit`/`billing` 子串，第三方生图中转返回任意含这些词的文案（如
// "billing address invalid" / "credential error"）会误判成余额、误触发一次额外付费，违反 billing
// 红线。这里只收窄到真·余额/欠费信号（中英 + DashScope/OpenAI 兼容端点常见串），且补上通用
// 分类漏掉的「欠费/Arrearage」。只有命中这里才触发单步兜底。
const IMAGE_BALANCE_ERROR_PATTERN =
  /insufficient[_ ]?balance|insufficient[_ ]?quota|余额不足|余额为负|欠费|\barrear|payment required|\b402\b/i;

/** 判定一条出图错误是否「余额/欠费」类（=付费前被端点拒，是兜底换模型的唯一触发条件）。 */
export function isImageBalanceError(message: string): boolean {
  return IMAGE_BALANCE_ERROR_PATTERN.test(message || '');
}

// 内置生图模型健康优先级：wanx 居首=设计底座（mask/扩图均依赖），其后按通用文生图可用性排。
// 选默认与单步兜底都按此顺序取首个已配模型。
export const IMAGE_MODEL_HEALTH_PRIORITY: readonly string[] = [
  'wanx-t2i',
  'gpt-image-2',
  'cogview-4',
  'flux-2',
];

/** 某内置生图模型的 API key 是否已配置（health 判定）。未知 / custom id 一律 false。 */
export function isImageModelConfigured(modelId: string): boolean {
  switch (modelId) {
    case 'wanx-t2i':
      return Boolean(getDashscopeApiKey());
    case 'cogview-4':
      return Boolean(getZhipuOfficialApiKey());
    case 'gpt-image-2':
      return Boolean(getGptImageConfig());
    case 'flux-2':
      return Boolean(getConfigService().getApiKey('openrouter'));
    default:
      return false;
  }
}

/** 已配 key 的内置生图模型（按健康优先级排）。 */
export function configuredImageModelIds(): string[] {
  return IMAGE_MODEL_HEALTH_PRIORITY.filter((id) => isImageModelConfigured(id));
}

/**
 * 纯选择器：从 configuredIds（已按优先级排）里挑要用的模型。
 *  · requested 命中内置表且在 configuredIds 中 → 用 requested（尊重用户显式选择）；
 *  · 否则（未设 / 未知 / 未配 key=schema 所谓 unavailable）→ 首个已配模型；
 *  · 一个都没配 → 回退静态 default（wanx-t2i），让下游"需要 key"原错正常浮现，零回归。
 */
export function pickHealthyImageModelId(
  requested: string | null | undefined,
  configuredIds: string[],
): string {
  if (requested && imageModelById(requested) && configuredIds.includes(requested)) {
    return requested;
  }
  return configuredIds[0] ?? defaultImageModelId();
}

/**
 * 纯选择器：单步兜底——返回 ≠ failedId 的下一个已配模型（configuredIds 已按优先级排）；
 * 没有可兜底则 null。绝不返回 failedId 自身，绝不循环（调用方只重试一次）。
 */
export function pickNextHealthyImageModelId(
  failedId: string,
  configuredIds: string[],
): string | null {
  return configuredIds.find((id) => id !== failedId) ?? null;
}

/** 健康选型（读真实配置）：requested 不健康则退首个已配，全未配回退静态 default。 */
export function resolveHealthyImageModelId(requested?: string | null): string {
  return pickHealthyImageModelId(requested, configuredImageModelIds());
}

/** 单步兜底（读真实配置）：返回 ≠ failedId 的下一个已配模型，无则 null。 */
export function nextHealthyImageModelId(failedId: string): string | null {
  return pickNextHealthyImageModelId(failedId, configuredImageModelIds());
}
