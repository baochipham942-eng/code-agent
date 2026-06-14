// ============================================================================
// CapabilityRecommender — Step 7 PR 2
//
// 当 plan agent 或 ToolSearch / ModelRouter 发现能力缺口时（缺工具、缺模型能
// 力、缺 API key），由本服务统一诊断并返回结构化 Gap，喂给 GapCard UI（PR 3）
// 或者作为 system reminder 注入 LLM context。
//
// 设计原则：
// - 数据源走单一权威：plugin manifest.capabilities + PR 1 的 getModelCapabilities
// - 不硬编码 capability → plugin 映射表，从 manifest 反查；未启用 plugin 只作为候选推荐
// - 不做 fuzzy / 同义词扩展，命中精确就拼；语义匹配交给 LLM 自己判断
// ============================================================================

import { getExtensionRegistry } from '../../extension/extensionRegistry';
import { getConfigService } from '../core/configService';
import { findCapableModels } from '../../model/modelRouter';
import type { ModelDomainCapability } from '../../../shared/constants';
import {
  type CapabilityGap,
  type CapabilityGapPluginCandidate,
} from '../../../shared/contract/capabilityGap';
import { createLogger } from '../infra/logger';

export type { CapabilityGap } from '../../../shared/contract/capabilityGap';

const logger = createLogger('CapabilityRecommender');

/**
 * model capability 标签白名单（PR 1 `ModelDomainCapability` 字面量）。
 * 用 Set 做 O(1) 类型守卫，避免在 scanForCapability 内做字符串 switch。
 */
const MODEL_CAPABILITIES: ReadonlySet<ModelDomainCapability> = new Set([
  'tool',
  'vision',
  'reasoning',
  'long-context',
  'search',
]);

function isModelCapability(tag: string): tag is ModelDomainCapability {
  return MODEL_CAPABILITIES.has(tag as ModelDomainCapability);
}

/**
 * 简易关键词 → ModelDomainCapability 启发式映射。
 *
 * 仅用于 `recommendForToolError` 把 tool 名 / 错误消息映射到能力标签。
 * 命中规则：tool 名或错误 message 包含关键词字面量（小写后比较）。
 * 不命中返回 null —— 调用方决定怎么 fallback。
 */
const TOOL_ERROR_HINT_RULES: ReadonlyArray<{
  keywords: readonly string[];
  capability: ModelDomainCapability;
}> = [
  { keywords: ['image_analyze', 'image-analyze', 'vision', '截图分析', 'ocr'], capability: 'vision' },
  { keywords: ['think_step', 'reasoning', '推理', 'deep_think'], capability: 'reasoning' },
  { keywords: ['long_context', 'long-context', '长上下文', '长文本'], capability: 'long-context' },
  { keywords: ['web_search', 'search', 'browse', '联网', '搜索'], capability: 'search' },
];

function buildPluginCandidateScan(requiredCapability: string): {
  activeHit: boolean;
  candidates: CapabilityGapPluginCandidate[];
} {
  // 只看 plugin 类扩展(builtin/plugin source)。当前 skill metadata 不投影
  // capabilities,所以 skill 不会被 `capabilities?.includes(...)` 命中。
  //
  // 注意 source filter 不是"防御未来 skill 加 capabilities 时不误命中" ——
  // ExtensionRegistry 允许 skill source 是 builtin / plugin(plugin-sourced
  // skill / builtin skill),与本 filter 用同一组字面量,无法区分 plugin
  // extension 和 plugin-sourced skill。
  //
  // 将来若 skill metadata 扩出 capabilities,要靠 surface 或独立 type
  // discriminator(如 `e.metadata.surfaces.includes('tools')`)而非 source 锁。
  const matches = getExtensionRegistry()
    .getExtensions()
    .filter(
      (e) =>
        (e.metadata.source === 'builtin' || e.metadata.source === 'plugin') &&
        e.metadata.capabilities?.includes(requiredCapability),
    );

  return {
    activeHit: matches.some((e) => e.runtimeState === 'active'),
    candidates: matches
      .filter((e) => e.runtimeState !== 'active')
      .map((e) => ({
        id: e.metadata.id,
        name: e.metadata.name || e.metadata.id,
        // ExtensionMetadata.version 类型上是 optional,但 plugin source 来自
        // PluginManifest(schema 强制 version),运行时必有。给 '' fallback
        // 仅满足 contract `version: string`。
        version: e.metadata.version ?? '',
        // metadata.description 在 plugin adapter 里被强制成空字符串,这里保留
        // 原 contract 的 undefined 语义(下游 UI 拿 falsy 判断不渲染该行)
        description: e.metadata.description || undefined,
      })),
  };
}

