// ============================================================================
// PPT 布局选择与内容填充
// ============================================================================

import * as fs from 'fs';
import type { ThemeConfig, LayoutType, SlideData, SlideImage, ChartSlotData, ChartMode } from './types';
import { isAppleDark } from './themes';
import { MASTER } from './slideMasters';
import { detectChartData, renderNativeChart } from './charts';
import { selectFont, normalizeCJKSpacing, calculateFitFontSize, isCJKDominant } from './typography';
import { getSpacingConfig } from './spacing';
import { getTemplateForTheme } from './layoutTemplates';
import type { LayoutTemplate } from './layoutTemplates';
import type {
  StructuredSlide, StatsContent, Cards2Content, Cards3Content,
  ListContent, TimelineContent, ComparisonContent, QuoteContent,
  ChartContent, TwoColumnContent, HighlightContent,
} from './slideSchemas';

// 布局历史记录（用于节奏控制）
let layoutHistory: LayoutType[] = [];

// ============================================================================
// 自适应辅助函数
// ============================================================================

/**
 * 根据文本长度和 CJK 比例自适应字号
 * CJK 字符宽度约为 Latin 1.7 倍，长文本自动减小字号
 */
function adaptiveFontSize(text: string, baseFontSize: number, _containerW?: number): number {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const effectiveLen = text.length + cjkCount * 0.7; // CJK 等效加权长度

  let fontSize = baseFontSize;
  if (effectiveLen > 80) {
    fontSize -= 2;
  } else if (effectiveLen > 50) {
    fontSize -= 1;
  }

  return Math.max(10, fontSize);
}

export function resetLayoutRotation(): void {
  layoutHistory = [];
}

// ============================================================================
// 内容类型检测
// ============================================================================

function detectContentType(title: string, points: string[]): {
  hasNumbers: boolean;
  isProcess: boolean;
  isComparison: boolean;
  isKeyPoint: boolean;
  isTechnical: boolean;
  isQuote: boolean;
} {
  const allText = [title, ...points].join(' ').toLowerCase();

  return {
    // 至少 3 个要点含数字才视为数据型内容（适合 stats 布局）
    hasNumbers: points.filter(p => /\d+[\d.,]*[%万亿KMB]?/i.test(p)).length >= 3,
    // 流程/步骤只看标题，避免要点中"开发流程""工作流程"等复合词误触发
    isProcess: /流程|步骤|阶段|step|phase|stage/i.test(title),
    isComparison: /对比|比较|vs|区别|优势|劣势|特点/i.test(allText),
    isKeyPoint: /核心|关键|重点|最重要|价值|意义/i.test(title),
    isTechnical: /架构|技术|实现|原理|算法|系统|模块/i.test(title),
    isQuote: /引言|语录|名言|格言|quote|saying/i.test(title) && points.length <= 2,
  };
}

/**
 * 检查布局是否违反节奏规则
 * - 禁止连续 3+ 同一布局
 * - 禁止连续 2 个 stats 布局
 */
function wouldViolateRhythm(candidate: LayoutType): boolean {
  const len = layoutHistory.length;
  if (len === 0) return false;

  // 禁止连续 2 个 stats
  if (candidate === 'stats' && len >= 1 && layoutHistory[len - 1] === 'stats') {
    return true;
  }

  // 禁止连续 3+ 同一布局
  if (len >= 2 && layoutHistory[len - 1] === candidate && layoutHistory[len - 2] === candidate) {
    return true;
  }

  // 禁止最近 5 页中同一布局出现 2+ 次（提升布局多样性）
  const recent = layoutHistory.slice(-5);
  if (recent.filter(l => l === candidate).length >= 2) {
    return true;
  }

  return false;
}

// ============================================================================
// Master + 布局选择
// ============================================================================

interface MasterSelection {
  master: string;
  layout: LayoutType;
  chartData: ChartSlotData | null;
}

/**
 * 根据幻灯片内容选择 Master 和布局
 */
export function selectMasterAndLayout(
  slideData: SlideData,
  hasImages: boolean,
  chartMode: ChartMode
): MasterSelection {
  // Title / End 页
  if (slideData.isTitle) {
    return { master: MASTER.TITLE, layout: 'highlight', chartData: null };
  }
  if (slideData.isEnd) {
    return { master: MASTER.END, layout: 'highlight', chartData: null };
  }

  // 有图片 → IMAGE master
  if (hasImages) {
    return { master: MASTER.CONTENT_IMAGE, layout: 'list', chartData: null };
  }

  // 图表自动检测
  if (chartMode === 'auto') {
    const chartData = detectChartData(slideData.title, slideData.points);
    if (chartData) {
      return { master: MASTER.CONTENT_CHART, layout: 'chart', chartData };
    }
  }

  // 选择内容布局
  const layout = selectLayoutFromContent(slideData.title, slideData.points);
  layoutHistory.push(layout);

  // 新布局路由：quote → QUOTE master
  if (layout === 'quote') {
    return { master: MASTER.QUOTE, layout, chartData: null };
  }

  // comparison → COMPARISON master
  if (layout === 'comparison') {
    return { master: MASTER.COMPARISON, layout, chartData: null };
  }

  // two-column → TWO_COL master
  if (layout === 'two-column') {
    return { master: MASTER.TWO_COL, layout, chartData: null };
  }

  // 简单布局（list/highlight）→ CONTENT_LIST master（有 body placeholder）
  if (layout === 'list' || layout === 'highlight') {
    return { master: MASTER.CONTENT_LIST, layout, chartData: null };
  }

  // 复杂布局（stats/cards-2/cards-3/timeline）→ HERO_NUMBER master
  // 这些布局用坐标填充内容，不需要 body placeholder
  return { master: MASTER.HERO_NUMBER, layout, chartData: null };
}

