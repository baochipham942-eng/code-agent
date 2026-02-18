// ============================================================================
// Slide Content Agent - 结构化 Slide 内容生成
// ============================================================================
// v7 重写：SCQA 叙事 + Action Title + 数据锚定 + Speaker Notes
// 保留原有本地启发式 enrichment 作为 fallback。
// ============================================================================

import { createLogger } from '../../../services/infra/logger';
import type { SlideData, ResearchContext } from './types';
import type { StructuredSlide } from './slideSchemas';
import { validateStructuredSlides } from './slideSchemas';

const logger = createLogger('SlideContentAgent');

// ============================================================================
// Types
// ============================================================================

export interface SlideContentRequest {
  /** Slide index (0-based) */
  index: number;
  /** Slide title */
  title: string;
  /** Existing points (may be empty if only outline was provided) */
  existingPoints: string[];
  /** Overall presentation topic */
  topic: string;
  /** Target point count per slide */
  targetPointCount: number;
}

export interface SlideContentResult {
  index: number;
  points: string[];
  subtitle?: string;
  enriched: boolean;
}

// ============================================================================
// Content Enrichment (Local Heuristic — Fallback)
// ============================================================================

/**
 * Enrich a slide's content if it has too few points (no model call)
 */
export function enrichSlideContent(request: SlideContentRequest): SlideContentResult {
  const { index, title, existingPoints, targetPointCount } = request;

  if (existingPoints.length >= targetPointCount) {
    return {
      index,
      points: existingPoints.slice(0, targetPointCount + 1),
      enriched: false,
    };
  }

  const enrichedPoints = [...existingPoints];
  const remaining = targetPointCount - enrichedPoints.length;
  const templates = selectTemplatesByKeywords(title);

  for (let i = 0; i < remaining; i++) {
    enrichedPoints.push(templates[i % templates.length]);
  }

  logger.debug(`Enriched slide ${index}: ${existingPoints.length} → ${enrichedPoints.length} points`);

  return { index, points: enrichedPoints, enriched: true };
}

/**
 * Batch enrich all slides that need more content
 */
export function batchEnrichSlides(
  slides: SlideData[],
  topic: string,
  targetPointCount: number = 4
): SlideData[] {
  return slides.map((slide, index) => {
    if (slide.isTitle || slide.isEnd) return slide;

    const result = enrichSlideContent({
      index,
      title: slide.title,
      existingPoints: slide.points,
      topic,
      targetPointCount,
    });

    if (result.enriched) {
      return { ...slide, points: result.points, subtitle: result.subtitle || slide.subtitle };
    }
    return slide;
  });
}

export type ModelContentGenerator = (
  slideTitle: string,
  topic: string,
  existingPoints: string[]
) => Promise<string[]>;

export async function batchEnrichSlidesWithModel(
  slides: SlideData[],
  topic: string,
  generator: ModelContentGenerator,
  targetPointCount: number = 4
): Promise<SlideData[]> {
  const enrichmentPromises = slides.map(async (slide, index) => {
    if (slide.isTitle || slide.isEnd || slide.points.length >= targetPointCount) {
      return slide;
    }
    try {
      const generatedPoints = await generator(slide.title, topic, slide.points);
      return { ...slide, points: generatedPoints.slice(0, targetPointCount + 1) };
    } catch {
      logger.warn(`Model enrichment failed for slide ${index}, using heuristic fallback`);
      const result = enrichSlideContent({
        index, title: slide.title, existingPoints: slide.points, topic, targetPointCount,
      });
      return { ...slide, points: result.points };
    }
  });
  return Promise.all(enrichmentPromises);
}

// ============================================================================
// 关键词→模板映射库
// ============================================================================

