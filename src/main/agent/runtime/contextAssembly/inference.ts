// ContextAssembly - Inference orchestration and model fallback.
import type { AgentEvent } from '../../../../shared/contract';
import type { ModelResponse } from '../../../agent/loopTypes';
import { getConfigService, getAuthService, getLangfuseService } from '../../../services';
import { logCollector } from '../../../mcp/logCollector.js';
import { ContextLengthExceededError } from '../../../model/modelRouter';
import { createSnapshotHandler } from '../../../session/streamSnapshot';
import {
  getCoreToolDefinitions,
  getLoadedDeferredToolDefinitions,
  getAllToolDefinitions,
} from '../../../tools/dispatch/toolDefinitions';
import { filterToolDefinitionsByWorkbenchScope } from '../../../tools/workbenchToolScope';
import {
  stripImagesFromMessages,
  extractUserRequestText,
} from '../../../agent/messageHandling/converter';
import { needsArtifactTaskBrief } from '../../../prompts/builder';
import {
  estimateModelMessageTokens,
} from '../../../context/tokenOptimizer';
import type { ModelMessage } from '../../../agent/loopTypes';
import type { StreamCallback } from '../../../model/types';
import type { ContextAssemblyCtx } from '../contextAssembly';
import { logger } from '../contextAssembly';
import {
  getArtifactRepairToolPolicy,
  isArtifactRepairWritePriority as isArtifactRepairWritePriorityForGuard,
  seedArtifactRepairGuardFromContext,
} from '../artifactRepairGuard';
import { preloadDeferredToolsForTurn } from './deferredToolPreload';

const ARTIFACT_REPAIR_RECOVERY_MAX_TOKENS = 16_384;
const ARTIFACT_REPAIR_TARGETED_EDIT_MAX_TOKENS = 32_768;
const ARTIFACT_REPAIR_COMPACT_WRITE_RETRY_MAX_TOKENS = 8_192;
const ARTIFACT_REPAIR_WRITE_MAX_TOKENS = 65_536;
const ARTIFACT_MODEL_WAIT_HEARTBEAT_MS = 15_000;

function startArtifactModelWaitProgress(
  ctx: ContextAssemblyCtx,
  options: {
    artifactRequest: boolean;
    artifactRepairActive: boolean;
    artifactRepairWritePriority: boolean;
  },
): () => void {
  if (!options.artifactRequest && !options.artifactRepairActive) {
    return () => undefined;
  }

  const startedAt = Date.now();
  const baseStep = options.artifactRepairActive
    ? options.artifactRepairWritePriority
      ? '正在写入 artifact 修复补丁...'
      : '正在分析 artifact 修复方案...'
    : '正在生成 artifact 内容...';

  ctx.runFinalizer.emitTaskProgress('generating', baseStep);
  const timer = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    ctx.runFinalizer.emitTaskProgress(
      'generating',
      `${baseStep} 已等待 ${elapsedSeconds} 秒，模型仍在处理。`,
    );
  }, ARTIFACT_MODEL_WAIT_HEARTBEAT_MS);

  return () => {
    clearInterval(timer);
  };
}

function getNetworkRetryBudget(errMsg: string, errCode: string | undefined, artifactRepairActive: boolean): number {
  if (!artifactRepairActive) return 1;

  const isSlowProviderTimeout =
    /request timeout|timeout after \d+ms|timed out/i.test(errMsg)
    || /ETIMEDOUT/i.test(errCode || '');
  if (isSlowProviderTimeout) return 1;

  const isFastConnectionFailure =
    /TLS connection|network socket disconnected|socket hang up|ECONNRESET|ECONNREFUSED|ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|bad record mac/i.test(errMsg)
    || /ECONNRESET|ECONNREFUSED/i.test(errCode || '');
  if (isFastConnectionFailure) return 2;

  return 1;
}

function isArtifactRepairMode(ctx: ContextAssemblyCtx): boolean {
  return Boolean(ctx.runtime.artifactRepairGuard?.targetFile);
}

