// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const chartGenerateSchema: ToolSchema = {
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
