// ============================================================================
// PPT Legacy 渲染函数 - @deprecated 降级方案
// 保留所有旧渲染逻辑，供 use_masters: false 时使用
// ============================================================================

import * as fs from 'fs';
import type { ThemeConfig, LayoutType, DiagramType, SlideImage } from './types';
import {
  renderMermaidNative,
  AGENT_LOOP_MERMAID,
  SKILLS_MERMAID,
  SANDBOX_MERMAID,
  LSP_COMPARE_MERMAID,
  type ThemeConfig as MermaidTheme,
} from '../mermaidToNative';

// 布局轮换计数器（避免连续相同布局）
let layoutRotationIndex = 0;

/** @deprecated 请使用 layouts.ts 中的 selectMasterAndLayout */
export function resetLayoutRotation(): void {
  layoutRotationIndex = 0;
}

// ============================================================================
// 内容类型检测
// ============================================================================

/** @deprecated 请使用 layouts.ts */
export function detectContentType(title: string, points: string[]): {
  hasNumbers: boolean;
  isProcess: boolean;
  isComparison: boolean;
  isKeyPoint: boolean;
  isTechnical: boolean;
} {
  const allText = [title, ...points].join(' ').toLowerCase();

  return {
    // 至少 3 个要点含数字才视为数据型内容（适合 stats 布局）
    hasNumbers: points.filter(p => /\d+[\d.,]*[%万亿KMB]?/i.test(p)).length >= 3,
    // 流程/步骤只看标题，避免要点中"开发流程"等复合词误触发
    isProcess: /流程|步骤|阶段|step|phase|stage/i.test(title),
    isComparison: /对比|比较|vs|区别|优势|劣势|特点/i.test(allText),
    isKeyPoint: /核心|关键|重点|最重要|价值|意义/i.test(title),
    isTechnical: /架构|技术|实现|原理|算法|系统|模块/i.test(title),
  };
}

/** @deprecated 请使用 layouts.ts 中的 selectMasterAndLayout */
export function selectLayoutType(title: string, points: string[]): LayoutType {
  const content = detectContentType(title, points);
  const pointCount = points.length;

  if (content.isTechnical) return 'cards-2';
  if (content.isProcess && pointCount >= 3) return 'timeline';
  if (content.isKeyPoint && pointCount <= 4) return 'highlight';
  if (content.isComparison && pointCount >= 3) return 'cards-2';
  if (content.hasNumbers && pointCount >= 3 && pointCount <= 5) return 'stats';
  if (pointCount === 3) return 'cards-3';

  if (pointCount >= 4) {
    // stats 只在 hasNumbers 条件下触发，不参与轮换
    const layouts: LayoutType[] = ['cards-2', 'list'];
    const selected = layouts[layoutRotationIndex % layouts.length];
    layoutRotationIndex++;
    return selected;
  }

  if (pointCount <= 2) return 'highlight';
  return 'list';
}

// ============================================================================
// 基础布局函数
// ============================================================================

/** @deprecated */
export function renderStatsLayout(slide: any, points: string[], theme: ThemeConfig) {
  const withNumbers = points.filter(p => /\d+[\d.,]*[%万亿KMB]?/i.test(p));
  const stats = (withNumbers.length >= 3 ? withNumbers : points).slice(0, 4);
  const cardWidth = 2.1;
  const cardHeight = 2.8;
  const gap = 0.2;
  const startX = (10 - (stats.length * cardWidth + (stats.length - 1) * gap)) / 2;
  const y = 1.8;

  stats.forEach((point, i) => {
    const x = startX + i * (cardWidth + gap);
    const numMatch = point.match(/(\d+[\d.,]*[%万亿KMB+]?)\s*(分钟|小时|天|周|个月|年|倍|人|位|个|项|款|种|次)?/i);
    const numText = numMatch ? (numMatch[1] + (numMatch[2] || '')) : String(i + 1);
    const descText = point.replace(/[，,：:；;]/g, ' ').trim();

    slide.addShape('roundRect', {
      x, y, w: cardWidth, h: cardHeight,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 1 },
      rectRadius: 0.15,
    });
    slide.addShape('rect', {
      x: x + 0.3, y: y + 0.2, w: cardWidth - 0.6, h: 0.04,
      fill: { color: theme.accent },
    });
    slide.addText(numText, {
      x, y: y + 0.4, w: cardWidth, h: 1,
      fontSize: 36, fontFace: theme.fontTitle,
      color: theme.accent, bold: true, align: 'center',
    });
    slide.addText(descText, {
      x: x + 0.15, y: y + 1.5, w: cardWidth - 0.3, h: 1.1,
      fontSize: 12, fontFace: theme.fontBody,
      color: theme.textSecondary, align: 'center', valign: 'top',
    });
  });
}

