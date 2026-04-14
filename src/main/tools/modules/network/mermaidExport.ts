// ============================================================================
// mermaid_export (P0-6.3 Batch 7 — network: native ToolModule rewrite)
//
// 使用 mermaid.ink 在线服务渲染 Mermaid 图表为 PNG/SVG
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
} from '../../../protocol/tools';
import { MERMAID_INK_API } from '../../../../shared/constants';
import { formatFileSize } from '../../utils/fileSize';
import { mermaidExportSchema as schema } from './mermaidExport.schema';

type MermaidFormat = 'png' | 'svg';
type MermaidTheme = 'default' | 'dark' | 'forest' | 'neutral';

interface MermaidExportParams {
  code: string;
  format?: MermaidFormat;
  output_path?: string;
  theme?: MermaidTheme;
  background?: string;
  scale?: number;
}

const VALID_FORMATS: MermaidFormat[] = ['png', 'svg'];
const VALID_THEMES: MermaidTheme[] = ['default', 'dark', 'forest', 'neutral'];

/** Base64 URL 编码（Mermaid.ink 要求） */
function base64UrlEncode(str: string): string {
  const base64 = Buffer.from(str).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 检测 Mermaid 图表类型 */
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

async function executeMermaidExport(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const p = args as unknown as MermaidExportParams;
  const code = p.code;
  const format = (p.format ?? 'png') as MermaidFormat;
  const output_path = p.output_path;
  const theme = (p.theme ?? 'default') as MermaidTheme;
  const background = p.background ?? 'transparent';
  // scale is accepted for API compatibility; mermaid.ink URL does not use it directly

  if (typeof code !== 'string' || code.length === 0) {
    return { ok: false, error: 'code is required', code: 'INVALID_ARGS' };
  }
  if (!VALID_FORMATS.includes(format)) {
    return { ok: false, error: `format must be one of: ${VALID_FORMATS.join(', ')}`, code: 'INVALID_ARGS' };
  }
  if (!VALID_THEMES.includes(theme)) {
    return { ok: false, error: `theme must be one of: ${VALID_THEMES.join(', ')}`, code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  const chartType = detectChartType(code);
  onProgress?.({ stage: 'starting', detail: `mermaid_export:${chartType}` });

  try {
    const mermaidConfig = {
      code,
      mermaid: { theme },
    };
    const encodedConfig = base64UrlEncode(JSON.stringify(mermaidConfig));

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

    ctx.logger.info('Mermaid render URL', { renderUrl });
    onProgress?.({ stage: 'running', detail: `正在渲染${chartType}...` });

    const response = await fetch(renderUrl);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`渲染失败 (${response.status}): ${errorText.substring(0, 200)}`);
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());

    const timestamp = Date.now();
    const fileName = `mermaid-${timestamp}.${format}`;
    const outputDir = output_path ? path.dirname(output_path) : ctx.workingDir;
    const finalPath = output_path || path.join(outputDir, fileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(finalPath, imageBuffer);
    const stats = fs.statSync(finalPath);

    ctx.logger.info('Mermaid exported', { chartType, format, path: finalPath });
    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output: `✅ Mermaid 图表已导出！

📊 类型: ${chartType}
📄 格式: ${format.toUpperCase()}
🎨 主题: ${theme}
📄 文件: ${finalPath}
📦 大小: ${formatFileSize(stats.size)}

点击上方路径可直接打开。`,
      meta: {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error('Mermaid export failed', { error: message });

    let errorMessage = message;
    if (message.includes('syntax error') || message.includes('Parse error')) {
      errorMessage = `Mermaid 语法错误，请检查图表代码。\n原始错误: ${message}`;
    }
    return { ok: false, error: `Mermaid 导出失败: ${errorMessage}` };
  }
}

class MermaidExportHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeMermaidExport(args, ctx, canUseTool, onProgress);
  }
}

export const mermaidExportModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new MermaidExportHandler();
  },
};
