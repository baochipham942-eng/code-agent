// ============================================================================
// PPT 布局选择与内容填充
// ============================================================================

import * as fs from 'fs';
import type { ThemeConfig, LayoutType, SlideData, SlideImage, ChartSlotData, ChartMode } from './types';
import { isAppleDark } from './themes';
import { MASTER } from './slideMasters';
import { detectChartData, renderNativeChart } from './charts';

// 布局轮换计数器
let layoutRotationIndex = 0;

export function resetLayoutRotation(): void {
  layoutRotationIndex = 0;
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
  };
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

  if (content.isTechnical) return 'cards-2';
  if (content.isProcess && pointCount >= 3) return 'timeline';
  if (content.isKeyPoint && pointCount <= 4) return 'highlight';
  if (content.isComparison && pointCount >= 3) return 'cards-2';
  if (content.hasNumbers && pointCount >= 3 && pointCount <= 5) return 'stats';
  if (pointCount === 3) return 'cards-3';

  if (pointCount >= 4) {
    // cards-3 只在恰好 3 要点时走（line 106），≥4 要点会丢内容，不参与轮换
    const layouts: LayoutType[] = ['cards-2', 'list'];
    const selected = layouts[layoutRotationIndex % layouts.length];
    layoutRotationIndex++;
    return selected;
  }

  if (pointCount <= 2) return 'highlight';
  return 'list';
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
    if (slideData.subtitle) {
      slide.addText(slideData.subtitle, { placeholder: 'body' });
    }
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
    renderNativeChart(pptx, slide, chartData, theme, { x: 5.1, y: 1.4, w: 4.5, h: 3.8 });
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

  // ===== 简单布局：list / highlight → placeholder =====
  if (layout === 'list' || layout === 'highlight') {
    slide.addText(slideData.title, { placeholder: 'slideTitle' });
    const bulletText = slideData.points.map(p => `  ${p}`).join('\n');
    slide.addText(bulletText, { placeholder: 'body' });
    return;
  }

  // ===== 复杂布局：stats / cards / timeline → 标题用 placeholder + 内容用坐标 =====
  slide.addText(slideData.title, { placeholder: 'slideTitle' });

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
    default:
      // fallback: 坐标定位（HERO_NUMBER 无 body placeholder）
      const text = slideData.points.map(p => `  ${p}`).join('\n');
      slide.addText(text, {
        x: 0.5, y: 1.5, w: 9, h: 3.5,
        fontSize: 14, fontFace: theme.fontBody,
        color: theme.textSecondary, valign: 'top',
      });
      break;
  }
}

// ============================================================================
// 内容填充函数（仅填充内容，骨架在 master 中）
// ============================================================================

function addPageNumber(slide: any, index: number, theme: ThemeConfig, apple: boolean) {
  if (apple) {
    // apple: 简洁页码
    slide.addText(String(index).padStart(2, '0'), {
      x: 9.2, y: 0.4, w: 0.5, h: 0.4,
      fontSize: 11, fontFace: theme.fontBody,
      color: theme.textSecondary, align: 'right',
    });
  } else {
    // 页码徽章
    slide.addShape('roundRect', {
      x: 9.1, y: 0.35, w: 0.55, h: 0.55,
      fill: { color: theme.bgSecondary },
      line: { color: theme.cardBorder, width: 0.5 },
      rectRadius: 0.08,
    });
    slide.addText(String(index).padStart(2, '0'), {
      x: 9.1, y: 0.35, w: 0.55, h: 0.55,
      fontSize: 12, fontFace: theme.fontBody,
      color: theme.textSecondary, align: 'center', valign: 'middle',
    });
  }
}

