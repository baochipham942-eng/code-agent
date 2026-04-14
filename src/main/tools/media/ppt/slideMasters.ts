// ============================================================================
// PPT Slide Master 定义 - 声明式设计
// 使用 pptx.defineSlideMaster() 创建可复用的幻灯片模板
// ============================================================================

import type { ThemeConfig } from './types';
import { isAppleDark } from './themes';
import { getDecorations, buildDecorationObjects } from './masterDecorations';
import {
  MASTER_CONTENT_TITLE,
  MASTER_CONTENT_TITLE_FONT,
  MASTER_FOOTER_LEFT,
  MASTER_FOOTER_RIGHT,
  BRAND_GENERATED_BY,
  BRAND_POWERED_BY,
  BRAND_THANK_YOU,
} from './constants';

// Master 名称常量
export const MASTER = {
  TITLE: 'MASTER_TITLE',
  CONTENT_LIST: 'MASTER_CONTENT_LIST',
  CONTENT_CHART: 'MASTER_CONTENT_CHART',
  CONTENT_IMAGE: 'MASTER_CONTENT_IMAGE',
  END: 'MASTER_END',
  HERO_NUMBER: 'MASTER_HERO_NUMBER',
  QUOTE: 'MASTER_QUOTE',
  COMPARISON: 'MASTER_COMPARISON',
  TWO_COL: 'MASTER_TWO_COL',
} as const;

/**
 * 注册所有 Slide Master 到 pptx 实例
 */
export function registerSlideMasters(pptx: any, theme: ThemeConfig): void {
  const apple = isAppleDark(theme);

  registerTitleMaster(pptx, theme, apple);
  registerContentListMaster(pptx, theme, apple);
  registerContentChartMaster(pptx, theme, apple);
  registerContentImageMaster(pptx, theme, apple);
  registerEndMaster(pptx, theme, apple);
  registerHeroNumberMaster(pptx, theme, apple);
  registerQuoteMaster(pptx, theme, apple);
  registerComparisonMaster(pptx, theme, apple);
  registerTwoColMaster(pptx, theme, apple);
}

// ============================================================================
// TITLE Master - 封面页
// ============================================================================
function registerTitleMaster(pptx: any, theme: ThemeConfig, apple: boolean) {
  const decoConfig = getDecorations(apple, 'TITLE');
  const objects: any[] = buildDecorationObjects(decoConfig, theme);

  // 底部品牌信息
  objects.push({
    text: {
      text: BRAND_GENERATED_BY,
      options: { ...MASTER_FOOTER_LEFT, fontFace: theme.fontBody, color: theme.textSecondary, charSpacing: 3 },
    },
  });
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit' });
  objects.push({
    text: {
      text: date,
      options: { ...MASTER_FOOTER_RIGHT, fontFace: theme.fontBody, color: theme.textSecondary, align: 'right' },
    },
  });

  // Placeholder: 标题
  objects.push({
    placeholder: {
      options: {
        name: 'slideTitle', type: 'title',
        x: 0.8, y: 1.8, w: 8, h: 1.2,
        fontSize: apple ? 44 : 48,
        fontFace: theme.fontTitle, color: theme.textPrimary, bold: true, valign: 'middle',
        shrinkText: true,
      },
    },
  });

  // Placeholder: 副标题
  objects.push({
    placeholder: {
      options: {
        name: 'body', type: 'body',
        x: 0.8, y: 3.5, w: 8, h: 0.7,
        fontSize: apple ? 18 : 20,
        fontFace: theme.fontBody, color: theme.textSecondary, charSpacing: 2,
        shrinkText: true,
      },
    },
  });

  pptx.defineSlideMaster({
    title: MASTER.TITLE,
    background: { color: theme.bgColor },
    objects,
  });
}

// ============================================================================
// CONTENT_LIST Master - 内容列表页
// ============================================================================
function registerContentListMaster(pptx: any, theme: ThemeConfig, apple: boolean) {
  const decoConfig = getDecorations(apple, 'CONTENT_LIST');
  const objects: any[] = buildDecorationObjects(decoConfig, theme);

  // Placeholder: 标题
  objects.push({
    placeholder: {
      options: {
        name: 'slideTitle',
        type: 'title',
        ...MASTER_CONTENT_TITLE,
        fontSize: apple ? MASTER_CONTENT_TITLE_FONT.apple : MASTER_CONTENT_TITLE_FONT.default,
        fontFace: theme.fontTitle,
        color: theme.textPrimary,
        bold: true,
        shrinkText: true,
      },
    },
  });

  // Placeholder: body
  objects.push({
    placeholder: {
      options: {
        name: 'body',
        type: 'body',
        x: 0.8, y: 1.65, w: 8.4, h: 3.4,
        fontSize: apple ? 18 : 16,
        fontFace: theme.fontBody,
        color: theme.textSecondary,
        valign: 'middle',
        bullet: true,
        lineSpacingMultiple: 1.6,
        shrinkText: true,
      },
    },
  });

  pptx.defineSlideMaster({
    title: MASTER.CONTENT_LIST,
    background: { color: theme.bgColor },
    objects,
  });
}

