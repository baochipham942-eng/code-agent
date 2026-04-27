// ContextAssembly - Inference orchestration and model fallback.
import type { AgentEvent } from '../../../../shared/contract';
import type { ModelResponse } from '../../../agent/loopTypes';
import { getConfigService, getAuthService, getLangfuseService } from '../../../services';
import { logCollector } from '../../../mcp/logCollector.js';
import { ContextLengthExceededError } from '../../../model/modelRouter';
import { createSnapshotHandler } from '../../../session/streamSnapshot';
import { isProtocolExposeEnabled, getPocToolDefinitions } from '../../../tools/protocolRegistry';
import {
  getCoreToolDefinitions,
  getLoadedDeferredToolDefinitions,
  getAllToolDefinitions,
} from '../../../protocol/dispatch/toolDefinitions';
import { filterToolDefinitionsByWorkbenchScope } from '../../../tools/workbenchToolScope';
import {
  stripImagesFromMessages,
  extractUserRequestText,
} from '../../../agent/messageHandling/converter';
import {
  estimateModelMessageTokens,
} from '../../../context/tokenOptimizer';
import type { ContextAssemblyCtx } from '../contextAssembly';
import { logger } from '../contextAssembly';

export async function inference(ctx: ContextAssemblyCtx): Promise<ModelResponse> {
  // 根据配置决定使用全量工具还是核心+延迟工具
  let tools;
  if (ctx.runtime.enableToolDeferredLoading) {
    // 使用核心工具 + 已加载的延迟工具
    const coreTools = getCoreToolDefinitions();
    const loadedDeferredTools = getLoadedDeferredToolDefinitions();
    tools = [...coreTools, ...loadedDeferredTools];
    logger.debug(`Tools (deferred loading): ${coreTools.length} core + ${loadedDeferredTools.length} deferred = ${tools.length} total`);
  } else {
    // 传统模式：发送所有工具
    tools = getAllToolDefinitions();
    logger.debug('Tools:', tools.map((t) => t.name));
  }

  // P0-5 B 阶段：env 命中时把 POC schema 暴露给 LLM
  // 注意：会改变 prompt cache 命中（tools 列表变了），仅 dev/eval 用
  if (isProtocolExposeEnabled()) {
    const pocDefs = getPocToolDefinitions();
    tools = [...tools, ...pocDefs];
    logger.debug(`Tools (POC exposed): +${pocDefs.length} = ${tools.length} total`);
  }

  tools = filterToolDefinitionsByWorkbenchScope(tools, ctx.runtime.toolScope);

  let modelMessages = await ctx.buildModelMessages();
  logger.debug('[AgentLoop] Model messages count:', modelMessages.length);
  logger.debug('[AgentLoop] Model config:', {
    provider: ctx.runtime.modelConfig.provider,
    model: ctx.runtime.modelConfig.model,
    hasApiKey: !!ctx.runtime.modelConfig.apiKey,
  });

  const langfuse = getLangfuseService();
  const generationId = `gen-${ctx.runtime.traceId}-${Date.now()}`;
  const startTime = new Date();

  const inputSummary = modelMessages.map(m => ({
    role: m.role,
    contentLength: m.content.length,
    contentPreview: typeof m.content === 'string' ? m.content.substring(0, 200) : '[multimodal]',
  }));

  langfuse.startGenerationInSpan(ctx.runtime.currentIterationSpanId, generationId, `LLM: ${ctx.runtime.modelConfig.model}`, {
    model: ctx.runtime.modelConfig.model,
    modelParameters: {
      provider: ctx.runtime.modelConfig.provider,
      temperature: ctx.runtime.modelConfig.temperature,
      maxTokens: ctx.runtime.modelConfig.maxTokens,
    },
    input: {
      messageCount: modelMessages.length,
      toolCount: tools.length,
      messages: inputSummary,
    },
    startTime,
  });

  try {
    // Capability detection and model fallback
    let effectiveConfig = ctx.runtime.modelConfig;
    const lastUserMessage = modelMessages.filter(m => m.role === 'user').pop();
    const currentTurnMessages = lastUserMessage ? [lastUserMessage] : [];
    const requiredCapabilities = ctx.runtime.modelRouter.detectRequiredCapabilities(currentTurnMessages);
    let needsVisionFallback = false;
    let visionFallbackSucceeded = false;

    const userRequestText = extractUserRequestText(lastUserMessage);
    const needsToolForImage = /标[注记]|画框|框[出住]|圈[出住]|矩形|annotate|mark|highlight|draw/i.test(userRequestText);

    if (needsToolForImage && requiredCapabilities.includes('vision')) {
      logger.info('[AgentLoop] 用户请求需要工具处理图片（标注/画框），跳过视觉 fallback');
      const visionIndex = requiredCapabilities.indexOf('vision');
      if (visionIndex > -1) {
        requiredCapabilities.splice(visionIndex, 1);
      }
      modelMessages = stripImagesFromMessages(modelMessages);
    }

    if (requiredCapabilities.length > 0) {
      const currentModelInfo = ctx.runtime.modelRouter.getModelInfo(
        ctx.runtime.modelConfig.provider,
        ctx.runtime.modelConfig.model
      );

      for (const capability of requiredCapabilities) {
        const hasCapability = currentModelInfo?.capabilities?.includes(capability) ||
          (capability === 'vision' && currentModelInfo?.supportsVision);

        if (!hasCapability) {
          if (capability === 'vision') {
            needsVisionFallback = true;
          }

          const fallbackConfig = ctx.runtime.modelRouter.getFallbackConfig(capability, ctx.runtime.modelConfig);
          if (fallbackConfig) {
            const configService = getConfigService();
            const authService = getAuthService();
            const currentUser = authService.getCurrentUser();
            const isAdmin = currentUser?.isAdmin === true;

            const fallbackApiKey = configService.getApiKey(fallbackConfig.provider);
            logger.info(`[Fallback] provider=${fallbackConfig.provider}, model=${fallbackConfig.model}, hasLocalKey=${!!fallbackApiKey}, isAdmin=${isAdmin}`);

            if (fallbackApiKey) {
              fallbackConfig.apiKey = fallbackApiKey;
              logger.info(`[Fallback] 使用本地 ${fallbackConfig.provider} Key 切换到 ${fallbackConfig.model}`);
              ctx.runtime.onEvent({
                type: 'model_fallback',
                data: {
                  reason: capability,
                  from: ctx.runtime.modelConfig.model,
                  to: fallbackConfig.model,
                },
              });
              effectiveConfig = fallbackConfig;
              if (capability === 'vision') {
                visionFallbackSucceeded = true;
              }
              break;
            } else if (isAdmin) {
              fallbackConfig.useCloudProxy = true;
              logger.info(`[Fallback] 本地无 ${fallbackConfig.provider} Key，管理员使用云端代理 ${fallbackConfig.model}`);
              ctx.runtime.onEvent({
                type: 'model_fallback',
                data: {
                  reason: capability,
                  from: ctx.runtime.modelConfig.model,
                  to: `${fallbackConfig.model} (云端)`,
                },
              });
              effectiveConfig = fallbackConfig;
              if (capability === 'vision') {
                visionFallbackSucceeded = true;
              }
              break;
            } else {
              logger.info(`[Fallback] 非管理员，${fallbackConfig.provider} 未配置 Key，无法切换`);
              ctx.runtime.onEvent({
                type: 'api_key_required',
                data: {
                  provider: fallbackConfig.provider,
                  capability: capability,
                  message: `需要 ${capability} 能力，但 ${fallbackConfig.provider} API Key 未配置。请在设置中配置 ${fallbackConfig.provider.toUpperCase()}_API_KEY。`,
                },
              });
            }
          }
        }
      }
    }

    if (needsVisionFallback && !visionFallbackSucceeded) {
      logger.warn('[AgentLoop] 无法使用视觉模型，将图片转换为文字描述');
      modelMessages = stripImagesFromMessages(modelMessages);
    }

    if (effectiveConfig === ctx.runtime.modelConfig) {
      const mainModelInfo = ctx.runtime.modelRouter.getModelInfo(
        ctx.runtime.modelConfig.provider,
        ctx.runtime.modelConfig.model
      );
      if (!mainModelInfo?.supportsVision) {
        const hasImages = modelMessages.some(msg =>
          Array.isArray(msg.content) && msg.content.some((c: any) => c.type === 'image')
        );
        if (hasImages) {
          logger.warn('[AgentLoop] 主模型不支持视觉，但历史消息中包含图片，移除图片避免 API 错误');
          modelMessages = stripImagesFromMessages(modelMessages);
        }
      }
    }

    let effectiveTools = tools;
    if (effectiveConfig !== ctx.runtime.modelConfig) {
      const fallbackModelInfo = ctx.runtime.modelRouter.getModelInfo(
        effectiveConfig.provider,
        effectiveConfig.model
      );
      if (fallbackModelInfo && !fallbackModelInfo.supportsTool) {
        logger.warn(`[AgentLoop] Fallback 模型 ${effectiveConfig.model} 不支持 tool calls，清空工具列表`);
        effectiveTools = [];

        const simplifiedPrompt = `你是一个图片理解助手。请仔细观察图片内容，按照用户的要求进行分析。

输出要求：
- 使用清晰、结构化的格式
- 如果用户要求识别文字(OCR)，按阅读顺序列出所有文字
- 如果用户要求描述位置，使用相对位置描述（如"左上角"、"中央"）
- 只输出分析结果，不要解释你的能力或限制`;

        if (modelMessages.length > 0 && modelMessages[0].role === 'system') {
          modelMessages[0].content = simplifiedPrompt;
          logger.info(`[AgentLoop] 简化视觉模型 system prompt (${simplifiedPrompt.length} chars)`);
        }

        ctx.runtime.onEvent({
          type: 'notification',
          data: {
            message: `视觉模型 ${effectiveConfig.model} 不支持工具调用，本次请求将仅使用纯文本回复`,
          },
        });
      }
    }

    // Apply thinking budget based on effort level
    const EFFORT_TO_BUDGET: Record<string, number> = {
      low: 2048,
      medium: 8192,
      high: 16384,
      max: 32768,
    };
    const budgetForEffort = EFFORT_TO_BUDGET[ctx.runtime.effortLevel];
    if (budgetForEffort && !effectiveConfig.thinkingBudget) {
      effectiveConfig = { ...effectiveConfig, thinkingBudget: budgetForEffort };
    }

    logger.debug('[AgentLoop] Calling modelRouter.inference()...');
    logger.debug('[AgentLoop] Effective model:', effectiveConfig.model);
    logger.debug('[AgentLoop] Effective tools count:', effectiveTools.length);

    // 创建 AbortController，支持中断/转向时立即终止 API 流
    ctx.runtime.abortController = new AbortController();

    // Reset partial content accumulator for this inference call
    ctx.runtime.lastStreamedContent = '';

    const response = await ctx.runtime.modelRouter.inference(
      modelMessages,
      effectiveTools,
      effectiveConfig,
      (chunk: any) => {
        if (typeof chunk === 'string') {
          ctx.runtime.lastStreamedContent += chunk;
          ctx.runtime.onEvent({ type: 'stream_chunk', data: { content: chunk, turnId: ctx.runtime.currentTurnId } });
        } else if (chunk.type === 'text') {
          ctx.runtime.lastStreamedContent += chunk.content;
          ctx.runtime.onEvent({ type: 'stream_chunk', data: { content: chunk.content, turnId: ctx.runtime.currentTurnId } });
        } else if (chunk.type === 'reasoning') {
          // 推理模型的思考过程 (glm-4.7 等)
          ctx.runtime.onEvent({ type: 'stream_reasoning', data: { content: chunk.content, turnId: ctx.runtime.currentTurnId } });
        } else if (chunk.type === 'tool_call_start') {
          ctx.runtime.onEvent({
            type: 'stream_tool_call_start',
            data: {
              index: chunk.toolCall?.index,
              id: chunk.toolCall?.id,
              name: chunk.toolCall?.name,
              turnId: ctx.runtime.currentTurnId,
            },
          });
        } else if (chunk.type === 'tool_call_delta') {
          ctx.runtime.onEvent({
            type: 'stream_tool_call_delta',
            data: {
              index: chunk.toolCall?.index,
              name: chunk.toolCall?.name,
              argumentsDelta: chunk.toolCall?.argumentsDelta,
              turnId: ctx.runtime.currentTurnId,
            },
          });
        } else if (chunk.type === 'usage') {
          // SSE 实时 usage 数据（API 返回的真实 token 用量）
          ctx.runtime.onEvent({
            type: 'stream_usage',
            data: {
              inputTokens: chunk.inputTokens || 0,
              outputTokens: chunk.outputTokens || 0,
              turnId: ctx.runtime.currentTurnId,
            },
          });
        } else if (chunk.type === 'token_estimate') {
          // SSE 实时 token 估算（每 500ms 基于字符数估算）
          ctx.runtime.onEvent({
            type: 'stream_token_estimate',
            data: {
              inputTokens: chunk.inputTokens || 0,
              outputTokens: chunk.outputTokens || 0,
              turnId: ctx.runtime.currentTurnId,
            },
          });
        }
      },
      ctx.runtime.abortController.signal,
      {
        onSnapshot: createSnapshotHandler(
          ctx.runtime.sessionId,
          ctx.runtime.currentTurnId,
          ctx.runtime.workingDirectory,
        ),
      },
    );

    ctx.runtime.abortController = null;
    logger.debug('[AgentLoop] Model response received:', response.type);

    // Record token usage with precise estimation
    const estimatedInputTokens = estimateModelMessageTokens(
      modelMessages.map(m => ({
        role: m.role,
        content: m.content,
      }))
    );
    const outputContent = (response.content || '') +
      (response.toolCalls?.map((tc: any) => JSON.stringify(tc.arguments || {})).join('') || '');
    const estimatedOutputTokens = estimateModelMessageTokens([
      { role: 'assistant', content: outputContent },
    ]);
    ctx.recordTokenUsage(estimatedInputTokens, estimatedOutputTokens);

    langfuse.endGeneration(generationId, {
      type: response.type,
      contentLength: response.content?.length || 0,
      toolCallCount: response.toolCalls?.length || 0,
    });

    return response;
  } catch (error) {
    ctx.runtime.abortController = null;

    // steer/interrupt 导致的 abort 不是错误，返回空文本让主循环处理
    if (ctx.runtime.needsReinference || ctx.runtime.isInterrupted || ctx.runtime.isCancelled) {
      logger.info('[AgentLoop] Inference aborted due to steer/interrupt/cancel');
      return { type: 'text', content: '' };
    }

    logger.error('[AgentLoop] Model inference error:', error);

    langfuse.endGeneration(
      generationId,
      { error: error instanceof Error ? error.message : 'Unknown error' },
      undefined,
      'ERROR',
      error instanceof Error ? error.message : 'Unknown error'
    );

    if (error instanceof ContextLengthExceededError) {
      logger.warn(`[AgentLoop] Context length exceeded: ${error.requestedTokens} > ${error.maxTokens}`);
      logCollector.agent('WARN', `Context overflow, attempting auto-recovery`);

      // 通知用户正在恢复
      ctx.runtime.onEvent({
        type: 'context_compressed',
        data: {
          savedTokens: 0,
          strategy: 'overflow_recovery',
          newMessageCount: ctx.runtime.messages.length,
        },
      } as AgentEvent);

      // 尝试自动压缩 + 重试
      try {
        await ctx.checkAndAutoCompress();

        if (!ctx.runtime._contextOverflowRetried) {
          ctx.runtime._contextOverflowRetried = true;
          const originalMaxTokens = ctx.runtime.modelConfig.maxTokens;
          ctx.runtime.modelConfig.maxTokens = Math.floor((originalMaxTokens || error.maxTokens) * 0.7);
          logger.info(`[AgentLoop] Auto-recovery: maxTokens reduced from ${originalMaxTokens} to ${ctx.runtime.modelConfig.maxTokens}`);

          try {
            return await ctx.inference();
          } finally {
            ctx.runtime._contextOverflowRetried = false;
            ctx.runtime.modelConfig.maxTokens = originalMaxTokens;
          }
        }
      } catch (recoveryError) {
        logger.error('[AgentLoop] Auto-recovery failed:', recoveryError);
      }

      // 恢复失败，回退到原行为
      ctx.runtime.onEvent({
        type: 'error',
        data: {
          code: 'CONTEXT_LENGTH_EXCEEDED',
          message: '上下文压缩后仍超限，建议新开会话。',
          suggestion: '建议新开一个会话继续对话。',
          details: {
            requested: error.requestedTokens,
            max: error.maxTokens,
            provider: error.provider,
          },
        },
      });

      ctx.runFinalizer.emitTaskProgress('failed', '上下文超限');
      return { type: 'text', content: '' };
    }

    // 网络/TLS 瞬态错误：在 agentLoop 层再重试一次（provider 层重试已耗尽后的最后兜底）
    const errMsg = error instanceof Error ? error.message : String(error);
    const errCode = (error as NodeJS.ErrnoException).code;
    const isNetworkError = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|TLS connection|network socket disconnected/i.test(errMsg)
      || /ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(errCode || '');
    if (isNetworkError && !ctx.runtime._networkRetried) {
      ctx.runtime._networkRetried = true;
      logger.warn(`[AgentLoop] Network error "${errMsg}" (code=${errCode}), retrying inference once...`);
      await new Promise(r => setTimeout(r, 2000));
      try {
        const retryResult = await ctx.inference();
        ctx.runtime._networkRetried = false;
        return retryResult;
      } catch (retryErr) {
        ctx.runtime._networkRetried = false;
        logger.error('[AgentLoop] Network retry also failed:', retryErr);
      }
    }

    throw error;
  }
}