/** @deprecated */
export function renderCards2Layout(slide: any, points: string[], theme: ThemeConfig) {
  const leftPoints = points.slice(0, Math.ceil(points.length / 2));
  const rightPoints = points.slice(Math.ceil(points.length / 2));

  slide.addShape('roundRect', {
    x: 0.4, y: 1.6, w: 4.4, h: 3.5,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 1 },
    rectRadius: 0.12,
  });

  leftPoints.forEach((point, i) => {
    slide.addText(`▸ ${point}`, {
      x: 0.6, y: 1.85 + i * 0.8, w: 4, h: 0.7,
      fontSize: 14, fontFace: theme.fontBody,
      color: i === 0 ? theme.textPrimary : theme.textSecondary,
      valign: 'top',
    });
  });

  rightPoints.forEach((point, i) => {
    const y = 1.6 + i * 1.2;
    slide.addShape('roundRect', {
      x: 5.1, y, w: 4.4, h: 1.05,
      fill: { color: theme.bgSecondary },
      line: { color: i === 0 ? theme.accent : theme.cardBorder, width: i === 0 ? 2 : 1 },
      rectRadius: 0.1,
    });
    slide.addText(point, {
      x: 5.3, y: y + 0.15, w: 4, h: 0.75,
      fontSize: 13, fontFace: theme.fontBody,
      color: theme.textSecondary, valign: 'middle',
    });
  });
}

/** @deprecated */
export function renderCards3Layout(slide: any, points: string[], theme: ThemeConfig) {
  const displayPoints = points.slice(0, 3);
  const cardWidth = 2.9;
  const gap = 0.25;
  const startX = 0.5;

  displayPoints.forEach((point, i) => {
    const x = startX + i * (cardWidth + gap);
    slide.addShape('roundRect', {
      x, y: 1.7, w: cardWidth, h: 3.4,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 1 },
      rectRadius: 0.12,
    });
    slide.addShape('ellipse', {
      x: x + cardWidth / 2 - 0.3, y: 2.0, w: 0.6, h: 0.6,
      fill: { color: theme.accent },
    });
    slide.addText(String(i + 1), {
      x: x + cardWidth / 2 - 0.3, y: 2.0, w: 0.6, h: 0.6,
      fontSize: 20, fontFace: theme.fontTitle,
      color: theme.bgColor, bold: true, align: 'center', valign: 'middle',
    });
    slide.addText(point, {
      x: x + 0.2, y: 2.8, w: cardWidth - 0.4, h: 2.1,
      fontSize: 13, fontFace: theme.fontBody,
      color: theme.textSecondary, valign: 'top', align: 'center',
    });
  });
}

/** @deprecated */
export function renderListLayout(slide: any, points: string[], theme: ThemeConfig) {
  const displayPoints = points.slice(0, 5);
  const lineHeight = 0.72;
  const startY = 1.7;

  displayPoints.forEach((point, i) => {
    const y = startY + i * lineHeight;
    slide.addText(String(i + 1).padStart(2, '0'), {
      x: 0.5, y, w: 0.6, h: lineHeight,
      fontSize: 18, fontFace: theme.fontTitle,
      color: theme.accent, bold: true, valign: 'middle',
    });
    slide.addShape('ellipse', {
      x: 1.2, y: y + lineHeight / 2 - 0.04, w: 0.08, h: 0.08,
      fill: { color: theme.accent },
    });
    slide.addText(point, {
      x: 1.45, y, w: 8, h: lineHeight,
      fontSize: 16, fontFace: theme.fontBody,
      color: theme.textPrimary, valign: 'middle',
    });
  });
}

/** @deprecated */
export function renderHighlightLayout(slide: any, points: string[], theme: ThemeConfig) {
  if (points.length === 0) return;

  slide.addText(points[0], {
    x: 0.5, y: 1.8, w: 9, h: 1.5,
    fontSize: 28, fontFace: theme.fontBody,
    color: theme.textPrimary, valign: 'middle',
    line: { color: theme.accent, width: 0, dashType: 'solid' },
  });
  slide.addShape('rect', {
    x: 0.3, y: 1.9, w: 0.08, h: 1.2,
    fill: { color: theme.accent },
  });

  if (points.length > 1) {
    slide.addShape('roundRect', {
      x: 0.5, y: 3.6, w: 9, h: 1.4,
      fill: { color: theme.bgSecondary },
      rectRadius: 0.1,
    });
    slide.addText(points[1], {
      x: 0.7, y: 3.8, w: 8.6, h: 1,
      fontSize: 16, fontFace: theme.fontBody,
      color: theme.textSecondary, valign: 'middle',
    });
  }
}

/** @deprecated */
export function renderTimelineLayout(slide: any, points: string[], theme: ThemeConfig) {
  const displayPoints = points.slice(0, 4);
  const stepWidth = 2.2;
  const startX = 0.6;
  const y = 2.4;

  slide.addShape('rect', {
    x: startX + 0.3, y: y + 0.25, w: 8.2, h: 0.03,
    fill: { color: theme.cardBorder },
  });

  displayPoints.forEach((point, i) => {
    const x = startX + i * stepWidth;
    slide.addShape('ellipse', {
      x: x + 0.15, y: y + 0.1, w: 0.35, h: 0.35,
      fill: { color: theme.accent },
    });
    slide.addText(`Step ${i + 1}`, {
      x, y: y - 0.5, w: stepWidth, h: 0.4,
      fontSize: 11, fontFace: theme.fontTitle,
      color: theme.accent, align: 'center',
    });
    slide.addText(point, {
      x, y: y + 0.6, w: stepWidth, h: 2,
      fontSize: 12, fontFace: theme.fontBody,
      color: theme.textSecondary, align: 'center', valign: 'top',
    });
  });
}