// ============================================================================
// CONTENT_CHART Master - 左文右图表页
// ============================================================================
function registerContentChartMaster(pptx: any, theme: ThemeConfig, apple: boolean) {
  const decoConfig = getDecorations(apple, 'CONTENT_CHART');
  const objects: any[] = buildDecorationObjects(decoConfig, theme);

  // Placeholder: 标题
  objects.push({
    placeholder: {
      options: {
        name: 'slideTitle',
        type: 'title',
        ...MASTER_CONTENT_TITLE,
        fontSize: apple ? MASTER_CONTENT_TITLE_FONT.apple : MASTER_CONTENT_TITLE_FONT.default,
        fontFace: theme.fontTitle,
        color: theme.textPrimary,
        bold: true,
        shrinkText: true,
      },
    },
  });

  // Placeholder: 左侧 body
  objects.push({
    placeholder: {
      options: {
        name: 'body',
        type: 'body',
        x: 0.7, y: 1.6, w: 3.7, h: 3.5,
        fontSize: apple ? 14 : 13,
        fontFace: theme.fontBody,
        color: theme.textSecondary,
        valign: 'middle',
        bullet: true,
        lineSpacingMultiple: 1.5,
        shrinkText: true,
      },
    },
  });

  pptx.defineSlideMaster({
    title: MASTER.CONTENT_CHART,
    background: { color: theme.bgColor },
    objects,
  });
}

// ============================================================================
// CONTENT_IMAGE Master - 左文右图片页
// ============================================================================
function registerContentImageMaster(pptx: any, theme: ThemeConfig, apple: boolean) {
  const decoConfig = getDecorations(apple, 'CONTENT_IMAGE');
  const objects: any[] = buildDecorationObjects(decoConfig, theme);

  // Placeholder: 标题
  objects.push({
    placeholder: {
      options: {
        name: 'slideTitle', type: 'title',
        x: 0.6, y: 0.35, w: 8, h: 0.8,
        fontSize: apple ? 24 : 28,
        fontFace: theme.fontTitle, color: theme.textPrimary, bold: true, shrinkText: true,
      },
    },
  });

  // Placeholder: 左侧 body
  objects.push({
    placeholder: {
      options: {
        name: 'body', type: 'body',
        x: 0.5, y: 1.4, w: 4.3, h: 3.6,
        fontSize: 12,
        fontFace: theme.fontBody, color: theme.textSecondary, valign: 'top', bullet: true,
      },
    },
  });

  pptx.defineSlideMaster({
    title: MASTER.CONTENT_IMAGE,
    background: { color: theme.bgColor },
    objects,
  });
}

// ============================================================================
// END Master - 结束页
// ============================================================================
function registerEndMaster(pptx: any, theme: ThemeConfig, apple: boolean) {
  const decoConfig = getDecorations(apple, 'END');
  const objects: any[] = buildDecorationObjects(decoConfig, theme);

  // 副文案
  objects.push({
    text: {
      text: BRAND_THANK_YOU,
      options: {
        x: 1.5, y: 3.6, w: 7, h: 0.4,
        fontSize: apple ? 10 : 12, fontFace: theme.fontBody,
        color: theme.textSecondary, charSpacing: apple ? 6 : 4, align: 'center',
      },
    },
  });

  // 底部品牌信息
  objects.push({
    text: {
      text: BRAND_POWERED_BY,
      options: { ...MASTER_FOOTER_LEFT, fontFace: theme.fontBody, color: theme.textSecondary, charSpacing: 2 },
    },
  });
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit' });
  objects.push({
    text: {
      text: date,
      options: { ...MASTER_FOOTER_RIGHT, fontFace: theme.fontBody, color: theme.textSecondary, align: 'right' },
    },
  });

  // Placeholder: 标题
  objects.push({
    placeholder: {
      options: {
        name: 'slideTitle', type: 'title',
        x: 1.5, y: 2.2, w: 7, h: 1,
        fontSize: apple ? 42 : 48,
        fontFace: theme.fontTitle, color: theme.textPrimary, bold: true, align: 'center',
      },
    },
  });

  pptx.defineSlideMaster({
    title: MASTER.END,
    background: { color: theme.bgColor },
    objects,
  });
}

