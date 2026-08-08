import type { ToolDefinition } from '../../../../shared/contract';
import type { AgentEvent } from '../../../../shared/contract';
import type { ModelConfig } from '../../../../shared/contract/model';
import type { MessageContent, ModelMessage } from '../../../agent/loopTypes';
import type { InferenceOptions, ModelResponse as RouterModelResponse, StreamCallback } from '../../../model/types';
import type { ContextAssemblyCtx } from './shared';
import { logger } from './shared';
import {
  classifyAndLogVisionPreflightFailure,
  logVisionPreflightExhausted,
  type VisionPreflightAttempt,
} from './inferenceProviderFallback';

type RunEngineInference = (
  ctx: ContextAssemblyCtx,
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal,
  options?: InferenceOptions,
) => Promise<RouterModelResponse>;

function messageHasImageParts(message: ModelMessage | undefined): boolean {
  return Boolean(
    message &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === 'image')
  );
}

export function contentHasImageParts(content: ModelMessage['content']): content is MessageContent[] {
  return Array.isArray(content) && content.some((part) => part.type === 'image');
}

function replaceImagesWithVisionSummary(
  messages: ModelMessage[],
  summary: string,
  visionModel: string,
): ModelMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;

    let removedImages = 0;
    const content = message.content.filter((part) => {
      if (part.type !== 'image') return true;
      removedImages += 1;
      return false;
    });

    if (removedImages === 0) return message;

    return {
      ...message,
      content: [
        ...content,
        {
          type: 'text',
          text: [
            `[视觉预处理结果]`,
            `模型: ${visionModel}`,
            `图片数量: ${removedImages}`,
            summary.trim(),
            `[/视觉预处理结果]`,
          ].join('\n'),
        },
      ],
    };
  });
}

function buildVisionPreflightMessages(
  lastUserMessage: ModelMessage,
  userRequestText: string,
): ModelMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是图片预处理器。你的输出会交给另一个主模型继续回答用户。',
        '只提炼图片里的可见事实、OCR 文字、界面元素、空间关系，以及和用户问题相关的信息。',
        '不要代替主模型完成最终回答，不要说自己无法继续操作。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: Array.isArray(lastUserMessage.content)
        ? [
            {
              type: 'text',
              text: [
                `用户原始问题：${userRequestText || '请理解图片内容'}`,
                '请把图片内容整理成给主模型使用的事实摘要。',
              ].join('\n'),
            },
            ...lastUserMessage.content,
          ]
        : lastUserMessage.content,
    },
  ];
}

export async function preflightImagesForMainModel(
  ctx: ContextAssemblyCtx,
  modelMessages: ModelMessage[],
  fallbackConfig: ModelConfig,
  userRequestText: string,
  runInference: RunEngineInference,
): Promise<ModelMessage[] | null> {
  const lastUserMessage = modelMessages.filter((message) => message.role === 'user').pop();
  if (!messageHasImageParts(lastUserMessage)) return null;
  if (!lastUserMessage) return null;

  const preflightConfig: ModelConfig = {
    ...fallbackConfig,
    maxTokens: Math.min(fallbackConfig.maxTokens || 2048, 2048),
  };

  const response = await runInference(
    ctx,
    buildVisionPreflightMessages(lastUserMessage, userRequestText),
    [],
    preflightConfig,
    undefined,
    ctx.runtime.control.runAbortController?.signal,
    { reasoningEffort: 'low' },
  );
  const summary = (response.content || response.thinking || '').trim();
  if (!summary) return null;

  return replaceImagesWithVisionSummary(modelMessages, summary, preflightConfig.model || 'vision-model');
}

export interface VisionPreflightRunResult {
  modelMessages: ModelMessage[];
  succeeded: boolean;
  hadCandidates: boolean;
  attempts: VisionPreflightAttempt[];
}

/**
 * 依次尝试每个识图候选（同 provider 优先 → 其它已配 Key 的 provider），直到某个成功
 * 读图；全部落空时（含"零候选"）落诊断日志。T7：从 inference.ts 抽出——候选循环 +
 * 逐候选失败分类是"识图预处理"自己的关注点，不是主 loop 编排该内联的细节。
 */
export async function runVisionPreflightCandidates(
  ctx: ContextAssemblyCtx,
  modelMessages: ModelMessage[],
  visionCandidates: ModelConfig[],
  userRequestText: string,
  runInference: RunEngineInference,
): Promise<VisionPreflightRunResult> {
  const hadCandidates = visionCandidates.length > 0;
  const attempts: VisionPreflightAttempt[] = [];
  for (const visionConfig of visionCandidates) {
    try {
      const preflightMessages = await preflightImagesForMainModel(
        ctx, modelMessages, visionConfig, userRequestText, runInference,
      );
      if (!preflightMessages) continue;
      logger.info(`[Fallback] 使用 ${visionConfig.provider}/${visionConfig.model} 预处理图片，继续使用主模型 ${ctx.runtime.modelConfig.model}`);
      ctx.runtime.onEvent({
        type: 'notification',
        data: { message: `已用视觉模型 ${visionConfig.model} 读取图片，继续由 ${ctx.runtime.modelConfig.model} 回答。` },
      } as AgentEvent);
      return { modelMessages: preflightMessages, succeeded: true, hadCandidates, attempts };
    } catch (error) {
      attempts.push(classifyAndLogVisionPreflightFailure(visionConfig.provider, visionConfig.model, error));
    }
  }
  logVisionPreflightExhausted(hadCandidates, attempts);
  return { modelMessages, succeeded: false, hadCandidates, attempts };
}
