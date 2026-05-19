// ============================================================================
// recommend_capability — Step 7 PR 2
//
// 把 CapabilityRecommender.scanForCapability 包成 LLM 可调用工具。
//
// 设计原则：
// - 不强制 LLM 调用 — schema description 说"何时调用"让模型自主判断
// - 输出走 Markdown 渲染，meta 携带原始 Gap 数组给上层（PR 3 GapCard）消费
// - 与 ToolSearch 类似：单一职责，不二次推荐 / 不做修复
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getCapabilityRecommender, type CapabilityGap } from '../../../services/capability';
import { recommendCapabilitySchema as schema } from './recommendCapability.schema';

interface RecommendArgs {
  requiredCapability?: unknown;
  context?: unknown;
}

/** 把 CapabilityGap 列表渲染为 Markdown bullet，给 LLM 阅读用 */
export function renderGaps(
  requiredCapability: string,
  gaps: CapabilityGap[],
): string {
  if (gaps.length === 0) {
    return `**${requiredCapability}**: 未检测到缺口。当前 plugin / model / API key 满足该能力需求，可直接调用相关工具。`;
  }

  const lines: string[] = [`**${requiredCapability}** 能力缺口诊断：`, ''];
  for (const gap of gaps) {
    if (gap.type === 'plugin') {
      lines.push(`- [plugin] 本地无 plugin 声明该 capability 标签；marketplace 接入前无可推荐候选`);
    } else if (gap.type === 'model') {
      lines.push(`- [model] 当前模型注册表中没有具备 \`${gap.missing}\` 能力的候选`);
    } else if (gap.type === 'apikey') {
      lines.push(
        `- [apikey] 已有候选模型支持 \`${gap.missing}\`，但 provider \`${gap.provider}\` 未配置 API key。请在设置中配置或提示用户配置。`,
      );
    }
  }
  return lines.join('\n');
}

export async function executeRecommendCapability(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const typed = args as RecommendArgs;
  const required = typed.requiredCapability;
  if (typeof required !== 'string' || required.trim().length === 0) {
    return {
      ok: false,
      error: 'requiredCapability 参数必须是非空字符串（kebab-case capability 标签）',
      code: 'INVALID_ARGS',
    };
  }
  const requiredCapability = required.trim();

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  try {
    const recommender = getCapabilityRecommender();
    const gaps = recommender.scanForCapability(requiredCapability);

    onProgress?.({ stage: 'completing', percent: 100 });

    const output = renderGaps(requiredCapability, gaps);
    ctx.logger.info('recommend_capability done', {
      requiredCapability,
      gapCount: gaps.length,
    });

    return {
      ok: true,
      output,
      meta: {
        requiredCapability,
        gaps,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error('recommend_capability failed', { error: message });
    return {
      ok: false,
      error: `能力推荐失败: ${message}`,
      code: 'RECOMMEND_ERROR',
    };
  }
}

class RecommendCapabilityHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeRecommendCapability(args, ctx, canUseTool, onProgress);
  }
}

export const recommendCapabilityModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new RecommendCapabilityHandler();
  },
};