const CONTENT_TEMPLATES: Record<string, string[]> = {
  background: [
    '行业发展现状与市场规模分析',
    '当前面临的主要挑战与痛点',
    '技术发展趋势与机遇',
    '目标用户群体与需求洞察',
    '竞争格局与差异化定位',
    '政策环境与合规要求',
  ],
  technology: [
    '核心技术架构与设计理念',
    '关键算法与实现方案',
    '性能指标与优化策略',
    '技术栈选型与依赖管理',
    '安全性设计与数据保护',
    '扩展性与高可用架构',
  ],
  value: [
    '核心价值主张与差异化优势',
    '用户体验提升与效率改进',
    '成本节省与 ROI 分析',
    '市场份额增长与用户留存',
    '品牌影响力与口碑效应',
    '长期战略价值与生态构建',
  ],
  plan: [
    '短期目标与里程碑规划',
    '资源配置与团队分工',
    '风险识别与应对策略',
    '关键成功指标与验收标准',
    '时间节点与交付计划',
    '持续迭代与优化路径',
  ],
  case: [
    '典型应用场景与实践案例',
    '客户反馈与满意度数据',
    '实施效果与量化成果',
    '最佳实践与经验总结',
    '行业标杆对比分析',
    '成功要素与可复制模式',
  ],
  product: [
    '产品定位与目标市场',
    '核心功能与特色亮点',
    '用户体验与交互设计',
    '技术实现与架构选型',
    '竞品分析与差异化策略',
    '商业模式与盈利路径',
  ],
};

const KEYWORD_MAP: [RegExp, string][] = [
  [/背景|现状|行业|市场|环境|趋势/i, 'background'],
  [/技术|架构|实现|原理|算法|系统|模块|开发/i, 'technology'],
  [/价值|优势|收益|效果|成果|意义|核心/i, 'value'],
  [/计划|规划|路线|目标|下一步|未来|展望/i, 'plan'],
  [/案例|场景|应用|实践|客户|用户/i, 'case'],
  [/产品|功能|特性|服务|解决方案/i, 'product'],
];

function selectTemplatesByKeywords(title: string): string[] {
  for (const [pattern, category] of KEYWORD_MAP) {
    if (pattern.test(title)) {
      return CONTENT_TEMPLATES[category];
    }
  }
  return CONTENT_TEMPLATES.value;
}

// ============================================================================
// v7: 研究驱动的结构化 Slide 生成
// ============================================================================

/**
 * 构建研究数据摘要（注入 prompt）
 */
function formatResearchForPrompt(research: ResearchContext): string {
  const parts: string[] = [];

  if (research.statistics.length > 0) {
    parts.push('## 已验证的统计数据（必须引用，不可虚构）');
    for (const s of research.statistics.slice(0, 10)) {
      parts.push(`- ${s.label}: ${s.value}${s.description ? ` (${s.description})` : ''} [来源: ${s.source}]`);
    }
  }

  if (research.facts.length > 0) {
    parts.push('\n## 关键事实');
    for (const f of research.facts.slice(0, 8)) {
      parts.push(`- ${f.content} [${f.source}]`);
    }
  }

  if (research.quotes.length > 0) {
    parts.push('\n## 可用引言');
    for (const q of research.quotes.slice(0, 3)) {
      parts.push(`- "${q.text}" — ${q.attribution}`);
    }
  }

  return parts.join('\n');
}

/**
 * 构建 SCQA + 数据锚定 + Speaker Notes 的内容生成 Prompt
 */