// ============================================================================
// Premium 布局函数
// ============================================================================

/** @deprecated */
export function renderStatsLayoutPremium(slide: any, points: string[], theme: ThemeConfig) {
  // 只选取包含可提取数字的要点
  const withNumbers = points.filter(p => /\d+[\d.,]*[%万亿KMB]?/i.test(p));
  const stats = (withNumbers.length >= 3 ? withNumbers : points).slice(0, 4);
  const cardWidth = 2.05;
  const cardHeight = 3.2;
  const gap = 0.22;
  const startX = (10 - (stats.length * cardWidth + (stats.length - 1) * gap)) / 2;
  const y = 1.55;

  stats.forEach((point, i) => {
    const x = startX + i * (cardWidth + gap);
    const numMatch = point.match(/(\d+[\d.,]*[%万亿KMB+]?)\s*(分钟|小时|天|周|个月|年|倍|人|位|个|项|款|种|次)?/i);
    const numText = numMatch ? (numMatch[1] + (numMatch[2] || '')) : String(i + 1);
    // 保留完整文本作为描述
    const descText = point.replace(/[，,：:；;]/g, ' ').trim();

    slide.addShape('roundRect', {
      x: x - 0.05, y: y - 0.05, w: cardWidth + 0.1, h: cardHeight + 0.1,
      fill: { color: theme.accent, transparency: 95 },
      rectRadius: 0.2,
    });
    slide.addShape('roundRect', {
      x, y, w: cardWidth, h: cardHeight,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 0.5 },
      rectRadius: 0.15,
    });
    slide.addShape('roundRect', {
      x: x + 0.1, y: y + 0.1, w: cardWidth - 0.2, h: 0.8,
      fill: { color: theme.accent, transparency: 90 },
      rectRadius: 0.1,
    });
    slide.addShape('ellipse', {
      x: x + cardWidth / 2 - 0.22, y: y + 0.3, w: 0.44, h: 0.44,
      fill: { color: theme.accent },
    });
    slide.addText(String(i + 1), {
      x: x + cardWidth / 2 - 0.22, y: y + 0.3, w: 0.44, h: 0.44,
      fontSize: 14, fontFace: theme.fontTitle,
      color: theme.bgColor, bold: true, align: 'center', valign: 'middle',
    });
    slide.addText(numText, {
      x, y: y + 1, w: cardWidth, h: 0.8,
      fontSize: 32, fontFace: theme.fontTitle,
      color: theme.accent, bold: true, align: 'center',
    });
    slide.addShape('rect', {
      x: x + 0.4, y: y + 1.85, w: cardWidth - 0.8, h: 0.02,
      fill: { color: theme.cardBorder },
    });
    slide.addText(descText, {
      x: x + 0.15, y: y + 2, w: cardWidth - 0.3, h: 1.1,
      fontSize: 11, fontFace: theme.fontBody,
      color: theme.textSecondary, align: 'center', valign: 'top',
    });
  });
}

/** @deprecated */
export function renderCards2LayoutPremium(slide: any, points: string[], theme: ThemeConfig) {
  const leftPoints = points.slice(0, Math.ceil(points.length / 2));
  const rightPoints = points.slice(Math.ceil(points.length / 2));

  slide.addShape('roundRect', {
    x: 0.35, y: 1.5, w: 4.5, h: 3.7,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 0.5 },
    rectRadius: 0.18,
  });
  slide.addShape('rect', {
    x: 0.55, y: 1.7, w: 0.08, h: 0.5,
    fill: { color: theme.accent },
  });

  leftPoints.forEach((point, i) => {
    slide.addText(point, {
      x: 0.75, y: 1.8 + i * 0.85, w: 3.9, h: 0.75,
      fontSize: 13, fontFace: theme.fontBody,
      color: i === 0 ? theme.textPrimary : theme.textSecondary,
      valign: 'top',
    });
    if (i < leftPoints.length - 1) {
      slide.addShape('rect', {
        x: 0.75, y: 2.5 + i * 0.85, w: 3.5, h: 0.01,
        fill: { color: theme.cardBorder },
      });
    }
  });

  rightPoints.forEach((point, i) => {
    const y = 1.5 + i * 1.25;
    const isFirst = i === 0;
    if (isFirst) {
      slide.addShape('roundRect', {
        x: 5.05, y: y - 0.03, w: 4.5, h: 1.15,
        fill: { color: theme.accent, transparency: 92 },
        rectRadius: 0.15,
      });
    }
    slide.addShape('roundRect', {
      x: 5.1, y, w: 4.4, h: 1.1,
      fill: { color: theme.bgSecondary },
      line: { color: isFirst ? theme.accent : theme.cardBorder, width: isFirst ? 1.5 : 0.5 },
      rectRadius: 0.12,
    });
    slide.addShape('ellipse', {
      x: 5.25, y: y + 0.35, w: 0.4, h: 0.4,
      fill: { color: isFirst ? theme.accent : theme.cardBorder },
    });
    slide.addText(String(i + 1), {
      x: 5.25, y: y + 0.35, w: 0.4, h: 0.4,
      fontSize: 12, fontFace: theme.fontTitle,
      color: isFirst ? theme.bgColor : theme.textSecondary, bold: true, align: 'center', valign: 'middle',
    });
    slide.addText(point, {
      x: 5.8, y: y + 0.2, w: 3.5, h: 0.7,
      fontSize: 12, fontFace: theme.fontBody,
      color: theme.textSecondary, valign: 'middle',
    });
  });
}

