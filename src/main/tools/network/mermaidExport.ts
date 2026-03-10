// ============================================================================
// Mermaid Export Tool - 将 Mermaid 图表导出为 PNG/SVG
// 使用 mermaid.ink 在线服务渲染
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../services/infra/logger';

import { MERMAID_INK_API } from '../../../shared/constants';
import { formatFileSize } from './utils';

const logger = createLogger('MermaidExport');

interface MermaidExportParams {
  code: string;
  format?: 'png' | 'svg';
  output_path?: string;
  theme?: 'default' | 'dark' | 'forest' | 'neutral';
  background?: string;
  scale?: number;
}

/**
 * Base64 URL 编码（Mermaid.ink 要求）
 */
function base64UrlEncode(str: string): string {
  const base64 = Buffer.from(str).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 检测 Mermaid 图表类型
 */
function detectChartType(code: string): string {
  const firstLine = code.trim().split('\n')[0].toLowerCase();

  if (firstLine.startsWith('graph') || firstLine.startsWith('flowchart')) return '流程图';
  if (firstLine.startsWith('sequencediagram')) return '时序图';
  if (firstLine.startsWith('classDiagram')) return '类图';
  if (firstLine.startsWith('statediagram')) return '状态图';
  if (firstLine.startsWith('erdiagram')) return 'ER 图';
  if (firstLine.startsWith('gantt')) return '甘特图';
  if (firstLine.startsWith('pie')) return '饼图';
  if (firstLine.startsWith('journey')) return '用户旅程图';
  if (firstLine.startsWith('gitgraph')) return 'Git 分支图';
  if (firstLine.startsWith('mindmap')) return '思维导图';
  if (firstLine.startsWith('timeline')) return '时间线';

  return '图表';
}

export const mermaidExportTool: Tool = {
  name: 'mermaid_export',
  description: `将 Mermaid 图表代码导出为 PNG 或 SVG 图片。

支持的图表类型：
- 流程图 (graph/flowchart)
- 时序图 (sequenceDiagram)
- 类图 (classDiagram)
- 状态图 (stateDiagram)
- ER 图 (erDiagram)
- 甘特图 (gantt)
- 饼图 (pie)
- 用户旅程图 (journey)
- Git 分支图 (gitGraph)
- 思维导图 (mindmap)
- 时间线 (timeline)

**使用示例：**

流程图：
\`\`\`
mermaid_export {
  "code": "graph TD\\n    A[开始] --> B{判断}\\n    B -->|是| C[结束]\\n    B -->|否| A",
  "format": "png"
}
\`\`\`

时序图：
\`\`\`
mermaid_export {
  "code": "sequenceDiagram\\n    Alice->>Bob: Hello\\n    Bob-->>Alice: Hi!",
  "format": "svg",
  "theme": "dark"
}
\`\`\`

思维导图：
\`\`\`
mermaid_export {
  "code": "mindmap\\n  root((主题))\\n    分支1\\n      子项1\\n    分支2",
  "format": "png"
}
\`\`\``,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Mermaid 图表代码',
      },
      format: {
        type: 'string',
        enum: ['png', 'svg'],
        description: '输出格式（默认: png）',
        default: 'png',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 工作目录下的 mermaid-{timestamp}.{format}）',
      },
      theme: {
        type: 'string',
        enum: ['default', 'dark', 'forest', 'neutral'],
        description: '主题风格（默认: default）',
        default: 'default',
      },
      background: {
        type: 'string',
        description: '背景颜色（默认: transparent 透明）',
        default: 'transparent',
      },
      scale: {
        type: 'number',
        description: '缩放比例（默认: 2，仅 PNG 有效）',
        default: 2,
      },
    },
    required: ['code'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      code,
      format = 'png',
      output_path,
      theme = 'default',
      background = 'transparent',
      scale = 2,
    } = params as unknown as MermaidExportParams;

    try {
      // 检测图表类型
      const chartType = detectChartType(code);

      context.emit?.('tool_output', {
        tool: 'mermaid_export',
        message: `📊 正在渲染${chartType}...`,
      });

      // 构建 Mermaid 配置
      const mermaidConfig = {
        code,
        mermaid: {
          theme,
        },
      };

      // 编码为 Base64 URL
      const encodedConfig = base64UrlEncode(JSON.stringify(mermaidConfig));

      // 构建 URL
      // 关键：必须加 type=png 才能获得真正的透明 PNG（默认返回 JPEG）
      // 添加时间戳避免 CDN 缓存
      const cacheBuster = `_t=${Date.now()}`;
      let renderUrl: string;
      if (format === 'svg') {
        renderUrl = `${MERMAID_INK_API}/svg/${encodedConfig}?${cacheBuster}`;
      } else {
        // type=png 确保返回 RGBA PNG（支持透明）
        if (background === 'transparent') {
          renderUrl = `${MERMAID_INK_API}/img/${encodedConfig}?type=png&${cacheBuster}`;
        } else {
          renderUrl = `${MERMAID_INK_API}/img/${encodedConfig}?type=png&bgColor=${background}&${cacheBuster}`;
        }
      }

      logger.info('Mermaid render URL', { renderUrl });

      // 获取图片
      const response = await fetch(renderUrl);

      if (!response.ok) {
        // 尝试获取错误信息
        const errorText = await response.text();
        throw new Error(`渲染失败 (${response.status}): ${errorText.substring(0, 200)}`);
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer());

      // 确定输出路径
      const timestamp = Date.now();
      const fileName = `mermaid-${timestamp}.${format}`;
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

      logger.info('Mermaid exported', { chartType, format, path: finalPath });

      return {
        success: true,
        output: `✅ Mermaid 图表已导出！

📊 类型: ${chartType}
📄 格式: ${format.toUpperCase()}
🎨 主题: ${theme}
📄 文件: ${finalPath}
📦 大小: ${formatFileSize(stats.size)}

点击上方路径可直接打开。`,
        metadata: {
          filePath: finalPath,
          fileName: path.basename(finalPath),
          fileSize: stats.size,
          chartType,
          format,
          theme,
          attachment: {
            id: `mermaid-${timestamp}`,
            type: 'file',
            category: 'image',
            name: path.basename(finalPath),
            path: finalPath,
            size: stats.size,
            mimeType: format === 'svg' ? 'image/svg+xml' : 'image/png',
          },
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Mermaid export failed', { error: message });

      // 提供更友好的错误提示
      let errorMessage = message;
      if (message.includes('syntax error') || message.includes('Parse error')) {
        errorMessage = `Mermaid 语法错误，请检查图表代码。\n原始错误: ${message}`;
      }

      return {
        success: false,
        error: `Mermaid 导出失败: ${errorMessage}`,
      };
    }
  },
};