function fillStatsLayout(slide: any, points: string[], theme: ThemeConfig, apple: boolean) {
  // 只选取包含可提取数字的要点，避免无意义的序号 "2"/"4"
  const withNumbers = points.filter(p => /\d+[\d.,]*[%万亿KMB]?/i.test(p));
  const stats = (withNumbers.length >= 3 ? withNumbers : points).slice(0, 4);
  const cardWidth = 2.05;
  const cardHeight = apple ? 2.8 : 3.2;
  const gap = 0.22;
  const startX = (10 - (stats.length * cardWidth + (stats.length - 1) * gap)) / 2;
  const y = 1.55;

  stats.forEach((point, i) => {
    const x = startX + i * (cardWidth + gap);
    const numMatch = point.match(/(\d+[\d.,]*[%万亿KMB+]?)\s*(分钟|小时|天|周|个月|年|倍|人|位|个|项|款|种|次)?/i);
    const numText = numMatch ? (numMatch[1] + (numMatch[2] || '')) : String(i + 1);
    // 保留完整文本作为描述，不剥离数字（大数字已单独展示）
    const descText = point.replace(/[，,：:；;]/g, ' ').trim();

    if (!apple) {
      // 卡片外发光
      slide.addShape('roundRect', {
        x: x - 0.05, y: y - 0.05, w: cardWidth + 0.1, h: cardHeight + 0.1,
        fill: { color: theme.accent, transparency: 95 },
        rectRadius: 0.2,
      });
    }

    // 卡片主体
    slide.addShape('roundRect', {
      x, y, w: cardWidth, h: cardHeight,
      fill: { color: apple ? theme.bgColor : theme.bgSecondary },
      line: apple ? undefined : { color: theme.cardBorder, width: 0.5 },
      rectRadius: 0.15,
    });

    // 大数字
    slide.addText(numText, {
      x, y: y + (apple ? 0.3 : 1), w: cardWidth, h: 0.8,
      fontSize: apple ? 48 : 32, fontFace: theme.fontTitle,
      color: theme.accent, bold: true, align: 'center',
    });

    if (!apple) {
      // 分隔线
      slide.addShape('rect', {
        x: x + 0.4, y: y + 1.85, w: cardWidth - 0.8, h: 0.02,
        fill: { color: theme.cardBorder },
      });
    }

    // 描述文字
    slide.addText(descText, {
      x: x + 0.15, y: y + (apple ? 1.3 : 2), w: cardWidth - 0.3, h: 1.1,
      fontSize: apple ? 13 : 11, fontFace: theme.fontBody,
      color: theme.textSecondary, align: 'center', valign: 'top',
    });
  });
}

function fillCards2Layout(slide: any, points: string[], theme: ThemeConfig, apple: boolean) {
  const leftPoints = points.slice(0, Math.ceil(points.length / 2));
  const rightPoints = points.slice(Math.ceil(points.length / 2));

  // 左侧主卡片
  slide.addShape('roundRect', {
    x: 0.35, y: 1.5, w: 4.5, h: 3.7,
    fill: { color: apple ? theme.bgColor : theme.bgSecondary },
    line: apple ? undefined : { color: theme.cardBorder, width: 0.5 },
    rectRadius: 0.18,
  });

  if (!apple) {
    slide.addShape('rect', {
      x: 0.55, y: 1.7, w: 0.08, h: 0.5,
      fill: { color: theme.accent },
    });
  }

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

  // 右侧卡片列表
  rightPoints.forEach((point, i) => {
    const y = 1.5 + i * 1.25;
    const isFirst = i === 0;

    slide.addShape('roundRect', {
      x: 5.1, y, w: 4.4, h: 1.1,
      fill: { color: apple ? theme.bgColor : theme.bgSecondary },
      line: apple
        ? (isFirst ? { color: theme.accent, width: 1 } : undefined)
        : { color: isFirst ? theme.accent : theme.cardBorder, width: isFirst ? 1.5 : 0.5 },
      rectRadius: 0.12,
    });

    slide.addText(point, {
      x: 5.3, y: y + 0.2, w: 4, h: 0.7,
      fontSize: 12, fontFace: theme.fontBody,
      color: theme.textSecondary, valign: 'middle',
    });
  });
}