/** @deprecated */
export function renderCards3LayoutPremium(slide: any, points: string[], theme: ThemeConfig) {
  const displayPoints = points.slice(0, 3);
  const cardWidth = 2.9;
  const gap = 0.3;
  const startX = 0.55;

  displayPoints.forEach((point, i) => {
    const x = startX + i * (cardWidth + gap);
    const isCenter = i === 1;
    const yOffset = isCenter ? -0.1 : 0;
    const heightBonus = isCenter ? 0.2 : 0;

    if (isCenter) {
      slide.addShape('roundRect', {
        x: x - 0.08, y: 1.55, w: cardWidth + 0.16, h: 3.65,
        fill: { color: theme.accent, transparency: 90 },
        rectRadius: 0.2,
      });
    }
    slide.addShape('roundRect', {
      x, y: 1.65 + yOffset, w: cardWidth, h: 3.4 + heightBonus,
      fill: { color: theme.bgSecondary },
      line: { color: isCenter ? theme.accent : theme.cardBorder, width: isCenter ? 1.5 : 0.5 },
      rectRadius: 0.15,
    });
    slide.addShape('roundRect', {
      x: x + cardWidth / 2 - 0.4, y: 1.9 + yOffset, w: 0.8, h: 0.8,
      fill: { color: theme.accent, transparency: isCenter ? 0 : 85 },
      rectRadius: 0.12,
    });
    slide.addText(String(i + 1), {
      x: x + cardWidth / 2 - 0.4, y: 1.9 + yOffset, w: 0.8, h: 0.8,
      fontSize: 24, fontFace: theme.fontTitle,
      color: isCenter ? theme.bgColor : theme.accent, bold: true, align: 'center', valign: 'middle',
    });
    slide.addShape('rect', {
      x: x + 0.5, y: 2.9 + yOffset, w: cardWidth - 1, h: 0.02,
      fill: { color: theme.cardBorder },
    });
    slide.addText(point, {
      x: x + 0.2, y: 3.1 + yOffset, w: cardWidth - 0.4, h: 1.8 + heightBonus,
      fontSize: 12, fontFace: theme.fontBody,
      color: theme.textSecondary, valign: 'top', align: 'center',
    });
  });
}

/** @deprecated */
export function renderListLayoutPremium(slide: any, points: string[], theme: ThemeConfig) {
  const displayPoints = points.slice(0, 5);
  const lineHeight = 0.78;
  const startY = 1.55;

  displayPoints.forEach((point, i) => {
    const y = startY + i * lineHeight;
    const isFirst = i === 0;

    if (i % 2 === 0) {
      slide.addShape('roundRect', {
        x: 0.4, y, w: 9.2, h: lineHeight - 0.08,
        fill: { color: theme.bgSecondary, transparency: isFirst ? 0 : 50 },
        rectRadius: 0.08,
      });
    }
    if (isFirst) {
      slide.addShape('rect', {
        x: 0.4, y, w: 0.06, h: lineHeight - 0.08,
        fill: { color: theme.accent },
      });
    }
    slide.addShape('roundRect', {
      x: 0.6, y: y + 0.15, w: 0.45, h: 0.45,
      fill: isFirst ? { color: theme.accent } : undefined,
      line: { color: isFirst ? theme.accent : theme.cardBorder, width: 1 },
      rectRadius: 0.08,
    });
    slide.addText(String(i + 1).padStart(2, '0'), {
      x: 0.6, y: y + 0.15, w: 0.45, h: 0.45,
      fontSize: 11, fontFace: theme.fontTitle,
      color: isFirst ? theme.bgColor : theme.textSecondary, bold: true, align: 'center', valign: 'middle',
    });
    slide.addText(point, {
      x: 1.2, y, w: 8, h: lineHeight,
      fontSize: 14, fontFace: theme.fontBody,
      color: isFirst ? theme.textPrimary : theme.textSecondary, valign: 'middle',
    });
  });
}