function buildResearchEnrichedPrompt(
  topic: string,
  slideCount: number,
  research?: ResearchContext,
): string {
  const researchSection = research ? `
---
${formatResearchForPrompt(research)}
---

⚠️ 所有数据必须来自上述"已验证的统计数据"，禁止虚构数字。` : '';

  return `你是麦肯锡级别的演示文稿设计师。为主题"${topic}"设计 ${slideCount} 张幻灯片。
${researchSection}

返回 JSON 数组，每张幻灯片包含 layout、title、对应布局字段（直接放在对象上），以及 speakerNotes。

## 叙事结构（SCQA 框架 — 最重要！）

按以下结构组织 ${slideCount} 页内容：
- 第 1 页：**封面**（isTitle: true）
- 第 2 页：**S（Situation）背景**（1 页，建立事实共识）
- 第 3 页：**C（Complication）矛盾**（1 页，揭示核心问题）
- 第 4-${Math.max(slideCount - 2, 5)} 页：**A（Answer）方案**（金字塔展开，占 ~70% 页数）
- 最后 1 页：**结尾**（isEnd: true，行动号召）

## Action Title 铁律

标题必须是 **结论**，不是主题标签：
❌ "市场分析"  "技术架构"  "应用场景"
✅ "Agent 市场 $680 亿，但 90% 仍在试点"  "三层架构解决延迟瓶颈"

每个标题必须让读者只看标题就能获取核心信息。最多 10 个中文字。

## Speaker Notes（必填！）

每页 speakerNotes 字段 = 演讲者口述稿：
- 1-3 段，每段 2-4 句，总计 100-200 字
- Slide 上只放关键数字和结论
- 细节、数据来源、论证过程留给 speakerNotes
- 格式：自然口语，适合演讲时对照阅读

## 每个要点必须有 "so what"

❌ "市场规模持续增长"
✅ "YoY +147%，垂直领域增速是通用型的 3 倍 — 机会在细分市场"

## 排版铁律

PPT 不是报告文档。遵循 **7×7 规则**：每页最多 5 个要点，每个要点最多 20 个中文字。
标题必须一行放下（最多 10 个中文字）。留白 > 内容。

| 字段 | 最大字数 | 说明 |
|------|---------|------|
| title | 10 字 | 结论式标题 |
| stats.label | 5 字 | 指标名 |
| stats.value | 6 字 | 具体数字 |
| stats.description | 10 字 | 数字对比 |
| cards.title | 6 字 | 卡片标题 |
| cards.description | 25 字 | 两行以内 |
| list.points[] | 20 字 | 一行一个洞察 |
| timeline.title | 6 字 | 步骤标题 |
| timeline.description | 20 字 | 两行以内 |

## 可用布局
1. stats: stats [{label, value, description?}] — 3-4 个关键指标
2. cards-3: cards [{title, description}] — 恰好 3 张卡片
3. list: points [string] — 3-5 个要点
4. timeline: steps [{title, description}] — 3-4 个步骤
5. comparison: left/right {title, points:[string]} — 对比
6. quote: quote + attribution — 引言
7. chart: points [] + chartData {labels, values, chartType:"bar"|"line"|"doughnut"}

## 规则
- 第 1 页: isTitle: true，用 list layout，points 含一句话副标题
- 最后 1 页: isEnd: true
- 相邻页面不用相同 layout
- stats.value 必须是具体数字（"$680亿"、"47%"），不要模糊词
- 每页必须有 speakerNotes

只返回 JSON 数组，不要其他文字。`;
}

/**
 * 构建基础 Prompt（无 research 数据时使用）
 */
function buildStructuredSlidesPrompt(topic: string, slideCount: number): string {
  return buildResearchEnrichedPrompt(topic, slideCount);
}

/**
 * 从模型响应中提取 JSON 数组
 */
function extractJsonArray(text: string): StructuredSlide[] | null {
  // 直接解析
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* continue */ }

  // 提取 ```json ... ``` 块
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* continue */ }
  }

  // 提取 [ ... ] 块
  const bracketMatch = text.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      const parsed = JSON.parse(bracketMatch[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* continue */ }
  }

  return null;
}

/**
 * 使用模型生成结构化 Slide 内容（v7 增强版）
 *
 * @param topic - 演示主题
 * @param slideCount - 幻灯片数量
 * @param modelCallback - 模型调用回调
 * @param research - 可选的研究上下文（v7 新增）
 * @returns StructuredSlide[] 或 null（失败时）
 */
export async function generateStructuredSlides(
  topic: string,
  slideCount: number,
  modelCallback: (prompt: string) => Promise<string>,
  research?: ResearchContext,
): Promise<StructuredSlide[] | null> {
  try {
    const prompt = research
      ? buildResearchEnrichedPrompt(topic, slideCount, research)
      : buildStructuredSlidesPrompt(topic, slideCount);
    const response = await modelCallback(prompt);

    const slides = extractJsonArray(response);
    if (!slides || slides.length === 0) {
      logger.warn('Failed to parse structured slides from model response');
      return null;
    }

    // 验证
    const { validSlides, errors } = validateStructuredSlides(slides);

    if (errors.length > 0) {
      logger.warn(`Structured slides validation: ${validSlides.length} valid, ${errors.length} errors`);
      for (const err of errors.slice(0, 3)) {
        logger.debug(`  Slide ${err.index}: ${err.errors.join(', ')}`);
      }
    }

    if (validSlides.length === 0) {
      logger.warn('No valid structured slides after validation');
      return null;
    }

    return validSlides;
  } catch (error: any) {
    logger.warn(`generateStructuredSlides failed: ${error.message}`);
    return null;
  }
}
