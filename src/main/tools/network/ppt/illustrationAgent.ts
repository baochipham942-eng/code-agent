// ============================================================================
// AI 配图自动生成模块
//
// 在 PPT 生成 pipeline 的步骤 4 和步骤 5 之间，
// 自动为适合配图的幻灯片调用 CogView/FLUX 生成插图。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { StructuredSlide, ListContent, Cards3Content, TimelineContent, ComparisonContent } from './slideSchemas';
import type { SlideImage } from './types';
import {
  generateImage,
  determineImageEngine,
  downloadImageAsBase64,
  isImageUrl,
  type ImageEngine,
} from '../imageGenerate';
import { getAuthService } from '../../../services/auth/authService';
import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('IllustrationAgent');

// ============================================================================
// Types
// ============================================================================

export interface IllustrationOptions {
  maxImages: number;        // 最多生成几张配图，默认 3
  engine: 'cogview' | 'flux' | 'auto';  // auto = 根据 API key 自动选择
  aspectRatio?: string;     // 默认 16:9
  style?: string;           // 配图风格覆盖
}

// ============================================================================
// Theme → Visual Style Mapping (for CogView/FLUX prompt generation)
// ============================================================================

const THEME_VISUAL_STYLES: Record<string, string> = {
  '霓虹绿': '深色科技风格，黑色背景，霓虹绿色光晕，赛博朋克质感，发光线条',
  '电光蓝': '深色科技风格，深蓝背景，青蓝色光效，数字化氛围，冷色调',
  '霓虹紫': '深色梦幻风格，深紫背景，紫色霓虹光效，未来感，神秘氛围',
  '霓虹橙': '深色温暖风格，暗棕背景，橙色光晕，能量感，活力四射',
  '玻璃浅色': '浅色磨砂玻璃风格，白色背景，柔和蓝色调，苹果风格，简洁干净',
  '玻璃深色': '深色磨砂玻璃风格，深灰背景，紫色渐变，现代设计，优雅质感',
  '极简黑白': '极简黑白风格，白色背景，线条插画，干净留白，Typography 风格',
  '企业蓝': '商务专业风格，白色背景，蓝色调，清晰整洁，信任感',
  '苹果暗黑': '苹果深色风格，纯黑背景，精致光影，产品展示风格，高级质感',
};

// Fallback: theme config key → style (if theme.name not found)
const THEME_KEY_STYLES: Record<string, string> = {
  'neon-green': '深色科技风格，黑色背景，霓虹绿色光晕，赛博朋克质感，发光线条',
  'neon-blue': '深色科技风格，深蓝背景，青蓝色光效，数字化氛围，冷色调',
  'neon-purple': '深色梦幻风格，深紫背景，紫色霓虹光效，未来感，神秘氛围',
  'neon-orange': '深色温暖风格，暗棕背景，橙色光晕，能量感，活力四射',
  'glass-light': '浅色磨砂玻璃风格，白色背景，柔和蓝色调，苹果风格，简洁干净',
  'glass-dark': '深色磨砂玻璃风格，深灰背景，紫色渐变，现代设计，优雅质感',
  'minimal-mono': '极简黑白风格，白色背景，线条插画，干净留白，Typography 风格',
  'corporate': '商务专业风格，白色背景，蓝色调，清晰整洁，信任感',
  'apple-dark': '苹果深色风格，纯黑背景，精致光影，产品展示风格，高级质感',
};

// ============================================================================
// Slide Scoring
// ============================================================================

/**
 * 评估幻灯片是否适合配图
 *
 * 排除条件：
 * - title/end 页面（封面/结尾不需要配图）
 * - stats 布局（数字卡片已有视觉效果）
 * - chart 布局（图表已有视觉元素）
 * - quote 布局（引用页追求简洁）
 *
 * 适合条件：
 * - list/cards-3/timeline/comparison 等文字密集布局
 * - 内容包含可视化概念关键词
 */
function scoreSlideForIllustration(slide: StructuredSlide, _index: number): number {
  // Skip first (title) and last (end) slides
  if (slide.isTitle || slide.isEnd) return 0;

  // Skip chart and stats layouts (already visual)
  if (slide.layout === 'chart' || slide.layout === 'stats') return 0;

  // Skip quote layout (should stay minimal)
  if (slide.layout === 'quote') return 0;

  let score = 1;

  // Prefer content-heavy layouts
  if (slide.layout === 'cards-3' || slide.layout === 'list') score += 2;
  if (slide.layout === 'timeline') score += 1;
  if (slide.layout === 'comparison') score += 1;
  if (slide.layout === 'highlight') score += 2;

  // Check for visual concept keywords in title and content
  const textParts: string[] = [slide.title || ''];

  const content = slide.content as any;
  if (content) {
    if (content.points && Array.isArray(content.points)) {
      textParts.push(...content.points);
    }
    if (content.cards && Array.isArray(content.cards)) {
      textParts.push(...content.cards.map((c: any) => `${c.title || ''} ${c.description || ''}`));
    }
    if (content.steps && Array.isArray(content.steps)) {
      textParts.push(...content.steps.map((s: any) => `${s.title || ''} ${s.description || ''}`));
    }
    if (content.left && content.left.points) {
      textParts.push(...content.left.points);
    }
    if (content.right && content.right.points) {
      textParts.push(...content.right.points);
    }
  }

  const text = textParts.join(' ');

  const visualKeywords = [
    '产品', '设计', '架构', '流程', '场景', '用户', '界面', '体验',
    '技术', '系统', '平台', '方案', '模型', '数据', '分析', '增长',
    '创新', '智能', '未来', '转型', '生态', '战略',
    'product', 'design', 'architecture', 'workflow', 'user', 'system',
    'platform', 'technology', 'AI', 'model', 'growth', 'innovation',
  ];

  const matchCount = visualKeywords.filter(kw => text.includes(kw)).length;
  score += Math.min(matchCount, 3); // Cap at +3

  return score;
}

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * 为幻灯片生成 CogView/FLUX 提示词
 *
 * 融合：slide 内容摘要 + theme 视觉风格 + 通用质量词
 */