/** @deprecated */
export function renderHighlightLayoutPremium(slide: any, points: string[], theme: ThemeConfig) {
  if (points.length === 0) return;

  slide.addShape('roundRect', {
    x: 0.4, y: 1.6, w: 9.2, h: 1.8,
    fill: { color: theme.bgSecondary },
    line: { color: theme.accent, width: 2 },
    rectRadius: 0.15,
  });
  slide.addShape('rect', {
    x: 0.55, y: 1.8, w: 0.1, h: 1.4,
    fill: { color: theme.accent },
  });
  slide.addText('"', {
    x: 0.8, y: 1.55, w: 0.5, h: 0.5,
    fontSize: 48, fontFace: theme.fontTitle,
    color: theme.accent, bold: true,
  });
  slide.addText(points[0], {
    x: 0.9, y: 2, w: 8.4, h: 1.2,
    fontSize: 22, fontFace: theme.fontBody,
    color: theme.textPrimary, valign: 'middle',
  });

  if (points.length > 1) {
    slide.addShape('rect', {
      x: 0.5, y: 3.65, w: 9, h: 0.02,
      fill: { color: theme.cardBorder },
    });
    slide.addShape('roundRect', {
      x: 0.4, y: 3.85, w: 9.2, h: 1.25,
      fill: { color: theme.bgSecondary, transparency: 50 },
      rectRadius: 0.1,
    });
    slide.addShape('ellipse', {
      x: 0.6, y: 4.2, w: 0.4, h: 0.4,
      fill: { color: theme.accent, transparency: 70 },
    });
    slide.addText('→', {
      x: 0.6, y: 4.2, w: 0.4, h: 0.4,
      fontSize: 14, color: theme.textPrimary, align: 'center', valign: 'middle',
    });
    slide.addText(points[1], {
      x: 1.15, y: 4.05, w: 8.2, h: 0.9,
      fontSize: 14, fontFace: theme.fontBody,
      color: theme.textSecondary, valign: 'middle',
    });
  }
}

/** @deprecated */
export function renderTimelineLayoutPremium(slide: any, points: string[], theme: ThemeConfig) {
  const displayPoints = points.slice(0, 4);
  const stepWidth = 2.2;
  const startX = 0.65;
  const y = 2.2;

  slide.addShape('rect', {
    x: startX + 0.32, y: y + 0.4, w: 7.8, h: 0.04,
    fill: { color: theme.cardBorder },
  });
  slide.addShape('rect', {
    x: startX + 0.32, y: y + 0.4, w: 2, h: 0.04,
    fill: { color: theme.accent },
  });

  displayPoints.forEach((point, i) => {
    const x = startX + i * stepWidth;
    const isFirst = i === 0;

    slide.addShape('roundRect', {
      x: x - 0.1, y: y - 0.75, w: stepWidth + 0.2, h: 3.6,
      fill: { color: theme.bgSecondary, transparency: isFirst ? 0 : 50 },
      line: { color: isFirst ? theme.accent : theme.cardBorder, width: isFirst ? 1.5 : 0.5 },
      rectRadius: 0.12,
    });
    slide.addShape('ellipse', {
      x: x + stepWidth / 2 - 0.3, y: y + 0.2, w: 0.6, h: 0.6,
      fill: { color: theme.bgColor },
      line: { color: theme.accent, width: 2 },
    });
    slide.addShape('ellipse', {
      x: x + stepWidth / 2 - 0.15, y: y + 0.35, w: 0.3, h: 0.3,
      fill: { color: isFirst ? theme.accent : theme.cardBorder },
    });
    slide.addText(`STEP ${i + 1}`, {
      x, y: y - 0.5, w: stepWidth, h: 0.35,
      fontSize: 10, fontFace: theme.fontTitle,
      color: isFirst ? theme.accent : theme.textSecondary, bold: true, align: 'center', charSpacing: 2,
    });
    slide.addText(point, {
      x: x + 0.1, y: y + 1, w: stepWidth - 0.2, h: 1.7,
      fontSize: 11, fontFace: theme.fontBody,
      color: theme.textSecondary, align: 'center', valign: 'top',
    });
  });
}

// ============================================================================
// 图表渲染（mermaidToNative）
// ============================================================================

/** @deprecated 禁用 - pptxgenjs flipH 有 bug */
export function inferDiagramType(_title: string): DiagramType {
  return 'none';
}

/** @deprecated */
export function drawDiagram(slide: any, type: DiagramType, x: number, y: number, w: number, h: number, theme: ThemeConfig) {
  const bounds = { x, y, w, h };
  const mermaidTheme: MermaidTheme = {
    bgColor: theme.bgColor,
    bgSecondary: theme.bgSecondary,
    textPrimary: theme.textPrimary,
    textSecondary: theme.textSecondary,
    accent: theme.accent,
    cardBorder: theme.cardBorder,
  };

  let mermaidCode: string;
  let title: string;

  switch (type) {
    case 'agent-loop':
      mermaidCode = AGENT_LOOP_MERMAID;
      title = 'Agent Loop 工作流程';
      break;
    case 'skills':
      mermaidCode = SKILLS_MERMAID;
      title = 'Skills 系统';
      break;
    case 'sandbox':
      mermaidCode = SANDBOX_MERMAID;
      title = '安全沙箱机制';
      break;
    case 'lsp-compare':
      mermaidCode = LSP_COMPARE_MERMAID;
      title = 'LSP vs 传统搜索';
      break;
    default:
      return;
  }

  renderMermaidNative(slide, mermaidCode, bounds, mermaidTheme, { title });
}