function emitAssistantMessageDelta(
  ctx: ContextAssemblyCtx,
  path: 'content' | 'reasoning',
  text: string | undefined,
): void {
  if (!text) return;
  ctx.runtime.onEvent({
    type: 'message_delta',
    data: {
      role: 'assistant',
      path,
      op: 'append',
      text,
      turnId: ctx.runtime.currentTurnId,
      messageId: ctx.runtime.currentTurnId,
      deltaSeq: ++ctx.runtime.messageDeltaSeq,
    },
  });
}

function isArtifactRepairWritePriority(ctx: ContextAssemblyCtx): boolean {
  return isArtifactRepairWritePriorityForGuard(ctx.runtime.artifactRepairGuard);
}

function isArtifactRepairFullRewritePriority(ctx: ContextAssemblyCtx): boolean {
  return getArtifactRepairToolPolicy(ctx.runtime.artifactRepairGuard)?.fullRewritePriority ?? false;
}

function filterToolsForArtifactRepair<T extends { name: string }>(
  tools: T[],
  ctx: ContextAssemblyCtx,
): T[] {
  const policy = getArtifactRepairToolPolicy(ctx.runtime.artifactRepairGuard);
  if (!policy) return tools;
  return tools.filter((tool) => policy.allowlist.has(tool.name));
}

function dedupeToolDefinitions<T extends { name: string }>(tools: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  const duplicates: string[] = [];

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      duplicates.push(tool.name);
      continue;
    }
    seen.add(tool.name);
    deduped.push(tool);
  }

  if (duplicates.length > 0) {
    logger.warn('[AgentLoop] Deduped duplicate tool definitions', {
      duplicateNames: [...new Set(duplicates)],
      before: tools.length,
      after: deduped.length,
    });
  }

  return deduped;
}

function capArtifactRepairMaxTokens(
  ctx: ContextAssemblyCtx,
  config: typeof ctx.runtime.modelConfig,
): typeof ctx.runtime.modelConfig {
  if (!ctx.runtime.artifactRepairGuard) return config;
  const currentMaxTokens = config.maxTokens;
  if (typeof currentMaxTokens !== 'number') return config;

  const cap = isArtifactRepairFullRewritePriority(ctx)
    ? ARTIFACT_REPAIR_WRITE_MAX_TOKENS
    : isArtifactRepairWritePriority(ctx)
      ? ARTIFACT_REPAIR_TARGETED_EDIT_MAX_TOKENS
      : ARTIFACT_REPAIR_RECOVERY_MAX_TOKENS;
  if (currentMaxTokens <= cap) return config;
  return {
    ...config,
    maxTokens: cap,
  };
}

function normalizeModelMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content || '');
  }
}

function truncateArtifactRepairEvidence(content: string, limit: number): string {
  if (content.length <= limit) return content;
  const head = Math.floor(limit * 0.72);
  const tail = Math.max(800, limit - head - 160);
  return [
    content.slice(0, head),
    `\n...[compact artifact repair retry omitted ${content.length - head - tail} chars]...\n`,
    content.slice(-tail),
  ].join('');
}