function buildIllustrationPrompt(slide: StructuredSlide, themeName: string): string {
  const themeStyle =
    THEME_VISUAL_STYLES[themeName] ||
    THEME_KEY_STYLES[themeName] ||
    THEME_KEY_STYLES['corporate'];

  // Extract core concept from slide
  const title = slide.title || '';
  const contentParts: string[] = [];

  const content = slide.content as any;
  if (content) {
    if (content.points && Array.isArray(content.points)) {
      contentParts.push(content.points.slice(0, 2).join('，'));
    }
    if (content.cards && Array.isArray(content.cards)) {
      contentParts.push(content.cards.map((c: any) => c.title).join('，'));
    }
    if (content.steps && Array.isArray(content.steps)) {
      contentParts.push(content.steps.map((s: any) => s.title).join('，'));
    }
  }

  const concept = [title, ...contentParts].filter(Boolean).join('，');

  // Build prompt: concept + style + quality
  const prompt = `${concept}，${themeStyle}，高质量插图，16:9 横版构图，适合演示文稿配图，无文字`;

  return prompt;
}

// ============================================================================
// FLUX model resolution (mirrors imageGenerate.ts logic)
// ============================================================================

const FLUX_MODELS = {
  pro: 'black-forest-labs/flux.2-pro',
  schnell: 'black-forest-labs/flux.2-klein-4b',
} as const;

function resolveFluxModel(): string {
  try {
    const authService = getAuthService();
    const user = authService.getCurrentUser();
    return (user?.isAdmin ?? false) ? FLUX_MODELS.pro : FLUX_MODELS.schnell;
  } catch {
    return FLUX_MODELS.schnell;
  }
}

// ============================================================================
// Main Entry
// ============================================================================

/**
 * 主入口：为幻灯片批量生成 AI 配图
 *
 * @param slides - 结构化幻灯片数组
 * @param themeName - 主题名称（ThemeConfig.name，如"霓虹绿"）
 * @param options - 配图选项
 * @param outputDir - 图片输出目录（保存生成的图片文件）
 * @returns 增强后的 SlideImage 数组（供 index.ts 合并到 slideImages）
 */
export async function generateSlideIllustrations(
  slides: StructuredSlide[],
  themeName: string,
  options: IllustrationOptions = { maxImages: 3, engine: 'auto' },
  outputDir?: string,
): Promise<SlideImage[]> {
  const { maxImages = 3, engine = 'auto', aspectRatio = '16:9' } = options;

  // 1. Score all slides
  const scored = slides.map((slide, index) => ({
    slide,
    index,
    score: scoreSlideForIllustration(slide, index),
  }));

  // 2. Select top N candidates
  const candidates = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxImages);

  if (candidates.length === 0) {
    logger.debug('No slides suitable for illustration');
    return [];
  }

  logger.debug(`Illustration candidates: ${candidates.map(c => `slide ${c.index + 1} (score=${c.score})`).join(', ')}`);

  // Determine engine
  const resolvedEngine: ImageEngine = engine === 'auto' ? determineImageEngine() : engine;
  const fluxModel = resolveFluxModel();

  // Prepare output directory
  const imgDir = outputDir || path.join(process.cwd(), '.code-agent', 'ppt-illustrations');
  if (!fs.existsSync(imgDir)) {
    fs.mkdirSync(imgDir, { recursive: true });
  }

  // 3. Generate illustrations concurrently
  const results = await Promise.allSettled(
    candidates.map(async ({ slide, index }) => {
      const prompt = buildIllustrationPrompt(slide, themeName);
      logger.debug(`[slide ${index + 1}] Generating illustration: ${prompt.substring(0, 60)}...`);

      try {
        const { imageData: rawImageData, actualModel } = await generateImage(
          resolvedEngine,
          fluxModel,
          prompt,
          aspectRatio,
        );

        logger.debug(`[slide ${index + 1}] Generated with model: ${actualModel}`);

        // Download URL to base64 if needed, then save to file
        let imageBase64: string;
        if (isImageUrl(rawImageData)) {
          imageBase64 = await downloadImageAsBase64(rawImageData);
        } else {
          imageBase64 = rawImageData;
        }

        // Save to file (pptxgenjs addImage works best with file paths)
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const imgPath = path.join(imgDir, `illustration-slide${index + 1}-${Date.now()}.png`);
        fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));

        logger.info(`[slide ${index + 1}] Illustration saved: ${imgPath}`);

        return {
          slide_index: index,
          image_path: imgPath,
          position: 'right' as const,
        } satisfies SlideImage;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Silent failure - slide just won't have an image
        logger.warn(`[slide ${index + 1}] Failed to generate illustration: ${message}`);
        return null;
      }
    })
  );

  // 4. Collect successful results
  const generatedImages: SlideImage[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      generatedImages.push(result.value);
    }
  }

  logger.info(`Generated ${generatedImages.length}/${candidates.length} illustrations`);
  return generatedImages;
}
