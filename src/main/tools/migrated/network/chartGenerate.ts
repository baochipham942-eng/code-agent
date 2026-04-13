// ============================================================================
// chart_generate (P0-6.3 Batch 7 — network: native ToolModule rewrite)
//
// 使用 QuickChart API 生成图表（PNG 图片）。无本地依赖。
// renderSpec 保留供 ChartBlock 做 inline 预览。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { QUICKCHART_API } from '../../../../shared/constants';
import { formatFileSize } from '../../network/utils';

type ChartType = 'bar' | 'line' | 'pie' | 'doughnut' | 'radar' | 'polarArea' | 'scatter';

interface ChartDataset {
  label?: string;
  data: number[];
  backgroundColor?: string | string[];
  borderColor?: string;
}

interface ChartGenerateParams {
  type: ChartType;
  title?: string;
  labels: string[];
  datasets: ChartDataset[];
  output_path?: string;
  width?: number;
  height?: number;
}

const DEFAULT_COLORS = [
  'rgba(54, 162, 235, 0.8)',
  'rgba(255, 99, 132, 0.8)',
  'rgba(75, 192, 192, 0.8)',
  'rgba(255, 206, 86, 0.8)',
  'rgba(153, 102, 255, 0.8)',
  'rgba(255, 159, 64, 0.8)',
  'rgba(46, 204, 113, 0.8)',
  'rgba(142, 68, 173, 0.8)',
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

const VALID_TYPES: ChartType[] = ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'scatter'];

const schema: ToolSchema = {
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
\`\`\``,
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
      },
      height: {
        type: 'number',
        description: '图表高度（默认: 600）',
      },
    },
    required: ['type', 'labels', 'datasets'],
  },
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};

async function executeChartGenerate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const p = args as unknown as ChartGenerateParams;
  const type = p.type;
  const title = p.title;
  const labels = p.labels;
  const datasets = p.datasets;
  const output_path = p.output_path;
  const width = p.width ?? 800;
  const height = p.height ?? 600;

  if (typeof type !== 'string' || !VALID_TYPES.includes(type)) {
    return { ok: false, error: `type must be one of: ${VALID_TYPES.join(', ')}`, code: 'INVALID_ARGS' };
  }
  if (!Array.isArray(labels)) {
    return { ok: false, error: 'labels must be an array', code: 'INVALID_ARGS' };
  }
  if (!Array.isArray(datasets) || datasets.length === 0) {
    return { ok: false, error: 'datasets must be a non-empty array', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `chart_generate:${type}` });

  try {
    const isPieType = ['pie', 'doughnut', 'polarArea'].includes(type);
    const coloredDatasets = datasets.map((ds, idx) => ({
      ...ds,
      backgroundColor: ds.backgroundColor || (isPieType
        ? DEFAULT_COLORS.slice(0, ds.data.length)
        : DEFAULT_COLORS[idx % DEFAULT_COLORS.length]),
      borderColor: ds.borderColor || (isPieType
        ? DEFAULT_BORDER_COLORS.slice(0, ds.data.length)
        : DEFAULT_BORDER_COLORS[idx % DEFAULT_BORDER_COLORS.length]),
      borderWidth: 2,
    }));

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
            display: datasets.length > 1 || isPieType,
            position: 'bottom',
          },
        },
        scales: ['pie', 'doughnut', 'polarArea', 'radar'].includes(type) ? undefined : {
          y: { beginAtZero: true },
        },
      },
    };

    const chartUrl = `${QUICKCHART_API}?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=${width}&h=${height}&bkg=white`;

    onProgress?.({ stage: 'running', detail: `正在生成${type}图表...` });

    const response = await fetch(chartUrl);
    if (!response.ok) {
      throw new Error(`QuickChart API 错误: ${response.status}`);
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());

    const timestamp = Date.now();
    const fileName = `chart-${timestamp}.png`;
    const outputDir = output_path ? path.dirname(output_path) : ctx.workingDir;
    const finalPath = output_path || path.join(outputDir, fileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(finalPath, imageBuffer);
    const stats = fs.statSync(finalPath);

    ctx.logger.info('Chart generated', { type, path: finalPath });

    // renderSpec for ChartBlock inline preview
    const renderSpec: Record<string, unknown> = {
      type: type === 'doughnut' || type === 'polarArea' ? 'pie' : type,
      title,
    };
    if (isPieType) {
      renderSpec.data = labels.map((label, i) => ({
        name: label,
        value: datasets[0]?.data[i] ?? 0,
      }));
    } else {
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

    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output: `✅ 图表已生成！

📊 类型: ${type}
📄 文件: ${finalPath}
📦 大小: ${formatFileSize(stats.size)}

点击上方路径可直接打开。`,
      meta: {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error('Chart generation failed', { error: message });
    return { ok: false, error: `图表生成失败: ${message}` };
  }
}

class ChartGenerateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeChartGenerate(args, ctx, canUseTool, onProgress);
  }
}

export const chartGenerateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ChartGenerateHandler();
  },
};