function buildCompactArtifactRepairWriteRetryMessages(
  ctx: ContextAssemblyCtx,
  messages: ModelMessage[],
  errorMessage: string,
): ModelMessage[] {
  const guard = ctx.runtime.artifactRepairGuard;
  const targetFile = guard?.targetFile || 'target artifact';
  const fullRewriteAllowed = getArtifactRepairToolPolicy(guard)?.writeAllowed ?? false;
  const activeIssueCodes = guard?.activeIssueCodes?.length
    ? guard.activeIssueCodes.join(', ')
    : 'unknown';

  const systemMessage: ModelMessage = {
    role: 'system',
    content: [
      '<artifact-repair-compact-write-retry>',
      'The previous artifact repair write-priority inference timed out before emitting a patch.',
      `Timeout: ${errorMessage.split('\n')[0]?.slice(0, 240) || 'provider timeout'}`,
      `Target file: ${targetFile}`,
      `Active issue codes: ${activeIssueCodes}`,
      fullRewriteAllowed
        ? 'Available action: call exactly one mutation tool. Prefer Edit when it is safe; Write is allowed only for one complete self-contained HTML artifact. Do not call Read, Bash, Task, or validator tools.'
        : 'Available action: call exactly one mutation tool, preferably Edit. Do not call Read, Bash, Write, Task, or validator tools.',
      'Use the target evidence below. If replacing an interactive test contract, a short old_text anchor around `window.__GAME_TEST__ = {` or `window.__INTERACTIVE_TEST__ = {` is acceptable; the runtime can expand the anchor to the balanced contract region.',
      'For malformed_test_contract, replace the full active test-contract region in one balanced Edit and remove duplicate orphaned start/reset/snapshot/step/runSmokeTest methods after the contract closes.',
      'Contract shape: assign exactly one direct plain object literal, `window.__GAME_TEST__ = { start() { ... }, reset(levelOrScenario) { ... }, snapshot() { return {...}; }, step(inputState = {}, frames = 1) { ...; return this.snapshot(); }, runSmokeTest() { return { passed, checks, failures, coverage }; } };`, or the same shape on `window.__INTERACTIVE_TEST__`.',
      'Do not put the contract in comments, a wrapper function, class, IIFE/factory, Object.assign, or separate top-level function shells. Avoid comments inside the active contract block and remove orphaned method tails.',
      'For mobile canvas failures, constrain both width and height with responsive CSS on the canvas or wrapper. A 390px mobile viewport must show the full playfield and HUD; do not rely on fixed 800px/900px widths or max-height:100vh with width:auto alone.',
      'The patch must remove direct ability/reward grants, test-mode auto collection/progression, and coverage based only on existence/registration. Prove gameplay through before/after snapshot changes driven by step/input.',
      '</artifact-repair-compact-write-retry>',
    ].join('\n'),
  };

  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const evidenceCandidates = messages
    .filter((message) => {
      if (message.role !== 'tool' && message.role !== 'system') return false;
      const content = normalizeModelMessageContent(message.content);
      return /artifact-repair|artifact-validation|window\.__(?:GAME|INTERACTIVE)_TEST__|runSmokeTest|function\s+update|Treat collection|Door check|Stomp from above/i.test(content);
    })
    .slice(-5);

  const evidenceMessages: ModelMessage[] = [];
  let usedChars = 0;
  for (const message of evidenceCandidates) {
    const content = normalizeModelMessageContent(message.content);
    const remaining = Math.max(1_200, 10_000 - usedChars);
    if (usedChars >= 10_000) break;
    const compact = truncateArtifactRepairEvidence(content, Math.min(3_500, remaining));
    usedChars += compact.length;
    evidenceMessages.push({
      role: message.role,
      content: compact,
    } as ModelMessage);
  }

  return [
    systemMessage,
    ...(lastUser ? [{ role: 'user', content: truncateArtifactRepairEvidence(normalizeModelMessageContent(lastUser.content), 1_200) } as ModelMessage] : []),
    ...evidenceMessages,
  ];
}