/**
 * 根据内容逻辑选择布局类型
 */
function selectLayoutFromContent(title: string, points: string[]): LayoutType {
  const content = detectContentType(title, points);
  const pointCount = points.length;

  // 引言页：关键词触发 + ≤2 要点
  if (content.isQuote) return applyRhythm('quote');

  if (content.isTechnical) return applyRhythm('cards-2');
  if (content.isProcess && pointCount >= 3) return applyRhythm('timeline');
  if (content.isKeyPoint && pointCount <= 4) return applyRhythm('highlight');

  // 对比页：comparison 布局（偶数个要点效果最佳）
  if (content.isComparison && pointCount >= 4 && pointCount % 2 === 0) return applyRhythm('comparison');
  if (content.isComparison && pointCount >= 3) return applyRhythm('cards-2');

  if (content.hasNumbers && pointCount >= 3 && pointCount <= 5) return applyRhythm('stats');
  if (pointCount === 3) return applyRhythm('cards-3');

  // 6+ 要点 → 双列布局
  if (pointCount >= 6) return applyRhythm('two-column');

  if (pointCount >= 4) {
    const layouts: LayoutType[] = ['list', 'two-column', 'cards-2'];
    for (const layout of layouts) {
      if (!wouldViolateRhythm(layout)) return layout;
    }
    return 'list';
  }

  if (pointCount <= 2) return applyRhythm('highlight');
  return applyRhythm('list');
}

/**
 * 应用节奏规则：如果候选布局违反节奏，回退到 list
 */
function applyRhythm(candidate: LayoutType): LayoutType {
  if (wouldViolateRhythm(candidate)) {
    return candidate === 'list' ? 'cards-2' : 'list';
  }
  return candidate;
}

// ============================================================================
// 内容填充
// ============================================================================

/**
 * 填充幻灯片内容（使用 placeholder 绑定或坐标填充）
 */
export function fillSlide(
  pptx: any,
  slide: any,
  slideData: SlideData,
  theme: ThemeConfig,
  layout: LayoutType,
  slideIndex: number,
  chartData: ChartSlotData | null,
  images: SlideImage[]
): void {
  const apple = isAppleDark(theme);

  // ===== Title 页 =====
  if (slideData.isTitle) {
    slide.addText(slideData.title, { placeholder: 'slideTitle' });
    const sub = slideData.subtitle || slideData.points?.[0] || '';
    slide.addText(sub, { placeholder: 'body' });
    return;
  }

  // ===== End 页 =====
  if (slideData.isEnd) {
    slide.addText(slideData.title, { placeholder: 'slideTitle' });
    return;
  }

  // ===== 页码（非 title/end 通用）=====
  addPageNumber(slide, slideIndex, theme, apple);

  // ===== Chart 页 =====
  if (layout === 'chart' && chartData) {
    // 左侧要点 → placeholder body
    const bulletText = slideData.points.map(p => `  ${p}`).join('\n');
    slide.addText(slideData.title, { placeholder: 'slideTitle' });
    slide.addText(bulletText, { placeholder: 'body' });
    // 右侧图表
    renderNativeChart(pptx, slide, chartData, theme, { x: 5.1, y: 1.55, w: 4.3, h: 3.6 });
    return;
  }

  // ===== Image 页 =====
  if (images.length > 0) {
    slide.addText(slideData.title, { placeholder: 'slideTitle' });
    const bulletText = slideData.points.map(p => `  ${p}`).join('\n');
    slide.addText(bulletText, { placeholder: 'body' });
    // 右侧图片
    addSlideImages(slide, images, theme);
    return;
  }

  // ===== Quote 页 =====
  if (layout === 'quote') {
    const quoteText = normalizeCJKSpacing(slideData.points[0] || slideData.title);
    const font = selectFont(quoteText, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN, false);
    slide.addText(quoteText, { placeholder: 'slideTitle' });
    if (slideData.points.length > 1) {
      slide.addText(normalizeCJKSpacing(slideData.points[1]), { placeholder: 'body' });
    }
    return;
  }

  // ===== Comparison 页 =====
  if (layout === 'comparison') {
    slide.addText(normalizeCJKSpacing(slideData.title), { placeholder: 'slideTitle' });
    fillComparisonLayout(slide, slideData.points, theme, apple);
    return;
  }

  // ===== Two-column 页 =====
  if (layout === 'two-column') {
    slide.addText(normalizeCJKSpacing(slideData.title), { placeholder: 'slideTitle' });
    fillTwoColumnLayout(slide, slideData.points, theme, apple);
    return;
  }

  // ===== 简单布局：list / highlight → placeholder =====
  if (layout === 'list' || layout === 'highlight') {
    slide.addText(normalizeCJKSpacing(slideData.title), { placeholder: 'slideTitle' });
    const bulletText = slideData.points.map(p => `  ${normalizeCJKSpacing(p)}`).join('\n');
    slide.addText(bulletText, { placeholder: 'body' });
    return;
  }

  // ===== 复杂布局：stats / cards / timeline → 标题用 placeholder + 内容用坐标 =====
  slide.addText(normalizeCJKSpacing(slideData.title), { placeholder: 'slideTitle' });

  switch (layout) {
    case 'stats':
      fillStatsLayout(slide, slideData.points, theme, apple);
      break;
    case 'cards-2':
      fillCards2Layout(slide, slideData.points, theme, apple);
      break;
    case 'cards-3':
      fillCards3Layout(slide, slideData.points, theme, apple);
      break;
    case 'timeline':
      fillTimelineLayout(slide, slideData.points, theme, apple);
      break;
    default: {
      // fallback: 坐标定位（HERO_NUMBER 无 body placeholder）
      const text = slideData.points.map(p => `  ${normalizeCJKSpacing(p)}`).join('\n');
      slide.addText(text, {
        x: 0.5, y: 1.5, w: 9, h: 3.5,
        fontSize: 14, fontFace: theme.fontBody,
        color: theme.textSecondary, valign: 'top',
      });
      break;
    }
  }
}