// ============================================================================
// HERO_NUMBER Master - 大数字展示页（apple 风格）
// ============================================================================
function registerHeroNumberMaster(pptx: any, theme: ThemeConfig, apple: boolean) {
  const decoConfig = getDecorations(apple, 'HERO_NUMBER');
  const objects: any[] = buildDecorationObjects(decoConfig, theme);

  // Placeholder: 标题
  objects.push({
    placeholder: {
      options: {
        name: 'slideTitle',
        type: 'title',
        ...MASTER_CONTENT_TITLE,
        fontSize: apple ? MASTER_CONTENT_TITLE_FONT.apple : MASTER_CONTENT_TITLE_FONT.default,
        fontFace: theme.fontTitle,
        color: theme.textPrimary,
        bold: true,
        shrinkText: true,
      },
    },
  });

  pptx.defineSlideMaster({
    title: MASTER.HERO_NUMBER,
    background: { color: theme.bgColor },
    objects,
  });
}

// ============================================================================
// QUOTE Master - 引言居中页
// ============================================================================
function registerQuoteMaster(pptx: any, theme: ThemeConfig, apple: boolean) {
  const decoConfig = getDecorations(apple, 'QUOTE');
  const objects: any[] = buildDecorationObjects(decoConfig, theme);

  // 大引号装饰（特殊文本元素，不在 config 中）
  objects.push({
    text: {
      text: '\u201C',
      options: {
        x: 1, y: 1.2, w: 1.5, h: 1.5,
        fontSize: 120, fontFace: theme.fontTitle,
        color: theme.accent, transparency: apple ? 30 : 20,
      },
    },
  });

  // Placeholder: 引言内容（不用 italic —— CJK italic 在多数渲染器中会导致叠字）
  objects.push({
    placeholder: {
      options: {
        name: 'slideTitle',
        type: 'title',
        x: 1.5, y: 1.5, w: 7, h: 2.5,
        fontSize: apple ? 20 : 22,
        fontFace: theme.fontBody,
        color: theme.textPrimary,
        align: 'center',
        valign: 'middle',
        shrinkText: true,
        lineSpacingMultiple: 1.5,
      },
    },
  });

  // Placeholder: 来源/作者
  objects.push({
    placeholder: {
      options: {
        name: 'body',
        type: 'body',
        x: 2, y: 4.5, w: 6, h: 0.6,
        fontSize: 13,
        shrinkText: true,
        fontFace: theme.fontBody,
        color: theme.textSecondary,
        align: 'center',
      },
    },
  });

  pptx.defineSlideMaster({
    title: MASTER.QUOTE,
    background: { color: theme.bgColor },
    objects,
  });
}

// ============================================================================
// COMPARISON Master - 左右对比页
// ============================================================================
function registerComparisonMaster(pptx: any, theme: ThemeConfig, apple: boolean) {
  const decoConfig = getDecorations(apple, 'COMPARISON');
  const objects: any[] = buildDecorationObjects(decoConfig, theme);

  // 中间分隔线（使用 cardBorder 色，非 accent）
  objects.push({
    rect: { x: 4.95, y: 1.5, w: apple ? 0.02 : 0.04, h: 3.8, fill: { color: theme.cardBorder, transparency: apple ? 30 : 0 } },
  });

  // VS 标记（非 Apple）
  if (!apple) {
    objects.push({
      text: {
        text: 'VS',
        options: {
          x: 4.5, y: 2.8, w: 1, h: 0.5,
          fontSize: 14, fontFace: theme.fontTitle,
          color: theme.accent, bold: true, align: 'center', valign: 'middle',
        },
      },
    });
  }

  // Placeholder: 标题
  objects.push({
    placeholder: {
      options: {
        name: 'slideTitle',
        type: 'title',
        ...MASTER_CONTENT_TITLE,
        fontSize: apple ? MASTER_CONTENT_TITLE_FONT.apple : MASTER_CONTENT_TITLE_FONT.default,
        fontFace: theme.fontTitle,
        color: theme.textPrimary,
        bold: true,
        shrinkText: true,
      },
    },
  });

  pptx.defineSlideMaster({
    title: MASTER.COMPARISON,
    background: { color: theme.bgColor },
    objects,
  });
}

// ============================================================================
// TWO_COL Master - 双列内容页
// ============================================================================
function registerTwoColMaster(pptx: any, theme: ThemeConfig, apple: boolean) {
  const decoConfig = getDecorations(apple, 'TWO_COL');
  const objects: any[] = buildDecorationObjects(decoConfig, theme);

  // Placeholder: 标题
  objects.push({
    placeholder: {
      options: {
        name: 'slideTitle',
        type: 'title',
        ...MASTER_CONTENT_TITLE,
        fontSize: apple ? MASTER_CONTENT_TITLE_FONT.apple : MASTER_CONTENT_TITLE_FONT.default,
        fontFace: theme.fontTitle,
        color: theme.textPrimary,
        bold: true,
        shrinkText: true,
      },
    },
  });

  pptx.defineSlideMaster({
    title: MASTER.TWO_COL,
    background: { color: theme.bgColor },
    objects,
  });
}
