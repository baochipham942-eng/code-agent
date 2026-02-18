// ============================================================================
// Asset Generator - 图片生成 + 图表数据自动构建
// ============================================================================
// 从 ResearchContext 提取图表数据，协调图片生成
// ============================================================================

import { createLogger } from '../../../services/infra/logger';
import type { ResearchContext, SlideAssets, ChartSlotData } from './types';
import type { StructuredSlide, ChartContent } from './slideSchemas';
import { CHART_SCALE_MAX_RATIO, CHART_MIN_DATA_POINTS, CHART_MAX_ITEMS } from './constants';

const logger = createLogger('AssetGenerator');

// ============================================================================
// Chart Data from Research
// ============================================================================

/**
 * 从研究数据中自动构建图表数据
 *
 * 分析 ResearchContext.statistics，识别可图表化的数据组：
 * - 同类指标（如多个市场规模）→ bar chart
 * - 百分比数据 → doughnut chart
 * - 时间序列数据 → line chart
 */
export function buildChartDataFromResearch(
  research: ResearchContext,
): ChartSlotData[] {
  const charts: ChartSlotData[] = [];
  const stats = research.statistics;

  if (stats.length < CHART_MIN_DATA_POINTS) return charts;

  // 尝试提取数值
  const numericStats = stats
    .map(s => ({ ...s, numValue: parseNumericValue(s.value) }))
    .filter(s => s.numValue !== null) as Array<typeof stats[number] & { numValue: number }>;

  if (numericStats.length < CHART_MIN_DATA_POINTS) return charts;

  // 检测百分比数据
  const percentStats = numericStats.filter(s => s.value.includes('%'));
  if (percentStats.length >= CHART_MIN_DATA_POINTS) {
    charts.push({
      chartType: 'doughnut',
      labels: percentStats.slice(0, CHART_MAX_ITEMS).map(s => s.label),
      values: percentStats.slice(0, CHART_MAX_ITEMS).map(s => s.numValue),
      title: '关键比例分布',
    });
  }

  // 非百分比数据 → bar chart
  const nonPercentStats = numericStats.filter(s => !s.value.includes('%'));
  if (nonPercentStats.length >= CHART_MIN_DATA_POINTS) {
    // 数量级检查：最大值/最小值比不超过阈值
    const vals = nonPercentStats.map(s => s.numValue).filter(v => v > 0);
    const maxVal = Math.max(...vals);
    const minVal = Math.min(...vals);
    if (minVal > 0 && maxVal / minVal <= CHART_SCALE_MAX_RATIO) {
      charts.push({
        chartType: 'bar',
        labels: nonPercentStats.slice(0, CHART_MAX_ITEMS).map(s => s.label),
        values: nonPercentStats.slice(0, CHART_MAX_ITEMS).map(s => s.numValue),
        title: '关键指标对比',
      });
    }
  }

  return charts;
}

/**
 * 将图表数据注入到合适的 slides 中
 *
 * 策略：
 * 1. 优先注入到 chart layout 的 slides
 * 2. 其次注入到 stats layout 的 slides（如果有 chartData 字段）
 */
export function injectChartData(
  slides: StructuredSlide[],
  chartDataList: ChartSlotData[],
): StructuredSlide[] {
  if (chartDataList.length === 0) return slides;

  let chartIdx = 0;
  return slides.map(slide => {
    if (chartIdx >= chartDataList.length) return slide;

    // chart layout 注入
    if (slide.layout === 'chart') {
      const content = slide.content as ChartContent;
      if (!content.chartData) {
        const cd = chartDataList[chartIdx++];
        return {
          ...slide,
          content: {
            ...content,
            chartData: {
              labels: cd.labels,
              values: cd.values,
              chartType: cd.chartType === 'doughnut' ? 'doughnut' : cd.chartType === 'line' ? 'line' : 'bar',
            },
          },
        };
      }
    }

    return slide;
  });
}

/**
 * 为 Slides 准备所有资产
 */
export function prepareSlideAssets(
  slides: StructuredSlide[],
  research: ResearchContext,
): SlideAssets {
  const chartDataList = buildChartDataFromResearch(research);
  const charts: SlideAssets['charts'] = [];

  // 为 chart layout 分配图表数据
  let chartIdx = 0;
  for (let i = 0; i < slides.length; i++) {
    if (slides[i].layout === 'chart' && chartIdx < chartDataList.length) {
      charts.push({ slideIndex: i, chartData: chartDataList[chartIdx++] });
    }
  }

  return {
    charts,
    images: [], // 图片生成需要异步，由调用方按需处理
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 解析统计数值字符串为数字
 * 支持：$680亿、47%、1.5万、100M 等格式
 */
function parseNumericValue(value: string): number | null {
  if (!value) return null;

  // 移除货币符号
  let cleaned = value.replace(/[$€¥￥£]/g, '').trim();

  // 提取数字部分
  const numMatch = cleaned.match(/(\d+[\d.,]*)/);
  if (!numMatch) return null;

  let num = parseFloat(numMatch[1].replace(/,/g, ''));
  if (isNaN(num)) return null;

  // 处理单位
  if (/万/.test(cleaned)) num *= 10000;
  else if (/亿/.test(cleaned)) num *= 100000000;
  else if (/[Tt]rillion/.test(cleaned)) num *= 1_000_000_000_000;
  else if (/[Bb]illion|B$/i.test(cleaned)) num *= 1_000_000_000;
  else if (/[Mm]illion|M$/i.test(cleaned)) num *= 1_000_000;
  else if (/[Kk]$/.test(cleaned)) num *= 1_000;

  return num;
}