export async function inference(ctx: ContextAssemblyCtx): Promise<ModelResponse> {
  seedArtifactRepairGuardFromContext(ctx.runtime);

  // 根据配置决定使用全量工具还是核心+延迟工具
  let tools;
  if (ctx.runtime.enableToolDeferredLoading) {
    preloadDeferredToolsForTurn(ctx.runtime);
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

  tools = filterToolDefinitionsByWorkbenchScope(tools, ctx.runtime.toolScope);
  if (isArtifactRepairMode(ctx)) {
    const before = tools.length;
    const blockedToolCount = ctx.runtime.artifactRepairGuard?.blockedToolCount ?? 0;
    tools = filterToolsForArtifactRepair(tools, ctx);
    logger.info(
      `[AgentLoop] Artifact repair mode: tool list narrowed ${before} -> ${tools.length} (blockedToolCount=${blockedToolCount})`,
    );
  }
  tools = dedupeToolDefinitions(tools);

  let modelMessages: ModelMessage[] = [];
  let effectiveTools = tools;
  let effectiveConfig = ctx.runtime.modelConfig;
  let artifactRequest = false;

  modelMessages = await ctx.buildModelMessages();
  if (ctx.runtime.forceFinalResponsePrompt) {
    modelMessages = [
      ...modelMessages,
      {
        role: 'system',
        content: ctx.runtime.forceFinalResponsePrompt,
      },
    ];
  }
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

  const artifactRepairWritePriority = isArtifactRepairWritePriority(ctx);
  const artifactRepairFullRewritePriority = isArtifactRepairFullRewritePriority(ctx);
  let requestConfigForRetry: typeof ctx.runtime.modelConfig = effectiveConfig;

  try {
    // Capability detection and model fallback
    effectiveConfig = ctx.runtime.modelConfig;
    const lastUserMessage = modelMessages.filter(m => m.role === 'user').pop();
    const currentTurnMessages = lastUserMessage ? [lastUserMessage] : [];
    const requiredCapabilities = ctx.runtime.modelRouter.detectRequiredCapabilities(currentTurnMessages);
    let needsVisionFallback = false;
    let visionFallbackSucceeded = false;

    const userRequestText = extractUserRequestText(lastUserMessage);
    artifactRequest = needsArtifactTaskBrief(userRequestText);
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

            const fallbackApiKey = configService.getApiKey(fallbackConfig.provider)
              || fallbackConfig.apiKey;
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): msg.content 已 narrow 成 array，但元素类型未细化为 ContentBlock 联合（text|image_url|tool_use 等）
          Array.isArray(msg.content) && msg.content.some((c: any) => c.type === 'image')
        );
        if (hasImages) {
          logger.warn('[AgentLoop] 主模型不支持视觉，但历史消息中包含图片，移除图片避免 API 错误');
          modelMessages = stripImagesFromMessages(modelMessages);
        }
      }
    }

    effectiveTools = tools;
    if (ctx.runtime.forceFinalResponseReason) {
      effectiveTools = [];
      logger.warn('[AgentLoop] Force-final-response active; tool list disabled', {
        reason: ctx.runtime.forceFinalResponseReason,
      });
    }
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

    const streamCallback: StreamCallback = (chunk) => {
      if (typeof chunk === 'string') {
        ctx.runtime.lastStreamedContent += chunk;
        emitAssistantMessageDelta(ctx, 'content', chunk);
      } else if (chunk.type === 'text') {
        ctx.runtime.lastStreamedContent += chunk.content;
        emitAssistantMessageDelta(ctx, 'content', chunk.content);
      } else if (chunk.type === 'reasoning') {
        // 推理模型的思考过程 (glm-4.7 等)
        emitAssistantMessageDelta(ctx, 'reasoning', chunk.content);
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
    };

    const requestConfig = capArtifactRepairMaxTokens(ctx, effectiveConfig);
    requestConfigForRetry = requestConfig;
    const stopArtifactProgress = startArtifactModelWaitProgress(ctx, {
      artifactRequest,
      artifactRepairActive: Boolean(ctx.runtime.artifactRepairGuard),
      artifactRepairWritePriority,
    });
    let response: ModelResponse;
    try {
      response = await ctx.runtime.modelRouter.inference(
        modelMessages,
        effectiveTools,
        requestConfig,
        streamCallback,
        ctx.runtime.abortController.signal,
        {
          onSnapshot: createSnapshotHandler(
            ctx.runtime.sessionId,
            ctx.runtime.currentTurnId,
            ctx.runtime.workingDirectory,
          ),
          artifactRepairActive: Boolean(ctx.runtime.artifactRepairGuard),
          artifactRepairWritePriority,
          artifactRepairFullRewritePriority,
        },
      );
    } finally {
      stopArtifactProgress();
    }
    response.runtimeDiagnostics = {
      ...response.runtimeDiagnostics,
      visibleToolNames: effectiveTools.map((tool) => tool.name),
      artifactRepairGuard: ctx.runtime.artifactRepairGuard
        ? {
            targetFile: ctx.runtime.artifactRepairGuard.targetFile,
            attempts: ctx.runtime.artifactRepairGuard.attempts,
            phase: ctx.runtime.artifactRepairGuard.phase,
            blockedToolCount: ctx.runtime.artifactRepairGuard.blockedToolCount,
            targetReadCount: ctx.runtime.artifactRepairGuard.targetReadCount,
            targetRangedReadCount: ctx.runtime.artifactRepairGuard.targetRangedReadCount,
            patched: ctx.runtime.artifactRepairGuard.patched,
            noOpPatchCount: ctx.runtime.artifactRepairGuard.noOpPatchCount,
            editAnchorFailureCount: ctx.runtime.artifactRepairGuard.editAnchorFailureCount,
            preferTargetedEdit: ctx.runtime.artifactRepairGuard.preferTargetedEdit,
            activeIssueCodes: ctx.runtime.artifactRepairGuard.activeIssueCodes,
        }
        : undefined,
    };

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): ModelResponse.toolCalls 类型 ToolCall[] 已存在，但这里访问 .arguments 字段时 narrow 失效；应直接用 ToolCall 类型，不需要 any
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

    // 网络/TLS 瞬态错误：在 agentLoop 层做有限重试（provider 层重试已耗尽后的最后兜底）
    const errMsg = error instanceof Error ? error.message : String(error);
    const errCode = (error as NodeJS.ErrnoException).code;
    const isIncompleteToolStream = /stream ended before \[DONE\] with tool calls|refusing to execute incomplete tool arguments|invalid streamed tool arguments/i.test(errMsg);
    if (isIncompleteToolStream && artifactRequest && !ctx.runtime._artifactNonStreamingRetried) {
      ctx.runtime._artifactNonStreamingRetried = true;
      logger.warn('[AgentLoop] Artifact tool stream ended incomplete; retrying once with non-streaming inference');
      logCollector.agent('WARN', 'Artifact tool stream incomplete; retrying non-streaming');
      ctx.runtime.onEvent({
        type: 'notification',
        data: {
          message: '生成文件时模型流中断，正在切换到更稳的非流式方式重试。',
        },
      } as AgentEvent);
      ctx.runFinalizer.emitTaskProgress('generating', '模型流中断，正在用非流式方式重试 artifact 生成...');
      try {
        const retryResult = await ctx.runtime.modelRouter.inference(
          modelMessages,
          effectiveTools,
          effectiveConfig,
          undefined,
          undefined,
          { forceNonStreaming: true, disableProviderTransientRetry: true },
        );
        ctx.runtime._artifactNonStreamingRetried = false;
        return retryResult;
      } catch (retryErr) {
        ctx.runtime._artifactNonStreamingRetried = false;
        logger.error('[AgentLoop] Artifact non-streaming retry also failed:', retryErr);
      }
    }
    const isSlowProviderTimeout =
      /request timeout|timeout after \d+ms|timed out/i.test(errMsg)
      || /ETIMEDOUT/i.test(errCode || '');
    const shouldCompactRetryArtifactRepairWrite =
      Boolean(ctx.runtime.artifactRepairGuard)
      && artifactRepairWritePriority
      && isSlowProviderTimeout
      && !ctx.runtime._artifactRepairCompactWriteRetried;
    if (shouldCompactRetryArtifactRepairWrite) {
      ctx.runtime._artifactRepairCompactWriteRetried = true;
      logger.warn('[AgentLoop] Artifact repair write-priority timed out; retrying once with compact mutation-only context');
      logCollector.agent('WARN', 'Artifact repair write-priority timed out; retrying compact mutation-only context');
      ctx.runFinalizer.emitTaskProgress('generating', 'artifact 修复写入超时，正在用更小上下文重试...');
      try {
        const compactMessages = buildCompactArtifactRepairWriteRetryMessages(ctx, modelMessages, errMsg);
        const compactConfig = {
          ...requestConfigForRetry,
          maxTokens: Math.min(
            typeof requestConfigForRetry.maxTokens === 'number' ? requestConfigForRetry.maxTokens : ARTIFACT_REPAIR_COMPACT_WRITE_RETRY_MAX_TOKENS,
            ARTIFACT_REPAIR_COMPACT_WRITE_RETRY_MAX_TOKENS,
          ),
        };
        const compactAbortController = new AbortController();
        ctx.runtime.abortController = compactAbortController;
        const retryResult = await ctx.runtime.modelRouter.inference(
          compactMessages,
          effectiveTools,
          compactConfig,
          undefined,
          compactAbortController.signal,
          {
            artifactRepairActive: true,
            artifactRepairWritePriority: true,
            artifactRepairFullRewritePriority,
            forceNonStreaming: true,
            disableProviderTransientRetry: true,
            requestTimeoutMs: 90_000,
            firstByteTimeoutMs: 20_000,
            inactivityTimeoutMs: 45_000,
          },
        );
        ctx.runtime.abortController = null;
        ctx.runtime._artifactRepairCompactWriteRetried = false;
        retryResult.runtimeDiagnostics = {
          ...retryResult.runtimeDiagnostics,
          visibleToolNames: effectiveTools.map((tool) => tool.name),
          artifactRepairCompactWriteRetry: true,
          artifactRepairGuard: ctx.runtime.artifactRepairGuard
            ? {
                targetFile: ctx.runtime.artifactRepairGuard.targetFile,
                attempts: ctx.runtime.artifactRepairGuard.attempts,
                phase: ctx.runtime.artifactRepairGuard.phase,
                blockedToolCount: ctx.runtime.artifactRepairGuard.blockedToolCount,
                targetReadCount: ctx.runtime.artifactRepairGuard.targetReadCount,
                targetRangedReadCount: ctx.runtime.artifactRepairGuard.targetRangedReadCount,
                patched: ctx.runtime.artifactRepairGuard.patched,
                noOpPatchCount: ctx.runtime.artifactRepairGuard.noOpPatchCount,
                editAnchorFailureCount: ctx.runtime.artifactRepairGuard.editAnchorFailureCount,
                preferTargetedEdit: ctx.runtime.artifactRepairGuard.preferTargetedEdit,
                activeIssueCodes: ctx.runtime.artifactRepairGuard.activeIssueCodes,
              }
            : undefined,
        };
        return retryResult;
      } catch (retryErr) {
        ctx.runtime.abortController = null;
        ctx.runtime._artifactRepairCompactWriteRetried = false;
        logger.error('[AgentLoop] Compact artifact repair write retry also failed:', retryErr);
      }
    }
    const isNetworkError = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|TLS connection|ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|bad record mac|network socket disconnected|request timeout|timeout after \d+ms|timed out/i.test(errMsg)
      || /ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(errCode || '');
    const maxNetworkRetries = getNetworkRetryBudget(
      errMsg,
      errCode,
      Boolean(ctx.runtime.artifactRepairGuard),
    );
    const networkRetryCount = ctx.runtime._networkRetryCount ?? (ctx.runtime._networkRetried ? 1 : 0);
    const shouldRetryNetworkError =
      isNetworkError
      && networkRetryCount < maxNetworkRetries
      && !(ctx.runtime.artifactRepairGuard && isSlowProviderTimeout);
    if (shouldRetryNetworkError) {
      ctx.runtime._networkRetried = true;
      ctx.runtime._networkRetryCount = networkRetryCount + 1;
      logger.warn(`[AgentLoop] Network error "${errMsg}" (code=${errCode}), retrying inference (${ctx.runtime._networkRetryCount}/${maxNetworkRetries})...`);
      await new Promise(r => setTimeout(r, 2000));
      try {
        const retryResult = await ctx.inference();
        ctx.runtime._networkRetried = false;
        ctx.runtime._networkRetryCount = 0;
        return retryResult;
      } catch (retryErr) {
        if ((ctx.runtime._networkRetryCount ?? 0) >= maxNetworkRetries) {
          ctx.runtime._networkRetried = false;
          ctx.runtime._networkRetryCount = 0;
        }
        logger.error('[AgentLoop] Network retry also failed:', retryErr);
      }
    }

    throw error;
  }
}