// ============================================================================
// 幻灯片渲染器
// ============================================================================

/** @deprecated 请使用 slideMasters.ts + layouts.ts */
export function renderTitleSlide(slide: any, title: string, subtitle: string | undefined, theme: ThemeConfig) {
  slide.background = { color: theme.bgColor };

  // 大型渐变圆环（右上角）
  slide.addShape('ellipse', {
    x: 6, y: -1.5, w: 5, h: 5,
    fill: { color: theme.accent, transparency: 95 },
  });
  slide.addShape('ellipse', {
    x: 6.5, y: -1, w: 4, h: 4,
    fill: { color: theme.bgColor },
  });

  // 渐变光晕（左下角）
  slide.addShape('ellipse', {
    x: -2, y: 4, w: 6, h: 6,
    fill: { color: theme.accent, transparency: 97 },
  });

  // 几何装饰线条组
  slide.addShape('rect', {
    x: 8.5, y: 1.2, w: 0.02, h: 2,
    fill: { color: theme.accent, transparency: 60 },
  });
  slide.addShape('rect', {
    x: 9, y: 0.8, w: 0.02, h: 2.8,
    fill: { color: theme.accent, transparency: 40 },
  });
  slide.addShape('rect', {
    x: 9.5, y: 1.5, w: 0.02, h: 1.5,
    fill: { color: theme.accent, transparency: 20 },
  });

  // 小装饰点阵
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      slide.addShape('ellipse', {
        x: 8.2 + i * 0.25, y: 4.5 + j * 0.25, w: 0.06, h: 0.06,
        fill: { color: theme.accent, transparency: 70 - i * 10 },
      });
    }
  }

  // 左侧强调竖条
  slide.addShape('rect', {
    x: 0.4, y: 2, w: 0.12, h: 1.8,
    fill: { color: theme.accent },
  });
  slide.addShape('ellipse', {
    x: 0.38, y: 1.9, w: 0.16, h: 0.16,
    fill: { color: theme.accent },
  });
  slide.addShape('ellipse', {
    x: 0.38, y: 3.74, w: 0.16, h: 0.16,
    fill: { color: theme.accent },
  });

  // 主标题
  slide.addText(title, {
    x: 0.8, y: 1.9, w: 7.5, h: 1.4,
    fontSize: 64, fontFace: theme.fontTitle,
    color: theme.textPrimary, bold: true, valign: 'middle',
  });

  // 标题下方强调线
  slide.addShape('rect', {
    x: 0.8, y: 3.4, w: 3, h: 0.06,
    fill: { color: theme.accent },
  });
  slide.addShape('rect', {
    x: 3.8, y: 3.4, w: 1.5, h: 0.06,
    fill: { color: theme.accent, transparency: 50 },
  });
  slide.addShape('rect', {
    x: 5.3, y: 3.4, w: 1, h: 0.06,
    fill: { color: theme.accent, transparency: 80 },
  });

  // 副标题
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.8, y: 3.65, w: 8, h: 0.6,
      fontSize: 22, fontFace: theme.fontBody,
      color: theme.textSecondary, charSpacing: 2,
    });
  }

  // 底部信息栏
  slide.addShape('rect', {
    x: 0.5, y: 5, w: 9, h: 0.01,
    fill: { color: theme.cardBorder },
  });
  slide.addText('GENERATED BY CODE AGENT', {
    x: 0.5, y: 5.15, w: 4, h: 0.25,
    fontSize: 9, fontFace: theme.fontBody,
    color: theme.textSecondary, charSpacing: 3,
  });
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit' });
  slide.addText(date, {
    x: 7.5, y: 5.15, w: 2, h: 0.25,
    fontSize: 9, fontFace: theme.fontBody,
    color: theme.textSecondary, align: 'right',
  });
}

/** @deprecated 请使用 slideMasters.ts + layouts.ts */
export function renderContentSlide(
  slide: any,
  title: string,
  points: string[],
  theme: ThemeConfig,
  slideIndex: number,
  _layout: string = 'bento'
) {
  slide.background = { color: theme.bgColor };

  // 标题区
  slide.addShape('roundRect', {
    x: 0.4, y: 0.45, w: 0.15, h: 0.6,
    fill: { color: theme.accent },
    rectRadius: 0.03,
  });
  slide.addText(title, {
    x: 0.7, y: 0.35, w: 8, h: 0.8,
    fontSize: 32, fontFace: theme.fontTitle,
    color: theme.textPrimary, bold: true,
  });
  slide.addShape('rect', {
    x: 0.7, y: 1.15, w: 2, h: 0.03,
    fill: { color: theme.accent },
  });
  slide.addShape('rect', {
    x: 2.7, y: 1.15, w: 1, h: 0.03,
    fill: { color: theme.accent, transparency: 60 },
  });

  // 页码
  slide.addShape('roundRect', {
    x: 9.1, y: 0.35, w: 0.55, h: 0.55,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 0.5 },
    rectRadius: 0.08,
  });
  slide.addText(String(slideIndex).padStart(2, '0'), {
    x: 9.1, y: 0.35, w: 0.55, h: 0.55,
    fontSize: 12, fontFace: theme.fontBody,
    color: theme.textSecondary, align: 'center', valign: 'middle',
  });

  // 内容区
  const diagramType = inferDiagramType(title);
  if (diagramType !== 'none') {
    renderContentWithNativeDiagram(slide, title, points, theme, diagramType);
  } else {
    const layoutType = selectLayoutType(title, points);
    switch (layoutType) {
      case 'stats':
        renderStatsLayoutPremium(slide, points, theme);
        break;
      case 'cards-2':
        renderCards2LayoutPremium(slide, points, theme);
        break;
      case 'cards-3':
        renderCards3LayoutPremium(slide, points, theme);
        break;
      case 'highlight':
        renderHighlightLayoutPremium(slide, points, theme);
        break;
      case 'timeline':
        renderTimelineLayoutPremium(slide, points, theme);
        break;
      case 'list':
      default:
        renderListLayoutPremium(slide, points, theme);
        break;
    }
  }
}