function fillCards3Layout(slide: any, points: string[], theme: ThemeConfig, apple: boolean) {
  const displayPoints = points.slice(0, 3);
  const cardWidth = 2.9;
  const gap = 0.3;
  const startX = 0.55;

  displayPoints.forEach((point, i) => {
    const x = startX + i * (cardWidth + gap);
    const isCenter = i === 1;
    const yOffset = isCenter ? -0.1 : 0;
    const heightBonus = isCenter ? 0.2 : 0;

    // 卡片
    slide.addShape('roundRect', {
      x, y: 1.65 + yOffset, w: cardWidth, h: 3.4 + heightBonus,
      fill: { color: apple ? theme.bgColor : theme.bgSecondary },
      line: apple
        ? (isCenter ? { color: theme.accent, width: 1 } : undefined)
        : { color: isCenter ? theme.accent : theme.cardBorder, width: isCenter ? 1.5 : 0.5 },
      rectRadius: 0.15,
    });

    // 序号
    if (!apple) {
      slide.addShape('roundRect', {
        x: x + cardWidth / 2 - 0.4, y: 1.9 + yOffset, w: 0.8, h: 0.8,
        fill: { color: theme.accent, transparency: isCenter ? 0 : 85 },
        rectRadius: 0.12,
      });
    }
    slide.addText(String(i + 1), {
      x: x + cardWidth / 2 - 0.4, y: 1.9 + yOffset, w: 0.8, h: 0.8,
      fontSize: apple ? 28 : 24, fontFace: theme.fontTitle,
      color: apple ? theme.accent : (isCenter ? theme.bgColor : theme.accent),
      bold: true, align: 'center', valign: 'middle',
    });

    // 分隔线
    slide.addShape('rect', {
      x: x + 0.5, y: 2.9 + yOffset, w: cardWidth - 1, h: apple ? 0.01 : 0.02,
      fill: { color: theme.cardBorder },
    });

    // 内容
    slide.addText(point, {
      x: x + 0.2, y: 3.1 + yOffset, w: cardWidth - 0.4, h: 1.8 + heightBonus,
      fontSize: 12, fontFace: theme.fontBody,
      color: theme.textSecondary, valign: 'top', align: 'center',
    });
  });
}

function fillTimelineLayout(slide: any, points: string[], theme: ThemeConfig, apple: boolean) {
  const displayPoints = points.slice(0, 4);
  const stepWidth = 2.2;
  const startX = 0.65;
  const y = 2.2;

  // 主连接线
  slide.addShape('rect', {
    x: startX + 0.32, y: y + 0.4, w: 7.8, h: apple ? 0.02 : 0.04,
    fill: { color: theme.cardBorder },
  });
  // 进度色
  slide.addShape('rect', {
    x: startX + 0.32, y: y + 0.4, w: 2, h: apple ? 0.02 : 0.04,
    fill: { color: theme.accent },
  });

  displayPoints.forEach((point, i) => {
    const x = startX + i * stepWidth;
    const isFirst = i === 0;

    if (!apple) {
      // 步骤卡片背景
      slide.addShape('roundRect', {
        x: x - 0.1, y: y - 0.75, w: stepWidth + 0.2, h: 3.6,
        fill: { color: theme.bgSecondary, transparency: isFirst ? 0 : 50 },
        line: { color: isFirst ? theme.accent : theme.cardBorder, width: isFirst ? 1.5 : 0.5 },
        rectRadius: 0.12,
      });
    }

    // 圆点
    slide.addShape('ellipse', {
      x: x + stepWidth / 2 - 0.2, y: y + 0.25, w: 0.4, h: 0.4,
      fill: { color: isFirst ? theme.accent : (apple ? theme.bgColor : theme.bgColor) },
      line: { color: theme.accent, width: apple ? 1 : 2 },
    });

    // 步骤标签
    slide.addText(`STEP ${i + 1}`, {
      x, y: y - 0.5, w: stepWidth, h: 0.35,
      fontSize: 10, fontFace: theme.fontTitle,
      color: isFirst ? theme.accent : theme.textSecondary, bold: true, align: 'center', charSpacing: 2,
    });

    // 内容
    slide.addText(point, {
      x: x + 0.1, y: y + 1, w: stepWidth - 0.2, h: 1.7,
      fontSize: 11, fontFace: theme.fontBody,
      color: theme.textSecondary, align: 'center', valign: 'top',
    });
  });
}

function addSlideImages(
  slide: any,
  images: SlideImage[],
  theme: ThemeConfig
) {
  const imgX = 5.0;
  const imgY = 1.3;
  const imgW = 4.6;
  const imgH = 3.8;

  const displayImages = images.slice(0, 1);
  displayImages.forEach((img) => {
    try {
      if (!fs.existsSync(img.image_path)) return;
      slide.addImage({
        path: img.image_path,
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
