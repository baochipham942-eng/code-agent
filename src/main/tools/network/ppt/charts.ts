// ============================================================================
// PPT 原生图表渲染 - 使用 pptxgenjs addChart() API
// 生成可编辑的原生 PowerPoint 图表
// ============================================================================

import type { ChartSlotData, ChartType, ThemeConfig } from './types';

/**
 * 检测内容中是否包含可提取的图表数据
 * 返回 null 表示不适合生成图表
 *
 * 严格标准：要点必须以数字为核心信息（如 "市场规模 150 亿"），
 * 而非含数字的描述（如 "支持 50+ 编程语言"）。
 */
export function detectChartData(title: string, points: string[]): ChartSlotData | null {
  // 标题必须含数据相关关键词
  const dataKeywords = /数据|统计|市场|规模|增长|趋势|占比|份额|对比|排名|指标|data|market|stats|growth/i;
  if (!dataKeywords.test(title)) return null;

  // 筛选"数据型"要点：数字出现在要点前半部分，或以数字开头/结尾
  const dataPoints = points.filter(p => {
    // 必须包含数字
    if (!/\d+[\d.,]*[%万亿KMB]?/i.test(p)) return false;
    // 数字必须是要点的核心信息，不是附带数字
    // 排除：含动词短语的描述性内容（如 "支持 50+ 语言"、"提升 80%"）
    // 保留：以指标名+数字为主体的要点（如 "市场规模 150 亿"、"年增长率 35%"）
    const numMatch = p.match(/(\d+[\d.,]*[%万亿KMB]?)/i);
    if (!numMatch) return false;
    // 数字前面的文本（标签部分）不超过 15 个字 → 说明数字是核心
    const beforeNum = p.slice(0, p.indexOf(numMatch[0])).trim();
    return beforeNum.length <= 15;
  });

  if (dataPoints.length < 3) return null;

  const labels: string[] = [];
  const values: number[] = [];

  for (const point of dataPoints) {
    const numMatch = point.match(/(\d+[\d.,]*)/);
    if (!numMatch) continue;

    let num = parseFloat(numMatch[1].replace(/,/g, ''));
    if (/万/.test(point)) num *= 10000;
    if (/亿/.test(point)) num *= 100000000;
    if (isNaN(num)) continue;

    const label = point
      .replace(/\d+[\d.,]*[%万亿KMB]?/gi, '')
      .replace(/[，,：:；;。.、]/g, ' ')
      .trim()
      .slice(0, 20);

    if (label) {
      labels.push(label);
      values.push(num);
    }
  }

  if (labels.length < 3) return null;

  // 数量级校验：最大值/最小值比超过 1000 则数据不适合同一图表
  const nonZeroValues = values.filter(v => v > 0);
  if (nonZeroValues.length >= 2) {
    const maxVal = Math.max(...nonZeroValues);
    const minVal = Math.min(...nonZeroValues);
    if (minVal > 0 && maxVal / minVal > 1000) return null;
  }

  const chartType = selectChartType(title, points);

  return {
    chartType,
    labels: labels.slice(0, 6),
    values: values.slice(0, 6),
    title: title,
  };
}

/**
 * 根据内容特征选择图表类型
 */
function selectChartType(title: string, points: string[]): ChartType {
  const allText = [title, ...points].join(' ').toLowerCase();

  // 百分比/占比 → 环形图
  if (/占比|比例|份额|分布|percent|share|ratio/i.test(allText)) {
    // 检查是否所有数值加起来接近 100
    const hasPercent = points.some(p => /%/.test(p));
    if (hasPercent) return 'doughnut';
  }

  // 时间序列关键词 → 折线图
  if (/趋势|增长|变化|年|月|季度|trend|growth|timeline|year|month/i.test(allText)) {
    return 'line';
  }

  // 排名/对比 → 横向条形图
  if (/排名|排行|对比|top|rank|compare/i.test(allText)) {
    return 'bar';
  }

  // 默认 → 纵向柱状图
  return 'bar';
}

/**
 * 渲染原生可编辑图表
 */
export function renderNativeChart(
  pptx: any,
  slide: any,
  chartData: ChartSlotData,
  theme: ThemeConfig,
  bounds: { x: number; y: number; w: number; h: number }
) {
  const { chartType, labels, values } = chartData;

  // pptxgenjs 图表数据格式
  const data = [{
    name: chartData.title || 'Data',
    labels,
    values,
  }];

  // 通用图表选项
  const baseOpts: any = {
    x: bounds.x,
    y: bounds.y,
    w: bounds.w,
    h: bounds.h,
    showLegend: false,
    showTitle: false,
    showValue: true,
    valueFontSize: 10,
    valueFontColor: theme.textSecondary,
    catAxisLabelColor: theme.textSecondary,
    catAxisLabelFontSize: 9,
    valAxisLabelColor: theme.textSecondary,
    valAxisLabelFontSize: 9,
    chartColors: generateChartColors(theme, labels.length),
    plotArea: { fill: { color: theme.bgSecondary, transparency: 50 } },
  };

  // 深色主题隐藏轴线
  if (theme.isDark) {
    baseOpts.catAxisLineShow = false;
    baseOpts.valAxisLineShow = false;
    baseOpts.valGridLine = { color: theme.cardBorder, style: 'dash', size: 0.5 };
  }

  let pptxChartType: any;

  switch (chartType) {
    case 'bar':
      pptxChartType = pptx.charts.BAR;
      baseOpts.barDir = 'col';
      baseOpts.barGapWidthPct = 80;
      baseOpts.catAxisOrientation = 'minMax';
      break;

    case 'doughnut':
      pptxChartType = pptx.charts.DOUGHNUT;
      baseOpts.showLabel = true;
      baseOpts.showPercent = true;
      baseOpts.showValue = false;
      baseOpts.dataLabelColor = theme.textPrimary;
      baseOpts.dataLabelFontSize = 10;
      baseOpts.holeSize = 50;
      break;

    case 'line':
      pptxChartType = pptx.charts.LINE;
      baseOpts.lineSmooth = true;
      baseOpts.lineSize = 2;
      baseOpts.lineDataSymbol = 'circle';
      baseOpts.lineDataSymbolSize = 6;
      break;

    case 'pie':
      pptxChartType = pptx.charts.PIE;
      baseOpts.showLabel = true;
      baseOpts.showPercent = true;
      baseOpts.showValue = false;
      baseOpts.dataLabelColor = theme.textPrimary;
      baseOpts.dataLabelFontSize = 10;
      break;

    default:
      pptxChartType = pptx.charts.BAR;
      baseOpts.barDir = 'col';
      break;
  }

  slide.addChart(pptxChartType, data, baseOpts);
}

/**
 * 生成图表配色（基于主题强调色的渐变）
 */
function generateChartColors(theme: ThemeConfig, count: number): string[] {
  const colors = [
    theme.accent,
    theme.accentGlow,
    theme.textSecondary,
    theme.cardBorder,
  ];

  // 如果需要更多颜色，循环使用
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(colors[i % colors.length]);
  }
  return result;
}