/** @deprecated */
export function renderContentWithNativeDiagram(
  slide: any,
  _title: string,
  points: string[],
  theme: ThemeConfig,
  diagramType: DiagramType
) {
  const textWidth = 4.6;
  const displayPoints = points.slice(0, 5);
  const startY = 1.5;
  const lineHeight = 0.72;

  slide.addShape('roundRect', {
    x: 0.35, y: startY, w: textWidth, h: 3.65,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 0.5 },
    rectRadius: 0.15,
  });

  displayPoints.forEach((point, i) => {
    const y = startY + 0.2 + i * lineHeight;
    const isFirst = i === 0;
    if (isFirst) {
      slide.addShape('rect', {
        x: 0.35, y, w: 0.06, h: lineHeight - 0.08,
        fill: { color: theme.accent },
      });
    }
    slide.addText(String(i + 1), {
      x: 0.55, y: y + 0.12, w: 0.35, h: 0.35,
      fontSize: 10, fontFace: theme.fontTitle,
      color: isFirst ? theme.accent : theme.textSecondary, bold: true,
    });
    slide.addText(point, {
      x: 1, y, w: textWidth - 0.8, h: lineHeight,
      fontSize: 11, fontFace: theme.fontBody,
      color: isFirst ? theme.textPrimary : theme.textSecondary, valign: 'middle',
    });
  });

  drawDiagram(slide, diagramType, 5.1, 1.5, 4.55, 3.65, theme);
}

/** @deprecated */
export function renderContentSlideWithImages(
  slide: any,
  title: string,
  points: string[],
  theme: ThemeConfig,
  slideIndex: number,
  images: Array<{ path: string; position?: string }>
) {
  slide.background = { color: theme.bgColor };

  slide.addShape('rect', {
    x: 0.4, y: 0.5, w: 0.08, h: 0.5,
    fill: { color: theme.accent },
  });
  slide.addText(title, {
    x: 0.6, y: 0.35, w: 8, h: 0.8,
    fontSize: 28, fontFace: theme.fontTitle,
    color: theme.textPrimary, bold: true,
  });
  slide.addShape('rect', {
    x: 0.6, y: 1.05, w: 1.5, h: 0.03,
    fill: { color: theme.accent },
  });
  slide.addText(String(slideIndex).padStart(2, '0'), {
    x: 9.2, y: 0.4, w: 0.5, h: 0.4,
    fontSize: 12, color: theme.textSecondary, align: 'right',
  });

  const textWidth = 4.5;
  const displayPoints = points.slice(0, 5);
  const startY = 1.4;
  const lineHeight = 0.65;

  displayPoints.forEach((point, i) => {
    const y = startY + i * lineHeight;
    slide.addText(`0${i + 1}`, {
      x: 0.5, y, w: 0.4, h: lineHeight,
      fontSize: 12, color: i === 0 ? theme.accent : theme.textSecondary, bold: true, valign: 'middle',
    });
    slide.addText(point, {
      x: 1.0, y, w: textWidth - 0.6, h: lineHeight,
      fontSize: 12, color: i === 0 ? theme.textPrimary : theme.textSecondary, valign: 'middle',
    });
  });

  const imgX = 5.0;
  const imgY = 1.3;
  const imgW = 4.6;
  const imgH = 3.8;

  const displayImages = images.slice(0, 1);
  displayImages.forEach((img) => {
    try {
      slide.addShape('roundRect', {
        x: imgX - 0.1,
        y: imgY - 0.1,
        w: imgW + 0.2,
        h: imgH + 0.2,
        fill: { color: theme.bgSecondary },
        line: { color: theme.cardBorder, width: 0.5 },
        rectRadius: 0.1,
      });
      slide.addImage({
        path: img.path,
        x: imgX,
        y: imgY,
        w: imgW,
        h: imgH,
        sizing: { type: 'contain', w: imgW, h: imgH },
      });
    } catch {
      slide.addText('[图片加载失败]', {
        x: imgX, y: imgY + imgH / 2 - 0.2, w: imgW, h: 0.4,
        fontSize: 14, color: theme.textSecondary, align: 'center',
      });
    }
  });
}