/**
 * CapabilityRecommender — 能力缺口诊断器。
 *
 * 不持有状态；每次调用都走当前 PluginRegistry / ConfigService 快照。
 */
export class CapabilityRecommender {
  /**
   * 扫描指定 capability 标签，返回结构化 Gap 列表。
   *
   * 扫描三层：
   *   1. plugin 层：active plugin manifest.capabilities 是否包含此标签
   *   2. model 层：若是 ModelDomainCapability，遍历 PROVIDER_REGISTRY 找候选
   *   3. apikey 层：候选 model 全部存在但 provider 都没配 key
   *
   * 任一层有命中（含部分命中）则该层不入 gap；缺什么报什么。
   * `requiredCapability` 不需要在 ModelDomainCapability 字面量内 —— plugin
   * 层永远扫，但 model 层只有合法标签才扫。
   */
  scanForCapability(requiredCapability: string): CapabilityGap[] {
    const gaps: CapabilityGap[] = [];

    // ── Layer 1: plugin 层 ────────────────────────────────────────────────
    const pluginCandidateScan = buildPluginCandidateScan(requiredCapability);
    if (!pluginCandidateScan.activeHit) {
      gaps.push({
        type: 'plugin',
        missing: requiredCapability,
        candidates: pluginCandidateScan.candidates,
      });
    }

    // ── Layer 2/3: model + apikey 层 ─────────────────────────────────────
    if (isModelCapability(requiredCapability)) {
      const cap = requiredCapability;
      const candidates = findCapableModels(cap);

      if (candidates.length === 0) {
        gaps.push({
          type: 'model',
          missing: cap,
          candidates: [],
        });
      } else {
        const cfg = getConfigService();
        const anyConfigured = candidates.some((c) => cfg.hasConfiguredKey(c.provider));
        if (!anyConfigured) {
          // 首选 provider = findCapableModels 已按 "已配 key 优先 +
          // PROVIDER_FALLBACK_CHAIN 顺序" 排序后的第一个候选。
          gaps.push({
            type: 'apikey',
            missing: cap,
            provider: candidates[0].provider,
          });
        }
      }
    }

    return gaps;
  }

  /**
   * 从 tool 失败信号反推 capability 缺口。
   *
   * 规则：先匹配 tool 名 / error message 的关键词，命中 capability tag 后走
   * scanForCapability；如果系统里已有可用候选模型，再额外返回当前模型缺
   * capability 的 ModelGap，方便 UI 引导用户切换主任务模型。
   * 不命中返回空数组（让 ToolSearch 兜底文案不变化）。
   */
  recommendForToolError(toolName: string, error: Error): CapabilityGap[] {
    const haystack = `${toolName} ${error.message}`.toLowerCase();
    const matched = TOOL_ERROR_HINT_RULES.find((rule) =>
      rule.keywords.some((kw) => haystack.includes(kw.toLowerCase())),
    );
    if (!matched) {
      logger.debug('[CapabilityRecommender] tool error has no capability hint', {
        toolName,
      });
      return [];
    }
    const gaps = this.scanForCapability(matched.capability);

    if (!isModelCapability(matched.capability)) {
      return gaps;
    }
    const hasModelOrApiKeyGap = gaps.some((gap) =>
      (gap.type === 'model' || gap.type === 'apikey') && gap.missing === matched.capability,
    );
    if (hasModelOrApiKeyGap) {
      return gaps;
    }

    const cfg = getConfigService();
    const configuredCandidates = findCapableModels(matched.capability)
      .filter((candidate) => cfg.hasConfiguredKey(candidate.provider));
    if (configuredCandidates.length === 0) {
      return gaps;
    }

    return [
      ...gaps,
      {
        type: 'model',
        missing: matched.capability,
        candidates: configuredCandidates,
      },
    ];
  }
}

// ============================================================================
// Singleton（与同目录其他 service 风格一致，简化调用方）
// ============================================================================

let globalRecommender: CapabilityRecommender | null = null;

export function getCapabilityRecommender(): CapabilityRecommender {
  if (!globalRecommender) {
    globalRecommender = new CapabilityRecommender();
  }
  return globalRecommender;
}

/** 测试用 reset。 */
export function resetCapabilityRecommender(): void {
  globalRecommender = null;
}
