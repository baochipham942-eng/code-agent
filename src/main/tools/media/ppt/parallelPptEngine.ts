// ============================================================================
// Parallel PPT Engine - Slide 级并行内容准备
// ============================================================================
// 3 阶段编排：
// Phase 1: 大纲生成（串行，1 步）
// Phase 2: N 张 slide 并行内容准备（纯函数，可并行）
// Phase 3: pptxgenjs 组装（串行，addSlide 必须串行）
//
// 关键设计：pptxgenjs addSlide() 必须串行，但内容准备（解析+布局选择+图表数据）
// 是纯函数，可以并行执行。
// ============================================================================

import type { SlideData, ThemeConfig, SlideImage, ChartMode, ChartSlotData } from './types';
import { selectMasterAndLayout } from './layouts';
import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('ParallelPptEngine');

// ============================================================================
// Types
// ============================================================================

export interface SlidePreparation {
  index: number;
  slideData: SlideData;
  master: string;
  layout: import('./types').LayoutType;
  chartData: ChartSlotData | null;
  images: SlideImage[];
}

export interface ParallelPptResult {
  preparations: SlidePreparation[];
  parallelTimeMs: number;
  totalTimeMs: number;
}

// ============================================================================
// Parallel Content Preparation
// ============================================================================

/**
 * Prepare a single slide's content (pure function, parallelizable)
 */
function prepareSlide(
  index: number,
  slideData: SlideData,
  images: SlideImage[],
  chartMode: ChartMode
): SlidePreparation {
  const currentImages = images.filter(img => img.slide_index === index);

  const { master, layout, chartData } = selectMasterAndLayout(
    slideData,
    currentImages.length > 0,
    chartMode
  );

  return {
    index,
    slideData,
    master,
    layout,
    chartData,
    images: currentImages,
  };
}

/**
 * Run parallel content preparation for all slides
 *
 * Phase 2 of the 3-phase pipeline:
 * - Each slide's content type detection, layout selection, and chart data extraction
 *   runs in parallel (they are pure functions with no shared state)
 * - Returns an array of SlidePreparation objects ordered by index
 *
 * @param slides - Parsed slide data
 * @param images - User-provided images
 * @param chartMode - Chart detection mode
 * @returns Prepared slides ready for assembly
 */
export async function prepareSlidesConcurrently(
  slides: SlideData[],
  images: SlideImage[],
  chartMode: ChartMode
): Promise<ParallelPptResult> {
  const totalStart = Date.now();
  const parallelStart = Date.now();

  // Run all slide preparations concurrently
  // Each preparation is CPU-bound but lightweight (~1ms per slide),
  // so Promise.all with microtask scheduling gives good parallelism
  const preparations = await Promise.all(
    slides.map((slideData, index) =>
      Promise.resolve(prepareSlide(index, slideData, images, chartMode))
    )
  );

  const parallelTimeMs = Date.now() - parallelStart;

  // Sort by index to ensure correct order for assembly
  preparations.sort((a, b) => a.index - b.index);

  logger.info(`Parallel preparation complete: ${preparations.length} slides in ${parallelTimeMs}ms`);

  return {
    preparations,
    parallelTimeMs,
    totalTimeMs: Date.now() - totalStart,
  };
}

/**
 * Check if parallel mode should be used
 *
 * @param slideCount - Number of slides
 * @returns true if parallel engine should be used
 */
export function shouldUseParallelEngine(slideCount: number): boolean {
  // Use parallel engine for 4+ slides
  return slideCount >= 4;
}