/** @deprecated 请使用 slideMasters.ts + layouts.ts */
export function renderEndSlide(slide: any, title: string, theme: ThemeConfig) {
  slide.background = { color: theme.bgColor };

  // 大型渐变圆环
  slide.addShape('ellipse', {
    x: 4.5, y: 1, w: 6, h: 6,
    fill: { color: theme.accent, transparency: 96 },
  });
  slide.addShape('ellipse', {
    x: 5, y: 1.5, w: 5, h: 5,
    fill: { color: theme.bgColor },
  });

  // 装饰线条组
  slide.addShape('rect', {
    x: 7.5, y: 0.5, w: 2, h: 0.015,
    fill: { color: theme.cardBorder },
  });
  slide.addShape('rect', {
    x: 8, y: 0.7, w: 1.5, h: 0.015,
    fill: { color: theme.cardBorder, transparency: 50 },
  });

  // 几何装饰
  slide.addShape('roundRect', {
    x: 0.3, y: 4.5, w: 1.2, h: 1.2,
    fill: { color: theme.accent, transparency: 95 },
    rectRadius: 0.15,
  });
  slide.addShape('roundRect', {
    x: 0.5, y: 4.7, w: 0.8, h: 0.8,
    fill: { color: theme.accent, transparency: 90 },
    rectRadius: 0.1,
  });

  // 点阵装饰
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 3; j++) {
      slide.addShape('ellipse', {
        x: 8 + i * 0.25, y: 1.2 + j * 0.25,
        w: 0.05, h: 0.05,
        fill: { color: theme.accent, transparency: 60 + i * 5 },
      });
    }
  }

  // 主内容卡片
  slide.addShape('roundRect', {
    x: 1.5, y: 1.8, w: 7, h: 2.6,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 0.5 },
    rectRadius: 0.2,
  });
  slide.addShape('rect', {
    x: 4, y: 1.8, w: 2, h: 0.06,
    fill: { color: theme.accent },
  });
  slide.addText(title, {
    x: 1.5, y: 2.2, w: 7, h: 1,
    fontSize: 48, fontFace: theme.fontTitle,
    color: theme.textPrimary, bold: true, align: 'center',
  });
  slide.addShape('rect', {
    x: 3.5, y: 3.3, w: 3, h: 0.03,
    fill: { color: theme.accent },
  });
  slide.addShape('rect', {
    x: 3, y: 3.3, w: 0.4, h: 0.03,
    fill: { color: theme.accent, transparency: 50 },
  });
  slide.addShape('rect', {
    x: 6.6, y: 3.3, w: 0.4, h: 0.03,
    fill: { color: theme.accent, transparency: 50 },
  });
  slide.addText('THANK YOU FOR YOUR ATTENTION', {
    x: 1.5, y: 3.6, w: 7, h: 0.4,
    fontSize: 12, fontFace: theme.fontBody,
    color: theme.textSecondary, charSpacing: 4, align: 'center',
  });

  // 底部信息栏
  slide.addShape('rect', {
    x: 0.5, y: 5, w: 9, h: 0.01,
    fill: { color: theme.cardBorder },
  });
  slide.addText('POWERED BY CODE AGENT', {
    x: 0.5, y: 5.15, w: 4, h: 0.25,
    fontSize: 9, fontFace: theme.fontBody,
    color: theme.textSecondary, charSpacing: 2,
  });
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit' });
  slide.addText(date, {
    x: 7.5, y: 5.15, w: 2, h: 0.25,
    fontSize: 9, fontFace: theme.fontBody,
    color: theme.textSecondary, align: 'right',
  });
}

// ============================================================================
// Legacy 主入口：渲染完整 PPT（不使用 Slide Master）
// ============================================================================

/** @deprecated 请使用 ppt/index.ts 中的 use_masters: true 路径 */
export function renderLegacySlides(
  pptx: any,
  slides: Array<{ title: string; subtitle?: string; points: string[]; isTitle?: boolean; isEnd?: boolean }>,
  themeConfig: ThemeConfig,
  slideImages: SlideImage[]
) {
  resetLayoutRotation();

  for (let i = 0; i < slides.length; i++) {
    const slideData = slides[i];
    const slide = pptx.addSlide();

    if (slideData.isTitle) {
      renderTitleSlide(slide, slideData.title, slideData.subtitle, themeConfig);
    } else if (slideData.isEnd) {
      renderEndSlide(slide, slideData.title, themeConfig);
    } else {
      const currentSlideImages = slideImages?.filter(
        img => img.slide_index === i && fs.existsSync(img.image_path)
      ) || [];

      if (currentSlideImages.length > 0) {
        const validImages = currentSlideImages.map(img => ({ path: img.image_path, position: img.position }));
        renderContentSlideWithImages(slide, slideData.title, slideData.points, themeConfig, i, validImages);
      } else {
        renderContentSlide(slide, slideData.title, slideData.points, themeConfig, i);
      }
    }
  }
}
