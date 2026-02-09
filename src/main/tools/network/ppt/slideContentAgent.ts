// ============================================================================
// Slide Content Agent - 单张 Slide 的内容生成
// ============================================================================
// 可委托模型生成单张 slide 的详细内容。
// 用于 parallelPptEngine 的 Phase 2，当用户只给了标题/大纲时，
// 通过模型为每张 slide 生成详细要点。
// ============================================================================

import { createLogger } from '../../../services/infra/logger';
import type { SlideData } from './types';

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
// Content Enrichment
// ============================================================================

/**
 * Enrich a slide's content if it has too few points
 *
 * This is a local heuristic enrichment (no model call).
 * For full model-based enrichment, use the model callback variant.
 *
 * @param request - Content request
 * @returns Enriched content result
 */
export function enrichSlideContent(request: SlideContentRequest): SlideContentResult {
  const { index, title, existingPoints, targetPointCount } = request;

  // If we already have enough points, return as-is
  if (existingPoints.length >= targetPointCount) {
    return {
      index,
      points: existingPoints.slice(0, targetPointCount + 1), // Allow 1 extra
      enriched: false,
    };
  }

  // Generate placeholder points based on title keywords
  const enrichedPoints = [...existingPoints];
  const remaining = targetPointCount - enrichedPoints.length;

  for (let i = 0; i < remaining; i++) {
    enrichedPoints.push(`${title} — 补充要点 ${i + 1}`);
  }

  logger.debug(`Enriched slide ${index}: ${existingPoints.length} → ${enrichedPoints.length} points`);

  return {
    index,
    points: enrichedPoints,
    enriched: true,
  };
}

/**
 * Batch enrich all slides that need more content
 *
 * @param slides - Parsed slides
 * @param topic - Overall topic
 * @param targetPointCount - Target points per slide (default: 4)
 * @returns Enriched slides
 */
export function batchEnrichSlides(
  slides: SlideData[],
  topic: string,
  targetPointCount: number = 4
): SlideData[] {
  return slides.map((slide, index) => {
    // Skip title and end slides
    if (slide.isTitle || slide.isEnd) {
      return slide;
    }

    const result = enrichSlideContent({
      index,
      title: slide.title,
      existingPoints: slide.points,
      topic,
      targetPointCount,
    });

    if (result.enriched) {
      return {
        ...slide,
        points: result.points,
        subtitle: result.subtitle || slide.subtitle,
      };
    }

    return slide;
  });
}

/**
 * Model-based content generation callback type
 *
 * Implementations should call the model to generate detailed content
 * for a single slide given its title and topic.
 */
export type ModelContentGenerator = (
  slideTitle: string,
  topic: string,
  existingPoints: string[]
) => Promise<string[]>;

/**
 * Enrich slides using a model callback (for future use)
 *
 * Each slide is enriched concurrently via Promise.all
 */
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
      return {
        ...slide,
        points: generatedPoints.slice(0, targetPointCount + 1),
      };
    } catch (error) {
      logger.warn(`Model enrichment failed for slide ${index}, using heuristic fallback`);
      const result = enrichSlideContent({
        index,
        title: slide.title,
        existingPoints: slide.points,
        topic,
        targetPointCount,
      });
      return { ...slide, points: result.points };
    }
  });

  return Promise.all(enrichmentPromises);
}
