// AI 增强大纲（增强 #1）：调默认文本模型据 topic 生成针对性大纲（标题+要点），
// 替代确定性 SCQA 模板。付费调用——前端 opt-in；无 key（免 key 供应商除外）/ 失败 / 空响应一律降级确定性大纲。
// 模型取法：resolveSessionDefaultModelConfig（用户配置的默认模型优先）+ getApiKey。
import { ModelRouter } from '../../model/modelRouter';
import { getConfigService } from '../core/configService';
import { resolveSessionDefaultModelConfig } from '../core/sessionDefaults';
import type { ModelConfig } from '@shared/contract';
import { PROVIDER_REGISTRY } from '../../model/providerRegistry';
import type { SlideData } from '../../tools/media/ppt/types';
import { parseContentToSlides, outlineToSlideData } from '../../tools/media/ppt/parser';

const DEFAULT_SLIDES_COUNT = 10;

let router: ModelRouter | null = null;

export interface AiOutlineResult {
  slides: SlideData[];
  /** true=AI 真生成；false=降级到确定性模板（无 key / 失败 / 空响应 / 解析为空）。 */
  ai: boolean;
}

/**
 * 让模型产出 parseContentToSlides 可解析的 Markdown 大纲。
 * brief：agent 已调研的事实/数据/结构。提供则要求模型**据此生成、优先采用、不要编造**，
 * 让 AI 大纲落地到真实调研而非对着干瘪 topic 瞎编（PPT 质量关键）。
 */
export function buildOutlinePrompt(topic: string, count: number, brief?: string): string {
  const briefT = (brief ?? '').trim();
  return [
    `你是演示稿大纲专家。为主题「${topic}」生成一份 ${count} 页演示稿大纲。`,
    '',
    '严格输出 Markdown，不要任何额外说明文字：',
    '- 第一行用 `# 封面标题`（一句话点题）',
    '- 之后每页用 `## 页面标题`，其下用 `- 要点` 列 3~4 条要点',
    `- 总页数约 ${count} 页，逻辑递进（背景→问题→方案→价值→落地→总结之类）`,
    '- 要点具体、信息密度高，避免空话套话',
    ...(briefT
      ? [
          '',
          '已有调研材料（务必据此生成，优先采用其中的事实与数据，不要编造、不要套空话模板）：',
          briefT,
        ]
      : []),
    '',
    `主题：${topic}`,
  ].join('\n');
}

/**
 * 生成 AI 大纲。无 key / 调用失败 / 响应空 / 解析为空时降级 outlineToSlideData，ai=false。
 */
export async function buildAiOutline(topic: string, slidesCount?: number, brief?: string): Promise<AiOutlineResult> {
  const topicT = (topic ?? '').trim();
  if (!topicT) throw new Error('生成大纲需要主题（topic 不能为空）');
  const count = slidesCount && slidesCount > 0 ? slidesCount : DEFAULT_SLIDES_COUNT;
  const fallback: AiOutlineResult = { slides: outlineToSlideData(topicT, count), ai: false };

  try {
    const configService = getConfigService();
    const baseConfig = resolveSessionDefaultModelConfig();
    const apiKey = configService.getApiKey(baseConfig.provider);
    // 免 key 供应商（如 local）不因空 key 降级，key 由 provider 自补
    if (!apiKey && PROVIDER_REGISTRY[baseConfig.provider]?.requiresApiKey !== false) {
      return fallback; // 无 key → 静默降级（前端据 ai=false 提示）
    }

    if (!router) router = new ModelRouter();
    const config: ModelConfig = {
      ...baseConfig,
      apiKey,
      temperature: 0.7,
      maxTokens: 2048,
    };
    const response = await router.inference(
      [{ role: 'user', content: buildOutlinePrompt(topicT, count, brief) }],
      [],
      config,
    );
    const text = (response.content ?? '').trim();
    if (!text) return fallback;
    // 提示词契约是「# 封面 + 每页一个 ##」，模型按字面输出即 count+1 页；上限须含封面，否则末节被静默截掉
    const slides = parseContentToSlides(text, count + 1, { h2AsPages: true });
    return slides.length > 0 ? { slides, ai: true } : fallback;
  } catch {
    return fallback;
  }
}