// ============================================================================
// 内容填充函数（仅填充内容，骨架在 master 中）
// ============================================================================

function addPageNumber(slide: any, index: number, theme: ThemeConfig, apple: boolean, tpl?: LayoutTemplate) {
  const t = tpl?.pageNumber ?? getTemplateForTheme(apple ? 'apple-dark' : 'default').pageNumber;
  if (apple) {
    slide.addText(String(index).padStart(2, '0'), {
      x: t.x, y: t.y, w: t.w, h: t.h,
      fontSize: t.fontSize, fontFace: theme.fontBody,
      color: theme.textSecondary, align: 'right',
    });
  } else {
    slide.addShape('roundRect', {
      x: t.x, y: t.y, w: t.w, h: t.h,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 0.5 },
      rectRadius: t.badgeRadius,
    });
    slide.addText(String(index).padStart(2, '0'), {
      x: t.x, y: t.y, w: t.w, h: t.h,
      fontSize: t.fontSize, fontFace: theme.fontBody,
      color: theme.textSecondary, align: 'center', valign: 'middle',
    });
  }
}

function fillStatsLayout(slide: any, points: string[], theme: ThemeConfig, apple: boolean, tpl?: LayoutTemplate) {
  const t = tpl?.stats ?? getTemplateForTheme(apple ? 'apple-dark' : 'default').stats;
  // 只选取包含可提取数字的要点
  const withNumbers = points.filter(p => /\d+[\d.,]*[%万亿KMB]?/i.test(p));
  const stats = (withNumbers.length >= 3 ? withNumbers : points).slice(0, 4);
  const startX = (10 - (stats.length * t.cardWidth + (stats.length - 1) * t.gap)) / 2;

  stats.forEach((point, i) => {
    const x = startX + i * (t.cardWidth + t.gap);
    const numMatch = point.match(/(\d+[\d.,]*[%万亿KMB+]?)\s*(分钟|小时|天|周|个月|年|倍|人|位|个|项|款|种|次)?/i);
    const numText = numMatch ? (numMatch[1] + (numMatch[2] || '')) : String(i + 1);
    const descText = point.replace(/[，,：:；;]/g, ' ').trim();

    slide.addShape('roundRect', {
      x, y: t.startY, w: t.cardWidth, h: t.cardHeight,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
      rectRadius: t.cardRadius,
    });

    slide.addText(numText, {
      x, y: t.startY + t.numberYOffset, w: t.cardWidth, h: t.numberHeight,
      fontSize: t.numberFontSize, fontFace: theme.fontTitle,
      color: theme.accent, bold: true, align: 'center', valign: 'middle',
      shrinkText: true,
    });

    slide.addShape('rect', {
      x: x + 0.4, y: t.startY + t.dividerYOffset, w: t.cardWidth - 0.8, h: 0.01,
      fill: { color: theme.cardBorder, transparency: apple ? 30 : 0 },
    });

    slide.addText(normalizeCJKSpacing(descText), {
      x: x + 0.2, y: t.startY + t.descYOffset, w: t.cardWidth - 0.4, h: t.cardHeight - t.descYOffset - 0.2,
      fontSize: t.descFontSize, fontFace: selectFont(descText, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, align: 'center', valign: 'top',
      shrinkText: true,
    });
  });
}

function fillCards2Layout(slide: any, points: string[], theme: ThemeConfig, apple: boolean, tpl?: LayoutTemplate) {
  const t = tpl?.cards2 ?? getTemplateForTheme(apple ? 'apple-dark' : 'default').cards2;
  const leftPoints = points.slice(0, Math.ceil(points.length / 2));
  const rightPoints = points.slice(Math.ceil(points.length / 2));

  // ===== 左侧主卡片 =====
  slide.addShape('roundRect', {
    x: t.leftX, y: t.cardY, w: t.leftW, h: t.cardH,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
    rectRadius: t.cardRadius,
  });

  const leftContentH = t.cardH - t.padding * 2;
  const leftRowH = Math.min(t.maxRowH, leftContentH / Math.max(leftPoints.length, 1));

  leftPoints.forEach((point, i) => {
    slide.addText(normalizeCJKSpacing(point), {
      x: t.leftX + t.padding, y: t.cardY + t.padding + i * leftRowH, w: t.leftW - t.padding * 2, h: leftRowH,
      fontSize: t.titleFontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: i === 0 ? theme.textPrimary : theme.textSecondary,
      valign: 'middle',
    });
    if (i < leftPoints.length - 1) {
      slide.addShape('rect', {
        x: t.leftX + t.padding, y: t.cardY + t.padding + (i + 1) * leftRowH - 0.02, w: t.leftW - t.padding * 2 - 0.5, h: 0.005,
        fill: { color: theme.cardBorder, transparency: 50 },
      });
    }
  });

  // ===== 右侧卡片列表 =====
  const rightCardH = Math.min(t.rightMaxCardH, (t.cardH - t.rightGap * (rightPoints.length - 1)) / Math.max(rightPoints.length, 1));

  rightPoints.forEach((point, i) => {
    const x = t.rightX;
    const y = t.cardY + i * (rightCardH + t.rightGap);

    slide.addShape('roundRect', {
      x, y, w: t.rightW, h: rightCardH,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
      rectRadius: t.cardRadius,
    });

    slide.addText(normalizeCJKSpacing(point), {
      x: x + t.padding, y: y + 0.1, w: t.rightW - t.padding * 2, h: rightCardH - 0.2,
      fontSize: t.bodyFontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, valign: 'middle',
    });
  });
}

function fillCards3Layout(slide: any, points: string[], theme: ThemeConfig, apple: boolean, tpl?: LayoutTemplate) {
  const t = tpl?.cards3 ?? getTemplateForTheme(apple ? 'apple-dark' : 'default').cards3;
  const displayPoints = points.slice(0, 3);

  displayPoints.forEach((point, i) => {
    const x = t.startX + i * (t.cardWidth + t.gap);
    const isCenter = i === 1;
    const yOffset = isCenter ? t.centerYOffset : 0;
    const heightBonus = isCenter ? t.centerHBonus : 0;
    const cardY = t.baseY + yOffset;
    const cardH = t.baseH + heightBonus;

    slide.addShape('roundRect', {
      x, y: cardY, w: t.cardWidth, h: cardH,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
      rectRadius: t.cardRadius,
    });

    slide.addText(String(i + 1), {
      x: x + t.cardWidth / 2 - 0.35, y: cardY + 0.3, w: 0.7, h: 0.7,
      fontSize: t.numberFontSize, fontFace: theme.fontTitle,
      color: theme.accent,
      bold: true, align: 'center', valign: 'middle',
    });

    slide.addShape('rect', {
      x: x + 0.5, y: cardY + 1.2, w: t.cardWidth - 1, h: 0.01,
      fill: { color: theme.cardBorder, transparency: apple ? 30 : 0 },
    });

    slide.addText(normalizeCJKSpacing(point), {
      x: x + 0.3, y: cardY + 1.4, w: t.cardWidth - 0.6, h: cardH - 1.7,
      fontSize: t.bodyFontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, valign: 'top', align: 'center',
    });
  });
}

function fillTimelineLayout(slide: any, points: string[], theme: ThemeConfig, apple: boolean, tpl?: LayoutTemplate) {
  const t = tpl?.timeline ?? getTemplateForTheme(apple ? 'apple-dark' : 'default').timeline;
  const displayPoints = points.slice(0, 4);
  const n = displayPoints.length;

  // 动态居中
  const stepW = Math.min(2.6, (10 - 1.2) / n);
  const totalW = stepW * n;
  const sx = (10 - totalW) / 2;
  const lineY = t.baseY;
  const halfDot = t.dotSize / 2;

  // 连接线
  if (n > 1) {
    const firstCx = sx + stepW / 2;
    const lastCx = sx + (n - 1) * stepW + stepW / 2;
    slide.addShape('rect', {
      x: firstCx, y: lineY + halfDot - t.lineHeight / 2,
      w: lastCx - firstCx, h: t.lineHeight,
      fill: { color: theme.accent, transparency: 60 },
    });
  }

  displayPoints.forEach((point, i) => {
    const cx = sx + i * stepW + stepW / 2;
    const colX = sx + i * stepW;

    // 圆点
    slide.addShape('ellipse', {
      x: cx - halfDot, y: lineY, w: t.dotSize, h: t.dotSize,
      fill: { color: theme.accent },
    });
    slide.addText(`${i + 1}`, {
      x: cx - halfDot, y: lineY, w: t.dotSize, h: t.dotSize,
      fontSize: 9, fontFace: theme.fontTitle,
      color: theme.bgColor, bold: true, align: 'center', valign: 'middle',
    });

    // STEP 标签（线上方）
    slide.addText(`STEP ${i + 1}`, {
      x: colX, y: lineY + t.labelYOffset, w: stepW, h: 0.35,
      fontSize: t.labelFontSize, fontFace: theme.fontTitle,
      color: theme.accent, bold: true, align: 'center', charSpacing: 2,
      shrinkText: true,
    });

    // 内容（线下方）
    slide.addText(normalizeCJKSpacing(point), {
      x: colX + 0.2, y: lineY + t.dotSize + t.contentYOffset, w: stepW - 0.4, h: t.contentHeight,
      fontSize: t.contentFontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, align: 'center', valign: 'top',
      shrinkText: true,
    });
  });
}

function fillComparisonLayout(slide: any, points: string[], theme: ThemeConfig, apple: boolean, tpl?: LayoutTemplate) {
  const t = tpl?.comparison ?? getTemplateForTheme(apple ? 'apple-dark' : 'default').comparison;
  const half = Math.ceil(points.length / 2);
  const leftPoints = points.slice(0, half);
  const rightPoints = points.slice(half);
  const rowH = Math.min(t.maxRowH, (t.cardH - 0.5) / Math.max(half, 1));

  // 左侧卡片
  slide.addShape('roundRect', {
    x: t.leftX, y: t.cardY, w: t.leftW, h: t.cardH,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
    rectRadius: t.cardRadius,
  });

  leftPoints.forEach((point, i) => {
    slide.addText(normalizeCJKSpacing(point), {
      x: t.leftX + 0.3, y: t.contentStartY + i * rowH, w: t.leftW - 0.6, h: rowH,
      fontSize: t.fontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: i === 0 ? theme.textPrimary : theme.textSecondary,
      valign: 'middle', shrinkText: true,
    });
  });

  // 右侧卡片
  slide.addShape('roundRect', {
    x: t.rightX, y: t.cardY, w: t.rightW, h: t.cardH,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
    rectRadius: t.cardRadius,
  });

  rightPoints.forEach((point, i) => {
    slide.addText(normalizeCJKSpacing(point), {
      x: t.rightX + 0.3, y: t.contentStartY + i * rowH, w: t.rightW - 0.6, h: rowH,
      fontSize: t.fontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: i === 0 ? theme.textPrimary : theme.textSecondary,
      valign: 'middle', shrinkText: true,
    });
  });
}

function fillTwoColumnLayout(slide: any, points: string[], theme: ThemeConfig, apple: boolean, tpl?: LayoutTemplate) {
  const t = tpl?.twoColumn ?? getTemplateForTheme(apple ? 'apple-dark' : 'default').twoColumn;
  const half = Math.ceil(points.length / 2);
  const leftPoints = points.slice(0, half);
  const rightPoints = points.slice(half);
  const rowH = Math.min(t.maxRowH, 3.4 / Math.max(half, 1));

  // 中间分隔线
  slide.addShape('rect', {
    x: t.dividerX, y: t.contentStartY + 0.05, w: t.dividerW, h: half * rowH - 0.2,
    fill: { color: theme.cardBorder, transparency: apple ? 40 : 0 },
  });

  // 左列
  leftPoints.forEach((point, i) => {
    const y = t.contentStartY + i * rowH;
    slide.addShape('ellipse', {
      x: t.leftDotX, y: y + 0.18, w: t.dotSize, h: t.dotSize,
      fill: { color: theme.accent },
    });
    slide.addText(normalizeCJKSpacing(point), {
      x: t.leftTextX, y, w: t.leftTextW, h: rowH,
      fontSize: t.fontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, valign: 'middle',
    });
  });

  // 右列
  rightPoints.forEach((point, i) => {
    const y = t.contentStartY + i * rowH;
    slide.addShape('ellipse', {
      x: t.rightDotX, y: y + 0.18, w: t.dotSize, h: t.dotSize,
      fill: { color: theme.accent },
    });
    slide.addText(normalizeCJKSpacing(point), {
      x: t.rightTextX, y, w: t.rightTextW, h: rowH,
      fontSize: t.fontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, valign: 'middle',
    });
  });
}

function addSlideImages(
  slide: any,
  images: SlideImage[],
  theme: ThemeConfig,
  tpl?: LayoutTemplate
) {
  const t = tpl?.image ?? getTemplateForTheme('default').image;

  const displayImages = images.slice(0, 1);
  displayImages.forEach((img) => {
    try {
      if (!fs.existsSync(img.image_path)) return;
      slide.addImage({
        path: img.image_path,
        x: t.x, y: t.y, w: t.w, h: t.h,
        sizing: { type: 'contain', w: t.w, h: t.h },
      });
    } catch {
      slide.addText('[图片加载失败]', {
        x: t.x, y: t.y + t.h / 2 - 0.2, w: t.w, h: 0.4,
        fontSize: 14, color: theme.textSecondary, align: 'center',
      });
    }
  });
}

// ============================================================================
// 结构化 Slide 渲染管线（Phase 1: 新通道）
// ============================================================================

/**
 * 填充结构化 Slide 内容
 * 根据 StructuredSlide.layout 分发到对应的 fill*FromSchema() 渲染器
 */
export function fillStructuredSlide(
  pptx: any,
  slide: any,
  data: StructuredSlide,
  theme: ThemeConfig,
  slideIndex: number,
  chartData: ChartSlotData | null,
  images: SlideImage[]
): void {
  const apple = isAppleDark(theme);
  const tpl = getTemplateForTheme(theme.name);

  // Title / End 页
  if (data.isTitle) {
    slide.addText(data.title, { placeholder: 'slideTitle' });
    // 副标题：优先 subtitle，fallback 到 points[0]，否则用空字符串清除 placeholder
    const sub = data.subtitle || (data.content as any)?.points?.[0] || '';
    slide.addText(sub, { placeholder: 'body' });
    return;
  }
  if (data.isEnd) {
    slide.addText(data.title, { placeholder: 'slideTitle' });
    return;
  }

  // 页码
  addPageNumber(slide, slideIndex, theme, apple, tpl);

  // 标题（所有内容页共用 — quote 由 fillQuoteFromSchema 自行处理，避免 placeholder 重复）
  if (data.layout !== 'quote') {
    slide.addText(normalizeCJKSpacing(data.title), { placeholder: 'slideTitle' });
  }

  // Image 页
  if (images.length > 0) {
    const points = extractPointsFromContent(data);
    const bulletText = points.map(p => `  ${normalizeCJKSpacing(p)}`).join('\n');
    slide.addText(bulletText, { placeholder: 'body' });
    addSlideImages(slide, images, theme, tpl);
    return;
  }

  // 根据 layout 分发
  switch (data.layout) {
    case 'stats':
      fillStatsFromSchema(slide, data.content as StatsContent, theme, apple, tpl);
      break;
    case 'cards-2':
      fillCards2FromSchema(slide, data.content as Cards2Content, theme, apple, tpl);
      break;
    case 'cards-3':
      fillCards3FromSchema(slide, data.content as Cards3Content, theme, apple, tpl);
      break;
    case 'list':
    case 'highlight':
      fillListFromSchema(slide, data.content as ListContent | HighlightContent, theme);
      break;
    case 'timeline':
      fillTimelineFromSchema(slide, data.content as TimelineContent, theme, apple, tpl);
      break;
    case 'comparison':
      fillComparisonFromSchema(slide, data.content as ComparisonContent, theme, apple, tpl);
      break;
    case 'quote':
      fillQuoteFromSchema(slide, data.content as QuoteContent, theme);
      break;
    case 'chart':
      fillChartFromSchema(pptx, slide, data.content as ChartContent, theme, chartData);
      break;
    case 'two-column':
      fillTwoColumnFromSchema(slide, data.content as TwoColumnContent, theme, apple, tpl);
      break;
    default: {
      // fallback: 尝试提取 points 并用 body placeholder
      const fallbackPoints = extractPointsFromContent(data);
      const text = fallbackPoints.map(p => `  ${normalizeCJKSpacing(p)}`).join('\n');
      slide.addText(text, {
        x: 0.5, y: 1.5, w: 9, h: 3.5,
        fontSize: 14, fontFace: theme.fontBody,
        color: theme.textSecondary, valign: 'top',
      });
    }
  }
}

/**
 * 从 StructuredSlide content 中提取 points（用于 fallback 和通用处理）
 */
function extractPointsFromContent(data: StructuredSlide): string[] {
  const c = data.content as any;
  if (c.points) return c.points;
  if (c.stats) return c.stats.map((s: any) => `${s.value} ${s.label}${s.description ? ' - ' + s.description : ''}`);
  if (c.steps) return c.steps.map((s: any) => `${s.title}: ${s.description}`);
  if (c.cards) return c.cards.map((card: any) => `${card.title}: ${card.description}`);
  if (c.left && c.right) return [...c.left.points, ...c.right.points];
  if (c.quote) return [c.quote, c.attribution].filter(Boolean);
  return [];
}

// ============================================================================
// Per-Layout Schema Renderers
// ============================================================================

function fillStatsFromSchema(slide: any, content: StatsContent, theme: ThemeConfig, apple: boolean, tpl: LayoutTemplate) {
  const t = tpl.stats;
  const stats = content.stats.slice(0, 4);
  const startX = (10 - (stats.length * t.cardWidth + (stats.length - 1) * t.gap)) / 2;

  // 自适应：少量 stat 减少卡片高度避免过多空白
  const cardH = stats.length <= 2 ? t.cardHeight * 0.85 : t.cardHeight;

  stats.forEach((stat, i) => {
    const x = startX + i * (t.cardWidth + t.gap);

    slide.addShape('roundRect', {
      x, y: t.startY, w: t.cardWidth, h: cardH,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
      rectRadius: t.cardRadius,
    });

    slide.addText(stat.value, {
      x, y: t.startY + t.numberYOffset, w: t.cardWidth, h: t.numberHeight,
      fontSize: t.numberFontSize, fontFace: theme.fontTitle,
      color: theme.accent, bold: true, align: 'center', valign: 'middle',
      shrinkText: true,
    });

    slide.addShape('rect', {
      x: x + 0.4, y: t.startY + t.dividerYOffset, w: t.cardWidth - 0.8, h: 0.01,
      fill: { color: theme.cardBorder, transparency: apple ? 30 : 0 },
    });

    const descText = stat.description ? `${stat.label}\n${stat.description}` : stat.label;
    const descFontSize = adaptiveFontSize(descText, t.descFontSize);
    slide.addText(normalizeCJKSpacing(descText), {
      x: x + 0.2, y: t.startY + t.descYOffset, w: t.cardWidth - 0.4, h: cardH - t.descYOffset - 0.2,
      fontSize: descFontSize, fontFace: selectFont(descText, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, align: 'center', valign: 'top',
      shrinkText: true,
    });
  });
}

function fillCards2FromSchema(slide: any, content: Cards2Content, theme: ThemeConfig, apple: boolean, tpl: LayoutTemplate) {
  const t = tpl.cards2;
  // 左侧主卡片
  slide.addShape('roundRect', {
    x: t.leftX, y: t.cardY, w: t.leftW, h: t.cardH,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
    rectRadius: t.cardRadius,
  });

  // 主卡片标题
  slide.addText(normalizeCJKSpacing(content.mainCard.title), {
    x: t.leftX + t.padding, y: t.cardY + t.padding, w: t.leftW - t.padding * 2, h: 0.6,
    fontSize: t.titleFontSize + 2, fontFace: theme.fontTitle,
    color: theme.textPrimary, bold: true, valign: 'middle',
  });

  // 主卡片描述
  slide.addText(normalizeCJKSpacing(content.mainCard.description), {
    x: t.leftX + t.padding, y: t.cardY + t.padding + 0.7, w: t.leftW - t.padding * 2, h: t.cardH - t.padding * 2 - 0.7,
    fontSize: t.bodyFontSize, fontFace: selectFont(content.mainCard.description, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
    color: theme.textSecondary, valign: 'top',
    shrinkText: true,
  });

  // 右侧卡片列表
  const cards = content.cards.slice(0, 4);
  const rightCardH = Math.min(t.rightMaxCardH, (t.cardH - t.rightGap * (cards.length - 1)) / Math.max(cards.length, 1));

  cards.forEach((card, i) => {
    const x = t.rightX;
    const y = t.cardY + i * (rightCardH + t.rightGap);

    slide.addShape('roundRect', {
      x, y, w: t.rightW, h: rightCardH,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
      rectRadius: t.cardRadius,
    });

    slide.addText(normalizeCJKSpacing(card.title), {
      x: x + t.padding, y: y + 0.05, w: t.rightW - t.padding * 2, h: 0.35,
      fontSize: t.bodyFontSize, fontFace: theme.fontTitle,
      color: theme.accent, bold: true, valign: 'middle',
    });

    slide.addText(normalizeCJKSpacing(card.description), {
      x: x + t.padding, y: y + 0.4, w: t.rightW - t.padding * 2, h: rightCardH - 0.5,
      fontSize: t.bodyFontSize - 1, fontFace: selectFont(card.description, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, valign: 'top',
      shrinkText: true,
    });
  });
}

function fillCards3FromSchema(slide: any, content: Cards3Content, theme: ThemeConfig, apple: boolean, tpl: LayoutTemplate) {
  const t = tpl.cards3;
  const cards = content.cards.slice(0, 3);

  // 自适应居中：根据实际卡片数量计算起始 X
  const totalWidth = cards.length * t.cardWidth + (cards.length - 1) * t.gap;
  const dynamicStartX = (10 - totalWidth) / 2;

  // 短描述自适应高度
  const maxDescLen = Math.max(...cards.map(c => c.description.length));
  const baseH = maxDescLen < 40 ? t.baseH * 0.85 : t.baseH;

  cards.forEach((card, i) => {
    const x = dynamicStartX + i * (t.cardWidth + t.gap);
    const isCenter = i === 1;
    const yOffset = isCenter ? t.centerYOffset : 0;
    const heightBonus = isCenter ? t.centerHBonus : 0;
    const cardY = t.baseY + yOffset;
    const cardH = baseH + heightBonus;

    slide.addShape('roundRect', {
      x, y: cardY, w: t.cardWidth, h: cardH,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
      rectRadius: t.cardRadius,
    });

    // 序号
    slide.addText(String(i + 1), {
      x: x + t.cardWidth / 2 - 0.35, y: cardY + 0.3, w: 0.7, h: 0.7,
      fontSize: t.numberFontSize, fontFace: theme.fontTitle,
      color: theme.accent, bold: true, align: 'center', valign: 'middle',
    });

    // 分隔线
    slide.addShape('rect', {
      x: x + 0.5, y: cardY + 1.0, w: t.cardWidth - 1, h: 0.01,
      fill: { color: theme.cardBorder, transparency: apple ? 30 : 0 },
    });

    // 卡片标题
    slide.addText(normalizeCJKSpacing(card.title), {
      x: x + 0.3, y: cardY + 1.15, w: t.cardWidth - 0.6, h: 0.4,
      fontSize: t.bodyFontSize + 1, fontFace: theme.fontTitle,
      color: theme.textPrimary, bold: true, align: 'center', valign: 'middle',
    });

    // 卡片描述
    const descFontSize = adaptiveFontSize(card.description, t.bodyFontSize);
    slide.addText(normalizeCJKSpacing(card.description), {
      x: x + 0.3, y: cardY + 1.6, w: t.cardWidth - 0.6, h: cardH - 1.9,
      fontSize: descFontSize, fontFace: selectFont(card.description, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, valign: 'top', align: 'center',
      shrinkText: true,
    });
  });
}

function fillListFromSchema(slide: any, content: ListContent | HighlightContent, theme: ThemeConfig) {
  const points = content.points || [];
  const bulletText = points.map(p => `  ${normalizeCJKSpacing(p)}`).join('\n');
  slide.addText(bulletText, { placeholder: 'body' });
}

function fillTimelineFromSchema(slide: any, content: TimelineContent, theme: ThemeConfig, apple: boolean, tpl: LayoutTemplate) {
  const t = tpl.timeline;
  const steps = content.steps.slice(0, 4);
  const n = steps.length;

  // 动态居中：根据步骤数计算列宽和起始位置
  const stepW = Math.min(2.6, (10 - 1.2) / n);
  const totalW = stepW * n;
  const sx = (10 - totalW) / 2;
  const lineY = t.baseY;
  const halfDot = t.dotSize / 2;

  // 连接线（从第一个到最后一个圆点中心）
  if (n > 1) {
    const firstCx = sx + stepW / 2;
    const lastCx = sx + (n - 1) * stepW + stepW / 2;
    slide.addShape('rect', {
      x: firstCx, y: lineY + halfDot - t.lineHeight / 2,
      w: lastCx - firstCx, h: t.lineHeight,
      fill: { color: theme.accent, transparency: 60 },
    });
  }

  steps.forEach((step, i) => {
    const cx = sx + i * stepW + stepW / 2;
    const colX = sx + i * stepW;

    // 圆点（小实心）
    slide.addShape('ellipse', {
      x: cx - halfDot, y: lineY, w: t.dotSize, h: t.dotSize,
      fill: { color: theme.accent },
    });
    // 圆点内编号
    slide.addText(`${i + 1}`, {
      x: cx - halfDot, y: lineY, w: t.dotSize, h: t.dotSize,
      fontSize: 9, fontFace: theme.fontTitle,
      color: theme.bgColor, bold: true, align: 'center', valign: 'middle',
    });

    // 标题（线上方）
    slide.addText(step.title, {
      x: colX, y: lineY + t.labelYOffset, w: stepW, h: 0.5,
      fontSize: t.labelFontSize, fontFace: theme.fontTitle,
      color: theme.accent, bold: true, align: 'center',
      shrinkText: true,
    });

    // 描述（线下方）— 自适应内容高度和字号
    const maxDescLen = Math.max(...steps.map(s => s.description.length));
    const cjkRatio = (step.description.match(/[\u4e00-\u9fff]/g) || []).length / Math.max(step.description.length, 1);
    const charsPerLine = Math.floor((stepW - 0.4) * (cjkRatio > 0.3 ? 5 : 8)); // CJK ~5字/英寸，Latin ~8字/英寸
    const estimatedLines = Math.ceil(maxDescLen / Math.max(charsPerLine, 1));
    const lineH = t.contentFontSize * 1.6 / 72; // pt → inches with line spacing
    const neededH = Math.max(1.0, Math.min(t.contentHeight, estimatedLines * lineH + 0.3));
    const contentFontSize = adaptiveFontSize(step.description, t.contentFontSize);

    slide.addText(normalizeCJKSpacing(step.description), {
      x: colX + 0.2, y: lineY + t.dotSize + t.contentYOffset, w: stepW - 0.4, h: neededH,
      fontSize: contentFontSize, fontFace: selectFont(step.description, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, align: 'center', valign: 'top',
      shrinkText: true,
    });
  });
}

function fillComparisonFromSchema(slide: any, content: ComparisonContent, theme: ThemeConfig, apple: boolean, tpl: LayoutTemplate) {
  const t = tpl.comparison;
  const leftPoints = content.left.points;
  const rightPoints = content.right.points;
  const maxHalf = Math.max(leftPoints.length, rightPoints.length);
  const rowH = Math.min(t.maxRowH, (t.cardH - 1.0) / Math.max(maxHalf, 1));

  // 左侧卡片
  slide.addShape('roundRect', {
    x: t.leftX, y: t.cardY, w: t.leftW, h: t.cardH,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
    rectRadius: t.cardRadius,
  });

  // 左标题
  slide.addText(normalizeCJKSpacing(content.left.title), {
    x: t.leftX + 0.3, y: t.cardY + 0.15, w: t.leftW - 0.6, h: 0.4,
    fontSize: t.fontSize + 1, fontFace: theme.fontTitle,
    color: theme.accent, bold: true, valign: 'middle',
  });

  leftPoints.forEach((point, i) => {
    const pointFontSize = adaptiveFontSize(point, t.fontSize);
    slide.addText(normalizeCJKSpacing(point), {
      x: t.leftX + 0.3, y: t.cardY + 0.65 + i * rowH, w: t.leftW - 0.6, h: rowH,
      fontSize: pointFontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, valign: 'middle',
      shrinkText: true,
    });
  });

  // 右侧卡片
  slide.addShape('roundRect', {
    x: t.rightX, y: t.cardY, w: t.rightW, h: t.cardH,
    fill: { color: theme.bgSecondary },
    line: { color: theme.cardBorder, width: 0.5, transparency: apple ? 50 : 0 },
    rectRadius: t.cardRadius,
  });

  // 右标题
  slide.addText(normalizeCJKSpacing(content.right.title), {
    x: t.rightX + 0.3, y: t.cardY + 0.15, w: t.rightW - 0.6, h: 0.4,
    fontSize: t.fontSize + 1, fontFace: theme.fontTitle,
    color: theme.accent, bold: true, valign: 'middle',
  });

  rightPoints.forEach((point, i) => {
    const pointFontSize = adaptiveFontSize(point, t.fontSize);
    slide.addText(normalizeCJKSpacing(point), {
      x: t.rightX + 0.3, y: t.cardY + 0.65 + i * rowH, w: t.rightW - 0.6, h: rowH,
      fontSize: pointFontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, valign: 'middle',
      shrinkText: true,
    });
  });
}

function fillQuoteFromSchema(slide: any, content: QuoteContent, theme: ThemeConfig) {
  slide.addText(normalizeCJKSpacing(content.quote), { placeholder: 'slideTitle' });
  if (content.attribution) {
    slide.addText(normalizeCJKSpacing(content.attribution), { placeholder: 'body' });
  }
}

function fillChartFromSchema(pptx: any, slide: any, content: ChartContent, theme: ThemeConfig, chartData: ChartSlotData | null) {
  // 左侧要点
  const bulletText = content.points.map(p => `  ${normalizeCJKSpacing(p)}`).join('\n');
  slide.addText(bulletText, { placeholder: 'body' });

  // 右侧图表
  if (chartData) {
    renderNativeChart(pptx, slide, chartData, theme, { x: 5.1, y: 1.55, w: 4.3, h: 3.6 });
  } else if (content.chartData) {
    // 从 schema 直接构建图表数据
    const schemaChart: ChartSlotData = {
      chartType: content.chartData.chartType === 'doughnut' ? 'doughnut' :
                 content.chartData.chartType === 'line' ? 'line' : 'bar',
      labels: content.chartData.labels,
      values: content.chartData.values,
    };
    renderNativeChart(pptx, slide, schemaChart, theme, { x: 5.1, y: 1.55, w: 4.3, h: 3.6 });
  }
}

function fillTwoColumnFromSchema(slide: any, content: TwoColumnContent, theme: ThemeConfig, apple: boolean, tpl: LayoutTemplate) {
  const t = tpl.twoColumn;
  const leftPoints = content.leftPoints;
  const rightPoints = content.rightPoints;
  const maxHalf = Math.max(leftPoints.length, rightPoints.length);
  const rowH = Math.min(t.maxRowH, 3.4 / Math.max(maxHalf, 1));

  // 中间分隔线
  slide.addShape('rect', {
    x: t.dividerX, y: t.contentStartY + 0.05, w: t.dividerW, h: maxHalf * rowH - 0.2,
    fill: { color: theme.cardBorder, transparency: apple ? 40 : 0 },
  });

  leftPoints.forEach((point, i) => {
    const y = t.contentStartY + i * rowH;
    slide.addShape('ellipse', {
      x: t.leftDotX, y: y + 0.18, w: t.dotSize, h: t.dotSize,
      fill: { color: theme.accent },
    });
    slide.addText(normalizeCJKSpacing(point), {
      x: t.leftTextX, y, w: t.leftTextW, h: rowH,
      fontSize: t.fontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, valign: 'middle',
    });
  });

  rightPoints.forEach((point, i) => {
    const y = t.contentStartY + i * rowH;
    slide.addShape('ellipse', {
      x: t.rightDotX, y: y + 0.18, w: t.dotSize, h: t.dotSize,
      fill: { color: theme.accent },
    });
    slide.addText(normalizeCJKSpacing(point), {
      x: t.rightTextX, y, w: t.rightTextW, h: rowH,
      fontSize: t.fontSize, fontFace: selectFont(point, theme.fontBody, theme.fontBody, theme.fontTitleCN, theme.fontBodyCN),
      color: theme.textSecondary, valign: 'middle',
    });
  });
}

/**
 * 为 StructuredSlide 选择 Master（基于 layout 类型）
 */
export function selectMasterForStructuredSlide(data: StructuredSlide): string {
  if (data.isTitle) return MASTER.TITLE;
  if (data.isEnd) return MASTER.END;

  switch (data.layout) {
    case 'quote': return MASTER.QUOTE;
    case 'comparison': return MASTER.COMPARISON;
    case 'two-column': return MASTER.TWO_COL;
    case 'chart': return MASTER.CONTENT_CHART;
    case 'list':
    case 'highlight': return MASTER.CONTENT_LIST;
    default: return MASTER.HERO_NUMBER;
  }
}
