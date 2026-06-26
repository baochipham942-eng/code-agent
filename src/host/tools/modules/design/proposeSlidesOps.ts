// ============================================================================
// ProposeSlidesOps（2b）—— agent 在设计会话生成演示稿（slides deck），落工作台预览 tab。
//
//   * 大纲 + 排版免费；illustrate=true 为内容页配图是付费路径 → **会话区**确认成本后才出图
//     （confirmGenerationCost，不弹 window.confirm / 不落画布；fail-closed 取消即不花钱）
//   * 生成 .pptx（main 侧 handleGenerateSlidesDeck，落 Downloads）→ 单向请求 renderer 打开
//     preview tab（按当前会话过滤，不抢背景会话焦点）
//   * 文档型产物不进 konva 画布、不接 ADR-027 自主信封
// ============================================================================
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { IPC_CHANNELS } from '../../../../shared/ipc';
import { AppWindow } from '../../../platform';
import { createLogger } from '../../../services/infra/logger';
import { buildSlidesOutline } from '../../../services/design/slidesGenerator';
import { estimateIllustrateCost } from '../../../services/design/slidesIllustrator';
import { imageModelById, defaultImageModelId } from '../../../../shared/constants/visualModels';
import { confirmGenerationCost } from './generationCostConfirm';
import { proposeSlidesOpsSchema as schema } from './proposeSlidesOps.schema';

const logger = createLogger('ProposeSlidesOps');

function safeOutputName(topic: string): string {
  const stem = topic.trim().slice(0, 24).replace(/[^\w一-龥-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${stem || 'slides'}-${Date.now()}.pptx`;
}

export async function executeProposeSlidesOps(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const topic = typeof args.topic === 'string' && args.topic.trim() ? args.topic.trim() : undefined;
  if (!topic) {
    return { ok: false, error: 'topic must be a non-empty string', code: 'INVALID_ARGS' };
  }
  const slidesCount = typeof args.slidesCount === 'number' && args.slidesCount > 0 ? Math.round(args.slidesCount) : undefined;
  const brief = typeof args.brief === 'string' && args.brief.trim() ? args.brief.trim() : undefined;
  const theme = typeof args.theme === 'string' && args.theme.trim() ? args.theme.trim() : undefined;
  const illustrate = args.illustrate === true;
  const maxImages = typeof args.maxImages === 'number' && args.maxImages > 0 ? Math.round(args.maxImages) : undefined;

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  // 付费配图：解析图模型 + 估成本 + 会话区确认（免费大纲路径不弹确认）。
  let imageModel: string | undefined;
  // 已确认的配图张数上限（审计 F1）：估价基于确定性大纲 buildSlidesOutline，但实际出图走
  // brief-grounded AI 大纲（workspaceSlidesExport），两者内容页分布可能不同 → 实际可配图页数
  // 可能多于估价页数，静默超过已确认成本。把它作为下游 maxImages 硬上限传下去，保证
  // 实际配图张数 ≤ 已确认张数 → 实际花费 ≤ 已确认花费（宁可少配，绝不超额）。
  let confirmedImageCount: number | undefined;
  if (illustrate) {
    const requested = typeof args.imageModel === 'string' ? imageModelById(args.imageModel) : undefined;
    imageModel = requested ? requested.id : defaultImageModelId();
    const outline = buildSlidesOutline(topic, slidesCount);
    // 成本不变量（审计 M1）：估价与实际出图须用同一模型。当前图像服务无 fallback，
    // actualModel === imageModel → estimate == actual。2a 引入图像 fallback 后，若兜底换到更贵
    // 模型，须保证实际花费不超过此处已确认的信封（否则要二次确认），不得静默超额。
    const { count, costCny } = estimateIllustrateCost(outline, imageModel, maxImages);
    if (count > 0 && costCny > 0) {
      confirmedImageCount = count;
      const confirmed = await confirmGenerationCost({
        mediaLabel: '演示稿配图',
        estCny: costCny,
        detail: `${count} 张 · ${imageModel}`,
        sessionId: ctx.sessionId,
        abortSignal: ctx.abortSignal,
      });
      if (!confirmed) {
        onProgress?.({ stage: 'completing', percent: 100 });
        return {
          ok: true,
          output: `用户未确认演示稿配图成本（预估 ¥${costCny.toFixed(2)}），已取消配图。可改用免费大纲版（illustrate=false）直接生成，或确认成本后重试。`,
        };
      }
    } else {
      imageModel = undefined; // 无可配图内容页 → 退回纯大纲，不付费
    }
  }

  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  // 生成 .pptx（main 侧；pptxgenjs 经 handler 内 require 懒加载）。
  let result: { filePath: string; slidesCount: number; costCny: number };
  try {
    const { handleGenerateSlidesDeck } = await import('../../../ipc/workspaceSlidesExport');
    result = await handleGenerateSlidesDeck({
      topic,
      slidesCount,
      theme,
      ...(brief ? { brief } : {}),
      outputName: safeOutputName(topic),
      // maxImages 取已确认张数（confirmedImageCount）作硬上限，保证实际配图 ≤ 已确认（审计 F1）。
      ...(imageModel ? { illustrate: true, imageModel, maxImages: confirmedImageCount } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'slides generation failed',
      code: 'DOMAIN_ERROR',
    };
  }

  // 单向请求 renderer 打开预览 tab（按当前会话过滤；无 renderer 则跳过，agent 仍拿到路径）。
  try {
    const mainWindow = AppWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.WORKSPACE_OPEN_PREVIEW, {
        filePath: result.filePath,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      });
    }
  } catch {
    /* 窗口已毁，预览打开是 best-effort */
  }

  logger.info('Slides deck generated', { slidesCount: result.slidesCount, costCny: result.costCny });
  onProgress?.({ stage: 'completing', percent: 100 });

  const costNote = result.costCny > 0 ? `，配图实际花费 ¥${result.costCny.toFixed(2)}` : '（纯大纲版，免费）';
  return {
    ok: true,
    output: `已生成 ${result.slidesCount} 页演示稿并在预览 tab 打开${costNote}。文件已保存到下载目录。`,
  };
}

class ProposeSlidesOpsHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeProposeSlidesOps(args, ctx, canUseTool, onProgress);
  }
}

export const proposeSlidesOpsModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ProposeSlidesOpsHandler();
  },
};
