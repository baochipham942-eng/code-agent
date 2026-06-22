// AI 增强大纲（增强 #1）：调默认文本模型据 topic 生成针对性大纲（标题+要点），
// 替代确定性 SCQA 模板。付费调用——前端 opt-in；无 key / 失败 / 空响应一律降级确定性大纲。
// 模型取法对齐 compactModel（lazy ModelRouter 单例 + 默认 provider/model + getApiKey）。
import { ModelRouter } from '../../model/modelRouter';
import { getConfigService } from '../core/configService';
import { DEFAULT_PROVIDER } from '@shared/constants/defaults';
import { DEFAULT_MODELS } from '@shared/constants/models';
import type { ModelConfig, ModelProvider } from '@shared/contract';
import type { SlideData } from '../../tools/media/ppt/types';
import { parseContentToSlides, outlineToSlideData } from '../../tools/media/ppt/parser';

const DEFAULT_SLIDES_COUNT = 10;

let router: ModelRouter | null = null;

export interface AiOutlineResult {
  slides: SlideData[];
  /** true=AI 真生成；false=降级到确定性模板（无 key / 失败 / 空响应 / 解析为空）。 */
  ai: boolean;
}

/** 让模型产出 parseContentToSlides 可解析的 Markdown 大纲。 */
export function buildOutlinePrompt(topic: string, count: number): string {
  return [
    `你是演示稿大纲专家。为主题「${topic}」生成一份 ${count} 页演示稿大纲。`,
    '',
    '严格输出 Markdown，不要任何额外说明文字：',
    '- 第一行用 `# 封面标题`（一句话点题）',
    '- 之后每页用 `## 页面标题`，其下用 `- 要点` 列 3~4 条要点',
    `- 总页数约 ${count} 页，逻辑递进（背景→问题→方案→价值→落地→总结之类）`,
    '- 要点具体、信息密度高，避免空话套话',
    '',
    `主题：${topic}`,
  ].join('\n');
}

/**
 * 生成 AI 大纲。无 key / 调用失败 / 响应空 / 解析为空时降级 outlineToSlideData，ai=false。
 */
export async function buildAiOutline(topic: string, slidesCount?: number): Promise<AiOutlineResult> {
  const topicT = (topic ?? '').trim();
  if (!topicT) throw new Error('生成大纲需要主题（topic 不能为空）');
  const count = slidesCount && slidesCount > 0 ? slidesCount : DEFAULT_SLIDES_COUNT;
  const fallback: AiOutlineResult = { slides: outlineToSlideData(topicT, count), ai: false };

  try {
    const configService = getConfigService();
    const settings = configService.getSettings();
    const provider = (settings.model?.provider || DEFAULT_PROVIDER) as ModelProvider;
    const apiKey = configService.getApiKey(provider);
    if (!apiKey) return fallback; // 无 key → 静默降级（前端据 ai=false 提示）

    if (!router) router = new ModelRouter();
    const config: ModelConfig = {
      provider,
      model: settings.model?.model || DEFAULT_MODELS.chat,
      apiKey,
      baseUrl: settings.models?.providers?.[provider]?.baseUrl,
      temperature: 0.7,
      maxTokens: 2048,
    };
    const response = await router.inference(
      [{ role: 'user', content: buildOutlinePrompt(topicT, count) }],
      [],
      config,
    );
    const text = (response.content ?? '').trim();
    if (!text) return fallback;
    const slides = parseContentToSlides(text, count);
    return slides.length > 0 ? { slides, ai: true } : fallback;
  } catch {
    return fallback;
  }
}
