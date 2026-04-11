// ============================================================================
// Chart Generate Tool - 生成数据图表（PNG 图片）
// 使用 QuickChart API 生成图表，无需本地依赖
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../services/infra/logger';
import { formatFileSize } from './utils';

const logger = createLogger('ChartGenerate');

// QuickChart API 配置
const QUICKCHART_API = 'https://quickchart.io/chart';

type ChartType = 'bar' | 'line' | 'pie' | 'doughnut' | 'radar' | 'polarArea' | 'scatter';

interface ChartGenerateParams {
  type: ChartType;
  title?: string;
  labels: string[];
  datasets: Array<{
    label?: string;
    data: number[];
    backgroundColor?: string | string[];
    borderColor?: string;
  }>;
  output_path?: string;
  width?: number;
  height?: number;
}

// 默认配色方案
const DEFAULT_COLORS = [
  'rgba(54, 162, 235, 0.8)',   // 蓝
  'rgba(255, 99, 132, 0.8)',   // 红
  'rgba(75, 192, 192, 0.8)',   // 青
  'rgba(255, 206, 86, 0.8)',   // 黄
  'rgba(153, 102, 255, 0.8)',  // 紫
  'rgba(255, 159, 64, 0.8)',   // 橙
  'rgba(46, 204, 113, 0.8)',   // 绿
  'rgba(142, 68, 173, 0.8)',   // 深紫
];

const DEFAULT_BORDER_COLORS = [
  'rgba(54, 162, 235, 1)',
  'rgba(255, 99, 132, 1)',
  'rgba(75, 192, 192, 1)',
  'rgba(255, 206, 86, 1)',
  'rgba(153, 102, 255, 1)',
  'rgba(255, 159, 64, 1)',
  'rgba(46, 204, 113, 1)',
  'rgba(142, 68, 173, 1)',
];

export const chartGenerateTool: Tool = {
  name: 'chart_generate',
  description: `生成数据图表（PNG 图片）。

支持的图表类型：
- bar: 柱状图
- line: 折线图
- pie: 饼图
- doughnut: 环形图
- radar: 雷达图
- polarArea: 极坐标图
- scatter: 散点图

**使用示例：**

柱状图：
\`\`\`
chart_generate {
  "type": "bar",
  "title": "月度销售额",
  "labels": ["1月", "2月", "3月", "4月"],
  "datasets": [{"label": "销售额", "data": [120, 190, 300, 250]}]
}
\`\`\`

饼图：
\`\`\`
chart_generate {
  "type": "pie",
  "title": "市场份额",
  "labels": ["产品A", "产品B", "产品C"],
  "datasets": [{"data": [40, 35, 25]}]
}
\`\`\`

多数据系列折线图：
\`\`\`
chart_generate {
  "type": "line",
  "title": "趋势对比",
  "labels": ["Q1", "Q2", "Q3", "Q4"],
  "datasets": [
    {"label": "2023", "data": [100, 120, 140, 160]},
    {"label": "2024", "data": [110, 150, 180, 200]}
  ]
}
\`\`\``,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'scatter'],
        description: '图表类型',
      },
      title: {
        type: 'string',
        description: '图表标题',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'X 轴标签或分类名称',
      },
      datasets: {
        type: 'array',
        description: '数据系列数组',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 工作目录下的 chart-{timestamp}.png）',
      },
      width: {
        type: 'number',
        description: '图表宽度（默认: 800）',
        default: 800,
      },
      height: {
        type: 'number',
        description: '图表高度（默认: 600）',
        default: 600,
      },
    },
    required: ['type', 'labels', 'datasets'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      type,
      title,
      labels,
      datasets,
      output_path,
      width = 800,
      height = 600,
    } = params as unknown as ChartGenerateParams;

    try {
      // 为数据集添加默认颜色
      const coloredDatasets = datasets.map((ds, idx) => {
        const isPieType = ['pie', 'doughnut', 'polarArea'].includes(type);

        return {
          ...ds,
          backgroundColor: ds.backgroundColor || (isPieType
            ? DEFAULT_COLORS.slice(0, ds.data.length)
            : DEFAULT_COLORS[idx % DEFAULT_COLORS.length]),
          borderColor: ds.borderColor || (isPieType
            ? DEFAULT_BORDER_COLORS.slice(0, ds.data.length)
            : DEFAULT_BORDER_COLORS[idx % DEFAULT_BORDER_COLORS.length]),
          borderWidth: 2,
        };
      });

      // 构建 Chart.js 配置
      const chartConfig = {
        type,
        data: {
          labels,
          datasets: coloredDatasets,
        },
        options: {
          responsive: true,
          plugins: {
            title: title ? {
              display: true,
              text: title,
              font: { size: 18, weight: 'bold' },
            } : undefined,
            legend: {
              display: datasets.length > 1 || ['pie', 'doughnut', 'polarArea'].includes(type),
              position: 'bottom',
            },
          },
          scales: ['pie', 'doughnut', 'polarArea', 'radar'].includes(type) ? undefined : {
            y: { beginAtZero: true },
          },
        },
      };

      // 调用 QuickChart API
      const chartUrl = `${QUICKCHART_API}?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=${width}&h=${height}&bkg=white`;

      context.emit?.('tool_output', {
        tool: 'chart_generate',
        message: `📊 正在生成${type}图表...`,
      });

      const response = await fetch(chartUrl);

      if (!response.ok) {
        throw new Error(`QuickChart API 错误: ${response.status}`);
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer());

      // 确定输出路径
      const timestamp = Date.now();
      const fileName = `chart-${timestamp}.png`;
      const outputDir = output_path
        ? path.dirname(output_path)
        : context.workingDirectory;
      const finalPath = output_path || path.join(outputDir, fileName);

      // 确保目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 保存文件
      fs.writeFileSync(finalPath, imageBuffer);

      const stats = fs.statSync(finalPath);

      logger.info('Chart generated', { type, path: finalPath });

      // Build renderSpec matching ChartBlock's ChartSpec format for inline preview
      const isPieType = ['pie', 'doughnut', 'polarArea'].includes(type);
      const renderSpec: Record<string, unknown> = {
        type: type === 'doughnut' || type === 'polarArea' ? 'pie' : type,
        title: title,
      };

      if (isPieType) {
        // Pie charts use { name, value } format
        renderSpec.data = labels.map((label, i) => ({
          name: label,
          value: datasets[0]?.data[i] ?? 0,
        }));
      } else {
        // Non-pie charts use xKey + series format
        renderSpec.xKey = 'label';
        renderSpec.data = labels.map((label, i) => {
          const row: Record<string, unknown> = { label };
          datasets.forEach(ds => {
            row[ds.label || 'value'] = ds.data[i];
          });
          return row;
        });
        renderSpec.series = datasets.map(ds => ({
          key: ds.label || 'value',
          name: ds.label || 'Value',
        }));
      }

      return {
        success: true,
        output: `✅ 图表已生成！

📊 类型: ${type}
📄 文件: ${finalPath}
📦 大小: ${formatFileSize(stats.size)}

点击上方路径可直接打开。`,
        metadata: {
          filePath: finalPath,
          fileName: path.basename(finalPath),
          fileSize: stats.size,
          chartType: type,
          renderSpec,
          attachment: {
            id: `chart-${timestamp}`,
            type: 'file',
            category: 'image',
            name: path.basename(finalPath),
            path: finalPath,
            size: stats.size,
            mimeType: 'image/png',
          },
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Chart generation failed', { error: message });
      return {
        success: false,
        error: `图表生成失败: ${message}`,
      };
    }
  },
};
