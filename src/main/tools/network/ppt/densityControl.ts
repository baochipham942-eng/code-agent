// ============================================================================
// PPT 信息密度控制
// ============================================================================

import type { SlideData } from './types';

/**
 * 将超过 maxPoints 个要点的幻灯片拆分为多张。
 * 拆分时均匀分配要点，新幻灯片标题追加 " (续)"。
 */
export function splitOverloadedSlides(
  slides: SlideData[],
  maxPoints: number = 6,
): SlideData[] {
  const result: SlideData[] = [];

  for (const slide of slides) {
    if (slide.points.length <= maxPoints) {
      result.push(slide);
      continue;
    }

    const points = slide.points;
    const totalParts = Math.ceil(points.length / maxPoints);
    const baseSize = Math.floor(points.length / totalParts);
    const remainder = points.length % totalParts;

    let offset = 0;
    for (let i = 0; i < totalParts; i++) {
      // Distribute remainder across the first few parts for even distribution
      const size = baseSize + (i < remainder ? 1 : 0);
      const chunk = points.slice(offset, offset + size);
      offset += size;

      const newSlide: SlideData = {
        title: i === 0 ? slide.title : `${slide.title} (续)`,
        points: chunk,
        subtitle: i === 0 ? slide.subtitle : undefined,
        layout: slide.layout,
        isTitle: i === 0 ? slide.isTitle : false,
        isEnd: false,
        code: i === 0 ? slide.code : undefined,
        table: i === 0 ? slide.table : undefined,
      };
      result.push(newSlide);
    }
  }

  return result;
}

/**
 * 合并相邻的稀疏幻灯片（要点数 < minPoints）。
 * 不合并标题页和结束页。合并后使用第一张幻灯片的标题。
 */
export function mergeThinSlides(
  slides: SlideData[],
  minPoints: number = 2,
): SlideData[] {
  const result: SlideData[] = [];
  let pending: SlideData | null = null;

  for (const slide of slides) {
    // Title/end slides are never merged
    if (slide.isTitle || slide.isEnd) {
      if (pending) {
        result.push(pending);
        pending = null;
      }
      result.push(slide);
      continue;
    }

    const isThin = slide.points.length < minPoints;

    if (!isThin) {
      if (pending) {
        result.push(pending);
        pending = null;
      }
      result.push(slide);
      continue;
    }

    // Thin slide — try to merge with pending
    if (pending) {
      const merged: SlideData = {
        title: pending.title,
        points: [...pending.points, ...slide.points],
        subtitle: pending.subtitle || slide.subtitle,
        layout: pending.layout,
        isTitle: pending.isTitle,
        isEnd: pending.isEnd,
        code: pending.code,
        table: pending.table,
      };
      pending = merged;
    } else {
      pending = {
        title: slide.title,
        points: [...slide.points],
        subtitle: slide.subtitle,
        layout: slide.layout,
        isTitle: slide.isTitle,
        isEnd: slide.isEnd,
        code: slide.code,
        table: slide.table,
      };
    }
  }

  if (pending) {
    result.push(pending);
  }

  return result;
}

/**
 * 信息密度标准化：先拆分过载幻灯片，再合并稀疏幻灯片。
 *
 * @param slides - 原始幻灯片数组
 * @param options.maxPoints - 单张幻灯片最大要点数（默认 6）
 * @param options.minPoints - 触发合并的最小要点数（默认 2）
 */
export function normalizeDensity(
  slides: SlideData[],
  options?: { maxPoints?: number; minPoints?: number },
): SlideData[] {
  const maxPoints = options?.maxPoints ?? 6;
  const minPoints = options?.minPoints ?? 2;

  const split = splitOverloadedSlides(slides, maxPoints);
  return mergeThinSlides(split, minPoints);
}
