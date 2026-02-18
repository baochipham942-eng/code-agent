// ============================================================================
// PPT 数据分析器 - 将数据转化为演示文稿内容
// ============================================================================

import type { SlideData, ChartType } from './types';
import type { DataSourceResult, DataInsight } from './dataSourceAdapter';

/**
 * Analyze data and generate presentation slides
 *
 * Converts a DataSourceResult into an array of SlideData:
 * - Summary slide with key metrics
 * - Stats cards for numeric highlights
 * - Chart slides for visual data
 * - Detail slides for categories
 *
 * @param data - Loaded data source
 * @param topic - Presentation topic/title
 * @returns Array of SlideData ready for PPT generation
 */
export function analyzeDataForPresentation(
  data: DataSourceResult,
  topic: string,
): SlideData[] {
  const slides: SlideData[] = [];

  // 1. Title slide
  slides.push({
    title: topic,
    subtitle: `基于 ${data.metadata.fileName} 的数据分析报告`,
    points: [],
    isTitle: true,
  });

  // 2. Data overview slide
  slides.push({
    title: '数据概览',
    points: [
      `数据来源: ${data.metadata.fileName}${data.metadata.sheetName ? ` (${data.metadata.sheetName})` : ''}`,
      `数据规模: ${data.metadata.rowCount} 条记录, ${data.metadata.columnCount} 个字段`,
      `字段列表: ${data.columns.slice(0, 6).join(', ')}${data.columns.length > 6 ? ' ...' : ''}`,
      `分析维度: ${data.insights.length} 个自动洞察`,
    ],
  });

  // 3. Generate slides from insights
  for (const insight of data.insights) {
    const slide = insightToSlide(insight, data);
    if (slide) slides.push(slide);
  }

  // 4. If we have numeric data, generate stats highlights
  const numericInsight = data.insights.find(i => i.type === 'distribution' && i.data);
  if (numericInsight?.data) {
    slides.push({
      title: '关键指标',
      points: numericInsight.data.labels.map((label, i) =>
        `${label}: ${formatNumber(numericInsight.data!.values[i])}`
      ),
    });
  }

  // 5. Top records detail slide
  if (data.rows.length >= 3 && data.columns.length >= 2) {
    const topRows = data.rows.slice(0, 5);
    slides.push({
      title: '数据明细 (Top 5)',
      points: topRows.map(row =>
        data.columns.slice(0, 4).map((col, i) => `${col}: ${row[i] || '-'}`).join(' | ')
      ),
      table: {
        headers: data.columns.slice(0, 6),
        rows: topRows.map(r => r.slice(0, 6)),
      },
    });
  }

  // 6. End slide
  slides.push({
    title: '谢谢观看',
    points: [],
    isEnd: true,
  });

  return slides;
}

/**
 * Convert a data insight into a slide
 */
function insightToSlide(insight: DataInsight, data: DataSourceResult): SlideData | null {
  switch (insight.type) {
    case 'summary':
      // Summary is already covered in the overview slide
      return null;

    case 'top_values':
      if (!insight.data) return null;
      return {
        title: insight.title,
        points: insight.data.labels.map((label, i) =>
          `${label}: ${formatNumber(insight.data!.values[i])}`
        ),
      };

    case 'trend':
      if (!insight.data) return null;
      return {
        title: insight.title,
        points: [
          insight.description,
          ...insight.data.labels.slice(0, 4).map((label, i) =>
            `${label}: ${formatNumber(insight.data!.values[i])}`
          ),
        ],
      };

    case 'distribution':
      if (!insight.data) return null;
      return {
        title: insight.title,
        points: [
          insight.description,
          ...insight.data.labels.map((label, i) =>
            `${label}: ${formatNumber(insight.data!.values[i])}`
          ),
        ],
      };

    default:
      return null;
  }
}

/**
 * Suggest the best chart type for a data insight
 */
export function suggestChartType(insight: DataInsight, rowCount: number): ChartType {
  switch (insight.type) {
    case 'trend':
      return 'line';

    case 'distribution':
      return rowCount <= 6 ? 'doughnut' : 'bar';

    case 'top_values':
      return 'bar';

    default:
      return 'bar';
  }
}

/**
 * Generate chart-ready data from a DataSourceResult for a specific numeric column
 */
export function generateChartData(
  data: DataSourceResult,
  labelColumnIndex: number,
  valueColumnIndex: number,
  maxItems: number = 8,
): { labels: string[]; values: number[] } | null {
  if (labelColumnIndex >= data.columns.length || valueColumnIndex >= data.columns.length) {
    return null;
  }

  const items: { label: string; value: number }[] = [];

  for (const row of data.rows) {
    const label = row[labelColumnIndex]?.trim();
    const value = parseFloat(row[valueColumnIndex]);

    if (label && !isNaN(value)) {
      items.push({ label: label.slice(0, 20), value });
    }
  }

  if (items.length < 2) return null;

  // Sort by value descending and take top N
  items.sort((a, b) => b.value - a.value);
  const top = items.slice(0, maxItems);

  return {
    labels: top.map(i => i.label),
    values: top.map(i => i.value),
  };
}

/**
 * Format number for display
 */
function formatNumber(value: number): string {
  if (Math.abs(value) >= 1e8) {
    return (value / 1e8).toFixed(1) + ' 亿';
  }
  if (Math.abs(value) >= 1e4) {
    return (value / 1e4).toFixed(1) + ' 万';
  }
  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }
  return value.toFixed(2);
}
