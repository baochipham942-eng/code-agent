// ============================================================================
// ContextAssembly — Message building, inference, system prompt, compression, thinking
// Extracted from AgentLoop
// ============================================================================

// ============================================================================
// Agent Loop - Core event loop for AI agent execution
// Enhanced with Manus-style persistent planning hooks
// ============================================================================

import type {
  ModelConfig,
  Message,
  ToolCall,
  ToolResult,
  AgentEvent,
  AgentTaskPhase,
} from '../../../shared/contract';
import type { StructuredOutputConfig, StructuredOutputResult } from '../../agent/structuredOutput';
import type { ToolRegistryLike } from '../../tools/types';
import type { ToolExecutor } from '../../tools/toolExecutor';
import { getToolSearchService } from '../../services/toolSearch';
import { ModelRouter, ContextLengthExceededError } from '../../model/modelRouter';
import type { PlanningService } from '../../planning';
import { getConfigService, getAuthService, getLangfuseService, getBudgetService, BudgetAlertLevel, getSessionManager } from '../../services';
import { logCollector } from '../../mcp/logCollector.js';
import { generateMessageId } from '../../../shared/utils/id';
import { classifyIntent } from '../../routing/intentClassifier';
import { getTaskOrchestrator } from '../../planning/taskOrchestrator';
import { getMaxIterations } from '../../services/cloud/featureFlagService';
import { createLogger } from '../../services/infra/logger';
import { HookManager, createHookManager } from '../../hooks';
import type { BudgetEventData } from '../../../shared/contract';
import { getContextHealthService } from '../../context/contextHealthService';
import { getSystemPromptCache } from '../../telemetry/systemPromptCache';
import { DEFAULT_MODELS, MODEL_MAX_TOKENS, CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW, TOOL_PROGRESS, TOOL_TIMEOUT_THRESHOLDS } from '../../../shared/constants';
import { isProtocolExposeEnabled, getPocToolDefinitions } from '../../tools/protocolRegistry';

// Import refactored modules
import type {
  AgentLoopConfig,
  ModelResponse,
  ModelMessage,
} from '../../agent/loopTypes';
import { isParallelSafeTool, classifyToolCalls } from '../../agent/toolExecution/parallelStrategy';
import { CircuitBreaker } from '../../agent/toolExecution/circuitBreaker';
import { classifyExecutionPhase } from '../../tools/executionPhase';
import {
  formatToolCallForHistory,
  sanitizeToolResultsForHistory,
  buildMultimodalContent,
  stripImagesFromMessages,
  extractUserRequestText,
} from '../../agent/messageHandling/converter';
import {
  injectWorkingDirectoryContext,
  buildEnhancedSystemPrompt,
  buildRuntimeModeBlock,
} from '../../agent/messageHandling/contextBuilder';
import { loadMemoryIndex } from '../../lightMemory/indexLoader';
import { getRepoMap } from '../../context/repoMap';
import { CONFIG_DIR_NEW } from '../../config/configPaths';
import { buildSessionMetadataBlock } from '../../lightMemory/sessionMetadata';
import { buildRecentConversationsBlock } from '../../lightMemory/recentConversations';
import { getPromptForTask, buildDynamicPromptV2, type AgentMode } from '../../prompts/builder';
import { AntiPatternDetector } from '../../agent/antiPattern/detector';
import { cleanXmlResidues } from '../../agent/antiPattern/cleanXml';
import { GoalTracker } from '../../agent/goalTracker';
import { NudgeManager } from '../../agent/nudgeManager';
import { buildActiveAgentContext, drainCompletionNotifications } from '../../agent/activeAgentContext';
import { getSessionRecoveryService } from '../../agent/sessionRecovery';
import { getIncompleteTasks } from '../../services/planning/taskStore';
import {
  parseTodos,
  mergeTodos,
  advanceTodoStatus,
  completeCurrentAndAdvance,
  getSessionTodos,
  setSessionTodos,
  clearSessionTodos,
} from '../../agent/todoParser';
import { fileReadTracker } from '../../tools/fileReadTracker';
import { dataFingerprintStore } from '../../tools/dataFingerprint';
import { MAX_PARALLEL_TOOLS } from '../../agent/loopTypes';
import {
  compressToolResult,
  HookMessageBuffer,
  estimateModelMessageTokens,
  MessageHistoryCompressor,
  estimateTokens,
} from '../../context/tokenOptimizer';
import { AutoContextCompressor, getAutoCompressor } from '../../context/autoCompressor';
import { compactModelSummarize } from '../../context/compactModel';
import { CompressionState } from '../../context/compressionState';
import type { ProjectableMessage } from '../../context/projectionEngine';
import { getContextInterventionState } from '../../context/contextInterventionState';
import { applyInterventionsToMessages } from '../../context/contextInterventionHelpers';
import { getContextEventLedger } from '../../context/contextEventLedger';
import { getInputSanitizer } from '../../security/inputSanitizer';
import { getDiffTracker } from '../../services/diff/diffTracker';
import { getCitationService } from '../../services/citation/citationService';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import type { RuntimeContext } from './runtimeContext';
import type { RunFinalizer } from './runFinalizer';
import type { ContextInterventionSnapshot } from '../../../shared/contract/contextView';
import type { ContextEventRecord } from '../../context/contextEventLedger';

// Process-level file read cache to avoid redundant readFileSync calls
const fileCache = new Map<string, { content: string; mtime: number }>();
function cachedReadFileSync(path: string): string {
  try {
    const stat = require('fs').statSync(path);
    const cached = fileCache.get(path);
    if (cached && cached.mtime === stat.mtimeMs) return cached.content;
    const content = readFileSync(path, 'utf-8');
    fileCache.set(path, { content, mtime: stat.mtimeMs });
    return content;
  } catch {
    fileCache.delete(path);
    throw new Error(`Cannot read file: ${path}`);
  }
}

// Directory listing cache (30s TTL)
const dirCache = new Map<string, { files: string[]; ts: number }>();
function cachedReaddirSync(dir: string): string[] {
  const cached = dirCache.get(dir);
  if (cached && Date.now() - cached.ts < 30_000) return cached.files;
  const files = readdirSync(dir);
  dirCache.set(dir, { files, ts: Date.now() });
  return files;
}

function normalizePersistentSystemContextKey(content: string): string {
  return content.trim().replace(/\s+/g, ' ');
}

const logger = createLogger('AgentLoop');
const MAX_SYSTEM_PROMPT_TOKENS = 4000;
const MAX_PERSISTENT_SYSTEM_CONTEXT_TOKENS = 1200;
const MAX_PERSISTENT_SYSTEM_CONTEXT_ITEMS = 6;
const MAX_PERSISTENT_SYSTEM_CONTEXT_ITEM_TOKENS = 260;

interface ContextTranscriptEntry extends ProjectableMessage {
  originMessageId: string;
  timestamp: number;
  turnIndex: number;
  toolCallId?: string;
  toolError?: boolean;
  attachments?: Message['attachments'];
  toolCalls?: Message['toolCalls'];
  thinking?: string;
}

// Re-export types for backward compatibility
export type { AgentLoopConfig };

// ----------------------------------------------------------------------------
// Agent Loop
// ----------------------------------------------------------------------------

/**
 * Agent Loop - AI Agent 的核心执行循环
 *
 * 实现 ReAct 模式的推理-行动循环：
 * 1. 调用模型进行推理（inference）
 * 2. 解析响应（文本或工具调用）
 * 3. 执行工具（带权限检查）
 * 4. 将结果反馈给模型
 * 5. 重复直到完成或达到最大迭代次数
 */

export class ContextAssembly {
  runFinalizer!: RunFinalizer;

  constructor(protected ctx: RuntimeContext) {}

  setModules(runFinalizer: RunFinalizer): void {
    this.runFinalizer = runFinalizer;
  }

  // Convenience: emit event through context
  protected onEvent(event: AgentEvent): void {
    this.ctx.onEvent(event);
  }

  recordTokenUsage(inputTokens: number, outputTokens: number): void {
    const budgetService = getBudgetService();
    budgetService.recordUsage({
      inputTokens,
      outputTokens,
      model: this.ctx.modelConfig.model,
      provider: this.ctx.modelConfig.provider,
      timestamp: Date.now(),
    });
  }

  // --------------------------------------------------------------------------
  // Hook Methods
  // --------------------------------------------------------------------------

  async inference(): Promise<ModelResponse> {
    // 根据配置决定使用全量工具还是核心+延迟工具
    let tools;
    if (this.ctx.enableToolDeferredLoading) {
      // 使用核心工具 + 已加载的延迟工具
      const coreTools = this.ctx.toolRegistry.getCoreToolDefinitions();
      const loadedDeferredTools = this.ctx.toolRegistry.getLoadedDeferredToolDefinitions();
      tools = [...coreTools, ...loadedDeferredTools];
      logger.debug(`Tools (deferred loading): ${coreTools.length} core + ${loadedDeferredTools.length} deferred = ${tools.length} total`);
    } else {
      // 传统模式：发送所有工具
      tools = this.ctx.toolRegistry.getToolDefinitions();
      logger.debug('Tools:', tools.map((t: any) => t.name));
    }

    // P0-5 B 阶段：env 命中时把 POC schema 暴露给 LLM
    // 注意：会改变 prompt cache 命中（tools 列表变了），仅 dev/eval 用
    if (isProtocolExposeEnabled()) {
      const pocDefs = getPocToolDefinitions();
      tools = [...tools, ...pocDefs];
      logger.debug(`Tools (POC exposed): +${pocDefs.length} = ${tools.length} total`);
    }

    let modelMessages = await this.buildModelMessages();
    logger.debug('[AgentLoop] Model messages count:', modelMessages.length);
    logger.debug('[AgentLoop] Model config:', {
      provider: this.ctx.modelConfig.provider,
      model: this.ctx.modelConfig.model,
      hasApiKey: !!this.ctx.modelConfig.apiKey,
    });

    const langfuse = getLangfuseService();
    const generationId = `gen-${this.ctx.traceId}-${Date.now()}`;
    const startTime = new Date();

    const inputSummary = modelMessages.map(m => ({
      role: m.role,
      contentLength: m.content.length,
      contentPreview: typeof m.content === 'string' ? m.content.substring(0, 200) : '[multimodal]',
    }));

    langfuse.startGenerationInSpan(this.ctx.currentIterationSpanId, generationId, `LLM: ${this.ctx.modelConfig.model}`, {
      model: this.ctx.modelConfig.model,
      modelParameters: {
        provider: this.ctx.modelConfig.provider,
        temperature: this.ctx.modelConfig.temperature,
        maxTokens: this.ctx.modelConfig.maxTokens,
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
      let effectiveConfig = this.ctx.modelConfig;
      const lastUserMessage = modelMessages.filter(m => m.role === 'user').pop();
      const currentTurnMessages = lastUserMessage ? [lastUserMessage] : [];
      const requiredCapabilities = this.ctx.modelRouter.detectRequiredCapabilities(currentTurnMessages);
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
        const currentModelInfo = this.ctx.modelRouter.getModelInfo(
          this.ctx.modelConfig.provider,
          this.ctx.modelConfig.model
        );

        for (const capability of requiredCapabilities) {
          const hasCapability = currentModelInfo?.capabilities?.includes(capability) ||
            (capability === 'vision' && currentModelInfo?.supportsVision);

          if (!hasCapability) {
            if (capability === 'vision') {
              needsVisionFallback = true;
            }

            const fallbackConfig = this.ctx.modelRouter.getFallbackConfig(capability, this.ctx.modelConfig);
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
                this.ctx.onEvent({
                  type: 'model_fallback',
                  data: {
                    reason: capability,
                    from: this.ctx.modelConfig.model,
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
                this.ctx.onEvent({
                  type: 'model_fallback',
                  data: {
                    reason: capability,
                    from: this.ctx.modelConfig.model,
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
                this.ctx.onEvent({
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

      if (effectiveConfig === this.ctx.modelConfig) {
        const mainModelInfo = this.ctx.modelRouter.getModelInfo(
          this.ctx.modelConfig.provider,
          this.ctx.modelConfig.model
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
      if (effectiveConfig !== this.ctx.modelConfig) {
        const fallbackModelInfo = this.ctx.modelRouter.getModelInfo(
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

          this.ctx.onEvent({
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
      const budgetForEffort = EFFORT_TO_BUDGET[this.ctx.effortLevel];
      if (budgetForEffort && !effectiveConfig.thinkingBudget) {
        effectiveConfig = { ...effectiveConfig, thinkingBudget: budgetForEffort };
      }

      logger.debug('[AgentLoop] Calling modelRouter.inference()...');
      logger.debug('[AgentLoop] Effective model:', effectiveConfig.model);
      logger.debug('[AgentLoop] Effective tools count:', effectiveTools.length);

      // 创建 AbortController，支持中断/转向时立即终止 API 流
      this.ctx.abortController = new AbortController();

      // Reset partial content accumulator for this inference call
      this.ctx.lastStreamedContent = '';

      const response = await this.ctx.modelRouter.inference(
        modelMessages,
        effectiveTools,
        effectiveConfig,
        (chunk: any) => {
          if (typeof chunk === 'string') {
            this.ctx.lastStreamedContent += chunk;
            this.ctx.onEvent({ type: 'stream_chunk', data: { content: chunk, turnId: this.ctx.currentTurnId } });
          } else if (chunk.type === 'text') {
            this.ctx.lastStreamedContent += chunk.content;
            this.ctx.onEvent({ type: 'stream_chunk', data: { content: chunk.content, turnId: this.ctx.currentTurnId } });
          } else if (chunk.type === 'reasoning') {
            // 推理模型的思考过程 (glm-4.7 等)
            this.ctx.onEvent({ type: 'stream_reasoning', data: { content: chunk.content, turnId: this.ctx.currentTurnId } });
          } else if (chunk.type === 'tool_call_start') {
            this.ctx.onEvent({
              type: 'stream_tool_call_start',
              data: {
                index: chunk.toolCall?.index,
                id: chunk.toolCall?.id,
                name: chunk.toolCall?.name,
                turnId: this.ctx.currentTurnId,
              },
            });
          } else if (chunk.type === 'tool_call_delta') {
            this.ctx.onEvent({
              type: 'stream_tool_call_delta',
              data: {
                index: chunk.toolCall?.index,
                name: chunk.toolCall?.name,
                argumentsDelta: chunk.toolCall?.argumentsDelta,
                turnId: this.ctx.currentTurnId,
              },
            });
          } else if (chunk.type === 'usage') {
            // SSE 实时 usage 数据（API 返回的真实 token 用量）
            this.ctx.onEvent({
              type: 'stream_usage',
              data: {
                inputTokens: chunk.inputTokens || 0,
                outputTokens: chunk.outputTokens || 0,
                turnId: this.ctx.currentTurnId,
              },
            });
          } else if (chunk.type === 'token_estimate') {
            // SSE 实时 token 估算（每 500ms 基于字符数估算）
            this.ctx.onEvent({
              type: 'stream_token_estimate',
              data: {
                inputTokens: chunk.inputTokens || 0,
                outputTokens: chunk.outputTokens || 0,
                turnId: this.ctx.currentTurnId,
              },
            });
          }
        },
        this.ctx.abortController.signal
      );

      this.ctx.abortController = null;
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
      this.recordTokenUsage(estimatedInputTokens, estimatedOutputTokens);

      langfuse.endGeneration(generationId, {
        type: response.type,
        contentLength: response.content?.length || 0,
        toolCallCount: response.toolCalls?.length || 0,
      });

      return response;
    } catch (error) {
      this.ctx.abortController = null;

      // steer/interrupt 导致的 abort 不是错误，返回空文本让主循环处理
      if (this.ctx.needsReinference || this.ctx.isInterrupted || this.ctx.isCancelled) {
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
        this.ctx.onEvent({
          type: 'context_compressed',
          data: {
            savedTokens: 0,
            strategy: 'overflow_recovery',
            newMessageCount: this.ctx.messages.length,
          },
        } as AgentEvent);

        // 尝试自动压缩 + 重试
        try {
          await this.checkAndAutoCompress();

          if (!this.ctx._contextOverflowRetried) {
            this.ctx._contextOverflowRetried = true;
            const originalMaxTokens = this.ctx.modelConfig.maxTokens;
            this.ctx.modelConfig.maxTokens = Math.floor((originalMaxTokens || error.maxTokens) * 0.7);
            logger.info(`[AgentLoop] Auto-recovery: maxTokens reduced from ${originalMaxTokens} to ${this.ctx.modelConfig.maxTokens}`);

            try {
              return await this.inference();
            } finally {
              this.ctx._contextOverflowRetried = false;
              this.ctx.modelConfig.maxTokens = originalMaxTokens;
            }
          }
        } catch (recoveryError) {
          logger.error('[AgentLoop] Auto-recovery failed:', recoveryError);
        }

        // 恢复失败，回退到原行为
        this.ctx.onEvent({
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

        this.runFinalizer.emitTaskProgress('failed', '上下文超限');
        return { type: 'text', content: '' };
      }

      // 网络/TLS 瞬态错误：在 agentLoop 层再重试一次（provider 层重试已耗尽后的最后兜底）
      const errMsg = error instanceof Error ? error.message : String(error);
      const errCode = (error as NodeJS.ErrnoException).code;
      const isNetworkError = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|TLS connection|network socket disconnected/i.test(errMsg)
        || /ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(errCode || '');
      if (isNetworkError && !this.ctx._networkRetried) {
        this.ctx._networkRetried = true;
        logger.warn(`[AgentLoop] Network error "${errMsg}" (code=${errCode}), retrying inference once...`);
        await new Promise(r => setTimeout(r, 2000));
        try {
          const retryResult = await this.inference();
          this.ctx._networkRetried = false;
          return retryResult;
        } catch (retryErr) {
          this.ctx._networkRetried = false;
          logger.error('[AgentLoop] Network retry also failed:', retryErr);
        }
      }

      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Message Building
  // --------------------------------------------------------------------------

  async buildModelMessages(): Promise<ModelMessage[]> {
    this.flushHookMessageBuffer();

    const modelMessages: ModelMessage[] = [];
    const modelMessageSourceIds: string[] = [];

    // Use optimized prompt based on task complexity
    let systemPrompt = getPromptForTask();

    const genNum = 8;
    if (genNum >= 3 && !this.ctx.isSimpleTaskMode) {
      // Only enhance with RAG for non-simple tasks
      const lastUserMessage = [...this.ctx.messages].reverse().find((m: any) => m.role === 'user');
      const userQuery = lastUserMessage?.content || '';
      systemPrompt = await buildEnhancedSystemPrompt(systemPrompt, userQuery, this.ctx.isSimpleTaskMode);
    }

    systemPrompt = injectWorkingDirectoryContext(systemPrompt, this.ctx.workingDirectory, this.ctx.isDefaultWorkingDirectory);
    systemPrompt += buildRuntimeModeBlock();

    // 注入 Session Metadata（使用频率/行为模式，借鉴 ChatGPT Layer 2）
    const sessionMeta = await buildSessionMetadataBlock();
    if (sessionMeta) {
      systemPrompt += `\n\n${sessionMeta}`;
    }

    // 注入轻量记忆索引（File-as-Memory）
    const memoryIndex = await loadMemoryIndex();
    if (memoryIndex) {
      systemPrompt += `\n\n<memory_index>\n${memoryIndex}\n</memory_index>`;
    }

    // 注入 Repo Map（代码结构索引，借鉴 Aider）
    if (this.ctx.workingDirectory && !this.ctx.isSimpleTaskMode) {
      try {
        const repoMapResult = await getRepoMap({
          rootDir: this.ctx.workingDirectory,
          tokenBudget: 1500,
        });
        if (repoMapResult.text) {
          systemPrompt += `\n\n<repo_map>\n${repoMapResult.text}\n</repo_map>`;
          logger.debug(`[ContextAssembly] RepoMap injected: ${repoMapResult.fileCount} files, ${repoMapResult.symbolCount} symbols, ~${repoMapResult.estimatedTokens} tokens`);
        }
      } catch (err) {
        logger.debug(`[ContextAssembly] RepoMap skipped: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    // 注入近期对话摘要（跨会话连续性，借鉴 ChatGPT Layer 4）
    const recentConvs = await buildRecentConversationsBlock();
    if (recentConvs) {
      systemPrompt += `\n\n${recentConvs}`;
    }

    // 注入延迟工具提示
    if (this.ctx.enableToolDeferredLoading) {
      const deferredToolsSummary = this.ctx.toolRegistry.getDeferredToolsSummary();
      if (deferredToolsSummary) {
        systemPrompt += `

<deferred-tools>
除了核心工具外，以下工具可通过 ToolSearch 发现和加载。当核心工具无法完成任务时（例如需要浏览器操作、截图、PPT/Excel 生成、图片分析等），你必须先用 ToolSearch 加载对应工具。

${deferredToolsSummary}

用法：ToolSearch("browser") 搜索浏览器工具 | ToolSearch("select:Browser") 直接加载
</deferred-tools>`;
      }
    }

    // 注入活跃子代理上下文（Phase 3: 让主 Agent 感知当前 team 状态）
    const activeAgentBlock = buildActiveAgentContext();
    if (activeAgentBlock) {
      systemPrompt += activeAgentBlock;
    }

    // 注入后台 agent 完成通知（Codex-style async notifications）
    const completionNotifications = drainCompletionNotifications();
    if (completionNotifications.length > 0) {
      systemPrompt += '\n\n' + completionNotifications.join('\n');
    }

    // 拼接持久化系统上下文（任务指导、模式 reminder 等）
    // 这些信息每轮推理都需要可见，而非作为消息历史被淹没
    const persistentSystemContext = this.getBudgetedPersistentSystemContext();
    if (persistentSystemContext.length > 0) {
      systemPrompt += '\n\n' + persistentSystemContext.join('\n\n');
    }

    // Check system prompt length and warn if too long
    const systemPromptTokens = estimateTokens(systemPrompt);
    if (systemPromptTokens > MAX_SYSTEM_PROMPT_TOKENS) {
      logger.warn(`[AgentLoop] System prompt too long: ${systemPromptTokens} tokens (limit: ${MAX_SYSTEM_PROMPT_TOKENS})`);
      logCollector.agent('WARN', 'System prompt exceeds recommended limit', {
        tokens: systemPromptTokens,
        limit: MAX_SYSTEM_PROMPT_TOKENS,
      });
    }

    // Cache system prompt for eval center review + telemetry
    try {
      const hash = createHash('sha256').update(systemPrompt).digest('hex');
      this.ctx.currentSystemPromptHash = hash;
      getSystemPromptCache().store(hash, systemPrompt, systemPromptTokens, 'gen8');
    } catch {
      // Non-critical: don't break agent loop if cache fails
    }

    modelMessages.push({
      role: 'system',
      content: systemPrompt,
    });
    modelMessageSourceIds.push('__system_prompt__');

    const interventionState = getContextInterventionState();
    const effectiveInterventions = interventionState.getEffectiveSnapshot(this.ctx.sessionId, this.ctx.agentId);
    const transcriptEntries = this.buildContextTranscriptEntries(this.ctx.messages);
    const transcriptInterventions = this.mapInterventionsToTranscriptEntries(
      effectiveInterventions,
      transcriptEntries,
    );
    const excludedTranscriptIds = new Set(transcriptInterventions.excluded);
    const interventionAdjustedEntries = applyInterventionsToMessages(
      transcriptEntries.filter((entry) => !excludedTranscriptIds.has(entry.id)),
      transcriptInterventions,
      transcriptEntries,
    );

    let contextApiView = interventionAdjustedEntries;
    const contextWindowSize = CONTEXT_WINDOWS[this.ctx.modelConfig.model] || 64000;
    try {
      const nextCompressionState = new CompressionState();
      const lastActivityAt = interventionAdjustedEntries.at(-1)?.timestamp ?? Date.now();
      const idleMinutes = Math.max(0, (Date.now() - lastActivityAt) / 60_000);
      const currentTurnIndex = interventionAdjustedEntries.reduce(
        (maxTurnIndex, entry) => Math.max(maxTurnIndex, entry.turnIndex),
        0,
      );

      const pipelineResult = await this.ctx.compressionPipeline.evaluate(
        interventionAdjustedEntries.map((entry) => ({ ...entry })),
        nextCompressionState,
        {
          maxTokens: contextWindowSize,
          currentTurnIndex,
          isMainThread: !this.ctx.agentId,
          cacheHot: idleMinutes < 2,
          idleMinutes,
          summarize: (messages) => this.summarizeCollapsedContext(messages),
          enableSnip: true,
          enableMicrocompact: true,
          enableContextCollapse: true,
          toolResultBudget: 2000,
          interventions: transcriptInterventions,
        },
      );

      this.ctx.compressionState = nextCompressionState;
      contextApiView = pipelineResult.apiView as ContextTranscriptEntry[];
      const entryIdToOriginMessageId = new Map(
        interventionAdjustedEntries.map((entry) => [entry.id, entry.originMessageId]),
      );
      getContextEventLedger().upsertCompressionEvents(
        this.ctx.sessionId,
        this.ctx.agentId,
        nextCompressionState.getCommitLog(),
        (messageId) => entryIdToOriginMessageId.get(messageId) ?? messageId,
      );

      if (nextCompressionState.getCommitLog().length > 0) {
        logger.debug('[ContextAssembly] Compression pipeline applied', {
          layersTriggered: pipelineResult.layersTriggered,
          commitCount: nextCompressionState.getCommitLog().length,
          apiViewMessages: pipelineResult.apiView.length,
        });
      }
    } catch (error) {
      logger.error('[ContextAssembly] Compression pipeline evaluation failed, falling back to uncompressed transcript:', error);
      this.ctx.compressionState = new CompressionState();
    }

    logger.debug('[AgentLoop] Building model messages, total messages:', contextApiView.length);
    for (const entry of contextApiView) {
      logger.debug(` Message role=${entry.role}, hasAttachments=${!!entry.attachments?.length}, attachmentCount=${entry.attachments?.length || 0}`);

      if (entry.role === 'tool') {
        modelMessages.push({
          role: 'tool',
          content: entry.content,
          ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
          ...(entry.toolError ? { toolError: true } : {}),
        });
        modelMessageSourceIds.push(entry.originMessageId);
      } else if (entry.role === 'assistant' && entry.toolCalls?.length) {
        // 过滤掉已废弃工具的历史调用，避免模型从上下文中误判这些工具仍可用
        const REMOVED_TOOLS = new Set(['TodoWrite', 'todo_write']);
        const tcs = entry.toolCalls.filter(tc => !REMOVED_TOOLS.has(tc.name));
        if (tcs.length === 0 && !entry.content) continue;
        modelMessages.push({
          role: 'assistant',
          content: entry.content || '',
          ...(tcs.length > 0 && {
            toolCalls: tcs.map(tc => ({
              id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            })),
            toolCallText: tcs.map(tc => formatToolCallForHistory(tc)).join('\n'),
          }),
          thinking: entry.thinking,
        });
        modelMessageSourceIds.push(entry.originMessageId);
      } else if (entry.role === 'user' && entry.attachments?.length) {
        const multimodalContent = buildMultimodalContent(entry.content, entry.attachments);
        modelMessages.push({
          role: 'user',
          content: multimodalContent,
        });
        modelMessageSourceIds.push(entry.originMessageId);
      } else {
        modelMessages.push({
          role: entry.role,
          content: entry.content,
        });
        modelMessageSourceIds.push(entry.originMessageId);
      }
    }

    // Proactive compression check: trigger at 75% capacity to prevent hitting hard limits
    // 注意：maxTokens 是模型的最大输出限制，不是上下文窗口大小
    // 上下文窗口大小应该更大（如 64K-128K），这里使用保守估计 64000
    const currentTokens = estimateModelMessageTokens(modelMessages);
    if (this.ctx.messageHistoryCompressor.shouldProactivelyCompress(currentTokens, contextWindowSize)) {
      logger.info(`[AgentLoop] Proactive compression triggered: ${currentTokens}/${contextWindowSize} tokens (${Math.round(currentTokens / contextWindowSize * 100)}%)`);
      logCollector.agent('INFO', 'Proactive compression triggered', {
        currentTokens,
        maxTokens: contextWindowSize,
        usagePercent: Math.round(currentTokens / contextWindowSize * 100),
      });
    }

    return modelMessages;
  }

  private buildContextTranscriptEntries(messages: Message[]): ContextTranscriptEntry[] {
    let turnIndex = 0;
    let hasSeenUserTurn = false;
    const entries: ContextTranscriptEntry[] = [];

    for (const message of messages) {
      if (message.role === 'user' && hasSeenUserTurn) {
        turnIndex += 1;
      }
      if (message.role === 'user') {
        hasSeenUserTurn = true;
      }

      const baseEntry = {
        originMessageId: message.id,
        timestamp: message.timestamp,
        turnIndex,
      };

      if (message.role === 'tool' && message.toolResults?.length) {
        entries.push(
          ...message.toolResults.map((result, index) => ({
            ...baseEntry,
            id: `${message.id}::tool-result::${result.toolCallId || index}`,
            role: 'tool',
            content: result.output || result.error || '',
            toolCallId: result.toolCallId,
            toolError: !result.success,
          })),
        );
        continue;
      }

      entries.push({
        ...baseEntry,
        id: message.id,
        role: message.role,
        content: message.content,
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
        ...(message.thinking ? { thinking: message.thinking } : {}),
      });
    }

    return entries;
  }

  private mapInterventionsToTranscriptEntries(
    interventions: ContextInterventionSnapshot,
    entries: ContextTranscriptEntry[],
  ): ContextInterventionSnapshot {
    const entryIdsByOriginMessageId = new Map<string, string[]>();
    for (const entry of entries) {
      const entryIds = entryIdsByOriginMessageId.get(entry.originMessageId) || [];
      entryIds.push(entry.id);
      entryIdsByOriginMessageId.set(entry.originMessageId, entryIds);
    }

    const expandIds = (ids: string[]): string[] => {
      const expanded = new Set<string>();
      for (const id of ids) {
        const mappedIds = entryIdsByOriginMessageId.get(id);
        if (mappedIds && mappedIds.length > 0) {
          for (const mappedId of mappedIds) {
            expanded.add(mappedId);
          }
        } else {
          expanded.add(id);
        }
      }
      return Array.from(expanded);
    };

    return {
      pinned: expandIds(interventions.pinned),
      excluded: expandIds(interventions.excluded),
      retained: expandIds(interventions.retained),
    };
  }

  private async summarizeCollapsedContext(
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const prompt = [
      '请将下面这段运行上下文压缩成一段简洁摘要。',
      '要求：保留关键结论、文件路径、工具结果、失败原因和后续待办；不要编造；尽量控制在 200 tokens 内。',
      '',
      '上下文片段：',
      ...messages.map((message) => `[${message.role}] ${message.content}`),
    ].join('\n');

    try {
      return (await compactModelSummarize(prompt, 200)).trim();
    } catch (error) {
      logger.warn('[ContextAssembly] Context collapse summarization failed, using heuristic fallback', error);
      return messages
        .map((message) => `[${message.role}] ${message.content.replace(/\s+/g, ' ').trim()}`)
        .join(' | ')
        .slice(0, 1000);
    }
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * Inject system message with optional buffering for hook messages
   * @param content Message content
   * @param category Optional category for hook message buffering (e.g., 'pre-tool', 'post-tool')
   *                 If provided, message will be buffered and merged with other messages of same category
   */
  // --------------------------------------------------------------------------

  /**
   * Strip internal format mimicry from model's text output.
   * When models see patterns like "Ran:", "Tool results:", "[Compressed tool results:]"
   * in conversation history, they sometimes mimic these as plain text output.
   * This strips those patterns so they don't leak to the UI.
   */

  stripInternalFormatMimicry(content: string): string {
    if (!content) return content;
    let cleaned = content;
    // Remove "Ran: <command>" lines (model mimicking formatToolCallForHistory output)
    cleaned = cleaned.replace(/^Ran:\s+.+$/gm, '');
    // Remove "Tool results:" lines
    cleaned = cleaned.replace(/^Tool results:\s*$/gm, '');
    // Remove "[Compressed tool results: ...]" lines
    cleaned = cleaned.replace(/^\[Compressed tool results:.*?\]\s*$/gm, '');
    // Remove "<checkpoint-nudge ...>...</checkpoint-nudge>" blocks
    cleaned = cleaned.replace(/<checkpoint-nudge[^>]*>[\s\S]*?<\/checkpoint-nudge>/g, '');
    // Remove "<truncation-recovery>...</truncation-recovery>" blocks
    cleaned = cleaned.replace(/<truncation-recovery>[\s\S]*?<\/truncation-recovery>/g, '');
    // Collapse excessive blank lines left by removals
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
  }




  /**
   * P8: Detect task patterns and return targeted hints to reduce model variance
   */

  _detectTaskPatterns(userMessage: string): string[] {
    const hints: string[] = [];
    const msg = userMessage.toLowerCase();

    // 异常检测任务 — 防止输出全部行
    if (/异常|anomal|outlier|离群/i.test(userMessage)) {
      hints.push(
        '【异常检测】输出文件只包含被标记为异常的行，不要输出全部数据。' +
        '使用 IQR 或 Z-score 方法检测，异常标记列用数值 0/1 或布尔值（不要用中文"是"/"否"字符串）。'
      );
    }

    // 透视表 + 交叉分析 — 防止遗漏子任务
    if (/透视|pivot|交叉分析/i.test(userMessage)) {
      hints.push(
        '【透视分析】此类任务通常包含多个子任务，务必逐项完成：' +
        '① 透视表 ② 排名/Top N ③ 增长率计算 ④ 图表 ⑤ 品类/分类占比数据。' +
        '每个子任务的结果保存为独立的 sheet 或文件。完成后对照检查是否有遗漏。'
      );
    }

    // 多轮迭代任务 — 防止上下文丢失
    if (this.ctx.messages.length > 10) {
      // This is a continuation turn in a multi-round session
      hints.push(
        '【多轮任务】这是多轮迭代任务。请先用 bash ls 检查输出目录中已有的文件，' +
        '在已有文件基础上修改，不要从头重建。图表修改请先读取数据源再重新生成。'
      );
    }

    return hints;
  }

  /**
   * Inject a research-mode system prompt that forces multi-angle search planning.
   * Called when LLM intent classification detects a 'research' intent.
   */

  loadResearchSkillPrompt(): string | null {
    // Try project-level skill first, then user-level
    const candidates = [
      join(this.ctx.workingDirectory || process.cwd(), CONFIG_DIR_NEW, 'skills', 'research', 'SKILL.md'),
      join(process.env.HOME || '~', CONFIG_DIR_NEW, 'skills', 'research', 'SKILL.md'),
    ];

    for (const skillPath of candidates) {
      try {
        const content = cachedReadFileSync(skillPath);
        // Strip YAML frontmatter
        const stripped = content.replace(/^---[\s\S]*?---\n*/m, '');
        logger.info('Loaded research skill prompt', { path: skillPath });
        return stripped.trim();
      } catch {
        // continue to next candidate
      }
    }

    logger.warn('Research skill not found, using fallback prompt');
    return null;
  }

  injectResearchModePrompt(_userMessage: string): void {
    // Try loading from skill file
    const skillPrompt = this.loadResearchSkillPrompt();
    const prompt = skillPrompt || `## 研究模式已激活\n\n用户的请求需要深入调研。请制定研究计划，从多个角度搜索，使用 web_fetch 深入抓取关键结果，最终形成结构化报告。\n\n报告要求：数据标注来源编号 [S1][S2]...，区分实证数据与趋势推断，至少执行 4 次不同角度的搜索。`;

    this.pushPersistentSystemContext(prompt);

    // Engineering logic
    this.ctx._researchModeActive = true;
    this.ctx._researchIterationCount = 0;

    // Pre-load web_fetch for research mode to avoid wasting an iteration on tool_search
    try {
      const toolSearchService = getToolSearchService();
      toolSearchService.selectTool('web_fetch');
      logger.info('[ResearchMode] Pre-loaded web_fetch tool');
    } catch (error) {
      logger.debug('[ResearchMode] Could not pre-load web_fetch', { error: String(error) });
    }
    logger.info('Research mode prompt injected');
  }


  /**
   * Build a concise plan context message for model awareness.
   * Returns null if no active plan or plan is fully completed.
   */

  async buildPlanContextMessage(): Promise<string | null> {
    if (!this.ctx.planningService) return null;

    const plan = this.ctx.planningService.plan.getCurrentPlan()
      ?? await this.ctx.planningService.plan.read();
    if (!plan) return null;

    // Don't inject for fully completed plans
    if (this.ctx.planningService.plan.isComplete()) return null;

    const { completedSteps, totalSteps } = plan.metadata;
    const lines: string[] = [
      `<current-plan>`,
      `## Current Plan: ${plan.title}`,
      `Progress: ${completedSteps}/${totalSteps} steps completed`,
      ``,
    ];

    for (const phase of plan.phases) {
      for (const step of phase.steps) {
        if (step.status === 'completed') {
          lines.push(`✅ ${step.content}`);
        } else if (step.status === 'in_progress') {
          lines.push(`→ ${step.content} (CURRENT)`);
        } else if (step.status === 'skipped') {
          lines.push(`⊘ ${step.content} (skipped)`);
        } else {
          lines.push(`○ ${step.content}`);
        }
      }
    }

    lines.push(`</current-plan>`);
    return lines.join('\n');
  }

  injectSystemMessage(content: string, category?: string): void {
    const inferredCategory = category || this.inferBufferedSystemMessageCategory(content);
    if (inferredCategory) {
      // Buffer hook messages for later merging
      this.ctx.hookMessageBuffer.add(content, inferredCategory);
      return;
    }

    // Direct injection for non-hook messages
    const systemMessage: Message = {
      id: this.generateId(),
      role: 'system',
      content,
      timestamp: Date.now(),
    };
    this.ctx.messages.push(systemMessage);
    this.recordContextEventsForMessage(systemMessage);
  }

  /**
   * Flush buffered hook messages into a single system message
   * Call this at the end of each iteration to merge hook messages
   */

  flushHookMessageBuffer(): void {
    const merged = this.ctx.hookMessageBuffer.flush();
    if (merged) {
      const systemMessage: Message = {
        id: this.generateId(),
        role: 'system',
        content: merged,
        timestamp: Date.now(),
      };
      this.ctx.messages.push(systemMessage);
      this.recordContextEventsForMessage(systemMessage);
      logger.debug(`[AgentLoop] Flushed ${this.ctx.hookMessageBuffer.size} buffered hook messages`);
    }
  }

  pushPersistentSystemContext(content: string): void {
    const normalized = normalizePersistentSystemContextKey(content);
    if (!normalized) return;
    const trimmed = content.trim();

    const existingIndex = this.ctx.persistentSystemContext.findIndex(
      (item) => normalizePersistentSystemContextKey(item) === normalized,
    );
    if (existingIndex >= 0) {
      const [existing] = this.ctx.persistentSystemContext.splice(existingIndex, 1);
      this.ctx.persistentSystemContext.push(existing);
      return;
    }

    this.ctx.persistentSystemContext.push(trimmed);
    this.trimPersistentSystemContext();
  }

  private getBudgetedPersistentSystemContext(): string[] {
    const selected: string[] = [];
    let usedTokens = 0;

    for (let i = this.ctx.persistentSystemContext.length - 1; i >= 0; i--) {
      const normalized = this.ctx.persistentSystemContext[i].trim();
      if (!normalized) continue;

      const trimmed = this.truncatePersistentSystemContext(normalized, MAX_PERSISTENT_SYSTEM_CONTEXT_ITEM_TOKENS);
      const itemTokens = estimateTokens(trimmed);
      if (selected.length >= MAX_PERSISTENT_SYSTEM_CONTEXT_ITEMS) continue;
      if (usedTokens + itemTokens > MAX_PERSISTENT_SYSTEM_CONTEXT_TOKENS) continue;

      selected.unshift(trimmed);
      usedTokens += itemTokens;
    }

    return selected;
  }

  private trimPersistentSystemContext(): void {
    const selected = this.getBudgetedPersistentSystemContext();
    this.ctx.persistentSystemContext.splice(0, this.ctx.persistentSystemContext.length, ...selected);
  }

  private truncatePersistentSystemContext(content: string, maxTokens: number): string {
    const currentTokens = estimateTokens(content);
    if (currentTokens <= maxTokens) return content;

    const keepRatio = maxTokens / Math.max(currentTokens, 1);
    const keepChars = Math.max(160, Math.floor(content.length * keepRatio));
    return `${content.slice(0, keepChars).trimEnd()}\n...[truncated persistent context]...`;
  }

  private inferBufferedSystemMessageCategory(content: string): string | undefined {
    const trimmed = content.trim();
    const knownTags = [
      'user-prompt-hook',
      'session-start-hook',
      'pre-tool-hook',
      'post-tool-hook',
      'post-tool-failure-hook',
      'stop-hook',
      'truncation-recovery',
      'wrap-up',
      'seed-memory',
      'session-recovery',
      'checkpoint-nudge',
    ];

    for (const tag of knownTags) {
      if (trimmed.startsWith(`<${tag}`) && trimmed.endsWith(`</${tag}>`)) {
        return tag;
      }
    }

    return undefined;
  }

  generateId(): string {
    return generateMessageId();
  }

  getCurrentAttachments(): Array<{
    type: string;
    category?: string;
    name?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }> {
    for (let i = this.ctx.messages.length - 1; i >= 0; i--) {
      const msg = this.ctx.messages[i];
      if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
        return msg.attachments.map(att => ({
          type: att.type,
          category: att.category,
          name: att.name,
          path: att.path,
          data: att.data,
          mimeType: att.mimeType,
        }));
      }
    }
    return [];
  }

  async addAndPersistMessage(message: Message): Promise<void> {
    this.ctx.messages.push(message);
    this.recordContextEventsForMessage(message);

    if (process.env.CODE_AGENT_CLI_MODE === 'true') {
      // CLI 模式：通过回调持久化（包含 tool_results）
      if (this.ctx.persistMessage) {
        try {
          await this.ctx.persistMessage(message);
        } catch (error) {
          logger.error('Failed to persist message (CLI):', error);
        }
      }
      return;
    }

    try {
      const sessionManager = getSessionManager();
      await sessionManager.addMessage(message);
    } catch (error) {
      logger.error('Failed to persist message:', error);
    }
  }

  private recordContextEventsForMessage(message: Message): void {
    const events = this.buildContextEventsForMessage(message);
    if (events.length === 0) return;
    getContextEventLedger().upsertEvents(events);
  }

  private buildContextEventsForMessage(message: Message): ContextEventRecord[] {
    const baseEvent = {
      id: '',
      sessionId: this.ctx.sessionId,
      agentId: this.ctx.agentId,
      messageId: message.id,
      timestamp: message.timestamp || Date.now(),
    };
    const events: ContextEventRecord[] = [];

    if (message.role === 'system') {
      events.push({
        ...baseEvent,
        category: message.compaction ? 'compression_survivor' : 'system_anchor',
        action: message.compaction ? 'compressed' : 'added',
        sourceKind: message.compaction ? 'compression_survivor' : 'system_anchor',
        sourceDetail: message.compaction ? 'compaction_block' : 'system_message',
        layer: message.compaction ? 'autocompact' : undefined,
        reason: message.compaction
          ? 'Compaction block retained in message history'
          : 'System message injected into runtime context',
      });
    } else {
      events.push({
        ...baseEvent,
        category: 'recent_turn',
        action: 'added',
        sourceKind: 'message',
        sourceDetail: `${message.role}_message`,
        reason: `${message.role} message added to session history`,
      });
    }

    if ((message.attachments?.length ?? 0) > 0) {
      events.push({
        ...baseEvent,
        category: 'attachment',
        action: 'retrieved',
        sourceKind: 'attachment',
        sourceDetail: message.attachments?.map((attachment) => attachment.name).find(Boolean) || 'attachment',
        reason: 'Message includes attachment content',
      });
    }

    if ((message.toolCalls?.length ?? 0) > 0) {
      events.push({
        ...baseEvent,
        category: 'tool_result',
        action: 'retrieved',
        sourceKind: 'tool_result',
        sourceDetail: message.toolCalls?.map((toolCall) => toolCall.name).join(', ') || 'tool_call',
        layer: 'assistant_tool_call',
        reason: 'Assistant message contains tool calls',
      });
    }

    if (message.role === 'tool' || (message.toolResults?.length ?? 0) > 0) {
      events.push({
        ...baseEvent,
        category: 'tool_result',
        action: 'retrieved',
        sourceKind: 'tool_result',
        sourceDetail: message.toolResults?.map((toolResult) => toolResult.toolCallId).filter(Boolean).join(', ') || 'tool_result',
        layer: 'tool_execution',
        reason: 'Tool results captured in runtime history',
      });
    }

    return events;
  }

  updateContextHealth(): void {
    try {
      const contextHealthService = getContextHealthService();
      const model = this.ctx.modelConfig.model || DEFAULT_MODELS.chat;

      const messagesForEstimation = this.ctx.messages.map(msg => ({
        role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
        content: msg.content,
        toolResults: msg.toolResults?.map(tr => ({
          output: tr.output,
          error: tr.error,
        })),
      }));

      const health = contextHealthService.update(
        this.ctx.sessionId,
        messagesForEstimation,
        this.ctx.systemPrompt,
        model
      );

      // 更新压缩统计到健康状态
      const compressionStats = this.ctx.autoCompressor.getStats();
      if (compressionStats.compressionCount > 0 && health.compression) {
        health.compression.compressionCount = compressionStats.compressionCount;
        health.compression.totalSavedTokens = compressionStats.totalSavedTokens;
        health.compression.lastCompressionAt = compressionStats.lastCompressionAt;
      }
    } catch (error) {
      logger.error('[AgentLoop] Failed to update context health:', error);
    }
  }

  /**
   * 检查并执行自动上下文压缩。
   *
   * 常规压缩（tool-result-budget / snip / microcompact / collapse）
   * 已经在 buildModelMessages() 中统一走 CompressionPipeline。
   * 这里仅保留“超过硬阈值后生成 CompactionBlock 并替换旧历史”的重压缩出口，
   * 避免再和旧的 checkAndCompress() 平行修改消息历史。
   */

  async checkAndAutoCompress(): Promise<void> {
    try {
      // 计算当前 token 使用量
      const currentTokens = this.ctx.messages.reduce(
        (sum, msg) => sum + estimateTokens(msg.content || ''),
        0
      );

      // 检查绝对 token 阈值触发（Claude Code 风格）
      if (this.ctx.autoCompressor.shouldTriggerByTokens(currentTokens)) {
        logger.info(`[AgentLoop] Token threshold reached (${currentTokens}), triggering compaction`);

        // Emit context_compacting event (Claude Code style)
        const compactionStartTime = Date.now();
        this.ctx.onEvent({
          type: 'context_compacting',
          data: {
            tokensBefore: currentTokens,
            messagesCount: this.ctx.messages.length,
          },
        } as AgentEvent);

        const messagesForCompression = this.ctx.messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          id: msg.id,
          timestamp: msg.timestamp,
          toolCallId: msg.toolResults?.[0]?.toolCallId,      // 保留 tool↔assistant 配对
          toolCallIds: msg.toolCalls?.map(tc => tc.id),       // 保留 assistant→tool 配对
        }));

        // 生成 CompactionBlock
        const compactionResult = await this.ctx.autoCompressor.compactToBlock(
          messagesForCompression,
          this.ctx.systemPrompt,
          this.ctx.hookManager
        );

        if (compactionResult) {
          const { block } = compactionResult;

          // === 注入文件状态 + TODO 恢复上下文 ===
          let recoveryContext = '';

          const recentFiles = fileReadTracker.getRecentFiles(10);
          if (recentFiles.length > 0) {
            recoveryContext += '\n\n## 最近读取的文件\n';
            recoveryContext += recentFiles.map(f => `- ${f.path}`).join('\n');
          }

          const todos = getSessionTodos(this.ctx.sessionId);
          const pendingTodos = todos.filter(t => t.status !== 'completed');
          if (pendingTodos.length > 0) {
            recoveryContext += '\n\n## 未完成的任务\n';
            recoveryContext += pendingTodos.map(t =>
              `- [${t.status === 'in_progress' ? '进行中' : '待处理'}] ${t.content}`
            ).join('\n');
          }

          const incompleteTasks = getIncompleteTasks(this.ctx.sessionId);
          if (incompleteTasks.length > 0) {
            recoveryContext += '\n\n## 未完成的子任务\n';
            recoveryContext += incompleteTasks.map(t =>
              `- [${t.status}] ${t.subject}`
            ).join('\n');
          }

          // 注入数据指纹摘要（防止多轮对话中虚构数据）
          const dataFingerprint = dataFingerprintStore.toSummary();
          if (dataFingerprint) {
            recoveryContext += '\n\n' + dataFingerprint;
          }

          // 注入输出目录文件列表（防止多轮对话压缩后遗忘已创建文件）
          try {
            const allOutputFiles = cachedReaddirSync(this.ctx.workingDirectory)
              .filter(f => /\.(xlsx|xls|csv|png|pdf|json)$/i.test(f))
              .sort();
            if (allOutputFiles.length > 0) {
              recoveryContext += '\n\n## 当前输出目录中已有的文件\n';
              recoveryContext += allOutputFiles.map(f => `- ${f}`).join('\n');

              recoveryContext += '\n\n⚠️ 以上文件已存在于工作目录中，请在此基础上修改，不要重新创建';
            }
          } catch { /* ignore if directory listing fails */ }

          if (recoveryContext) {
            block.content += recoveryContext;
          }
          // === 恢复上下文注入完毕 ===

          // 将 compaction block 作为消息保留在历史中
          const compactionMessage: Message = {
            id: this.generateId(),
            role: 'system',
            content: `[Compaction] 已压缩 ${block.compactedMessageCount} 条消息，节省 ${block.compactedTokenCount} tokens\n\n${block.content}`,
            timestamp: block.timestamp,
            compaction: block,
          };
          getContextEventLedger().upsertEvents([{
            id: '',
            sessionId: this.ctx.sessionId,
            agentId: this.ctx.agentId,
            messageId: compactionMessage.id,
            category: 'compression_survivor',
            action: 'compressed',
            sourceKind: 'compression_survivor',
            sourceDetail: 'autocompact:compaction_block',
            layer: 'autocompact',
            reason: 'Compaction block inserted after hard threshold compaction',
            timestamp: block.timestamp,
          }]);

          // Layer 2: 全量替换 — 删除被压缩的旧消息，只保留 compaction + 最近 N 条
          const preserveCount = this.ctx.autoCompressor.getConfig().preserveRecentCount;
          const boundary = this.ctx.messages.length - preserveCount;
          if (boundary > 0) {
            // 替换 messages[0..boundary) 为单条 compaction 消息
            this.ctx.messages.splice(0, boundary, compactionMessage);
            logger.info(`[AgentLoop] Layer 2: spliced ${boundary} old messages, kept ${preserveCount} recent + 1 compaction`);
          } else {
            // 消息太少，仅追加
            this.ctx.messages.push(compactionMessage);
          }
          this.recordContextEventsForMessage(compactionMessage);
          const nextCompressionState = new CompressionState();
          nextCompressionState.applyCommit({
            layer: 'autocompact',
            operation: 'compact',
            targetMessageIds: [compactionMessage.id],
            timestamp: block.timestamp,
            metadata: {
              compactedMessageCount: block.compactedMessageCount,
              compactedTokenCount: block.compactedTokenCount,
              kind: 'compaction_block',
            },
          });
          this.ctx.compressionState = nextCompressionState;
          getContextEventLedger().upsertCompressionEvents(
            this.ctx.sessionId,
            this.ctx.agentId,
            nextCompressionState.getCommitLog(),
          );

          // 发送压缩事件（包含 compaction block 信息）
          this.ctx.onEvent({
            type: 'context_compressed',
            data: {
              savedTokens: block.compactedTokenCount,
              strategy: 'compaction_block',
              newMessageCount: this.ctx.messages.length,
            },
          } as AgentEvent);

          logger.info(`[AgentLoop] CompactionBlock generated: ${block.compactedMessageCount} msgs compacted, saved ${block.compactedTokenCount} tokens`);

          // Emit context_compacted event (Claude Code style)
          this.ctx.onEvent({
            type: 'context_compacted',
            data: {
              tokensBefore: currentTokens,
              tokensAfter: currentTokens - block.compactedTokenCount,
              messagesRemoved: block.compactedMessageCount,
              duration_ms: Date.now() - compactionStartTime,
            },
          } as AgentEvent);
          logCollector.agent('INFO', 'CompactionBlock generated', {
            compactedMessages: block.compactedMessageCount,
            savedTokens: block.compactedTokenCount,
            compactionCount: this.ctx.autoCompressor.getCompactionCount(),
          });

          // 检查是否应该收尾（总预算超限）
          if (this.ctx.autoCompressor.shouldWrapUp()) {
            logger.warn('[AgentLoop] Total token budget exceeded, injecting wrap-up instruction');
            this.injectSystemMessage(
              '<wrap-up>\n' +
              '你已经使用了大量 token。请总结当前工作进展并收尾：\n' +
              '1. 列出已完成的任务\n' +
              '2. 列出未完成的任务及原因\n' +
              '3. 给出后续建议\n' +
              '</wrap-up>'
            );
          }

          return; // compaction 成功，跳过旧的压缩逻辑
        }
      }

      // 回退到原有的百分比阈值压缩
      const messagesForCompression = this.ctx.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        id: msg.id,
        timestamp: msg.timestamp,
        toolCallId: msg.toolResults?.[0]?.toolCallId,      // 保留 tool↔assistant 配对
        toolCallIds: msg.toolCalls?.map(tc => tc.id),       // 保留 assistant→tool 配对
      }));

      const result = await this.ctx.autoCompressor.checkAndCompress(
        this.ctx.sessionId,
        messagesForCompression,
        this.ctx.systemPrompt,
        this.ctx.modelConfig.model || DEFAULT_MODELS.chat,
        this.ctx.hookManager
      );

      if (result.compressed) {
        logger.info(`[AgentLoop] Auto compression: saved ${result.savedTokens} tokens using ${result.strategy}`);
        logCollector.agent('INFO', 'Auto context compression', {
          savedTokens: result.savedTokens,
          strategy: result.strategy,
          messageCount: result.messages.length,
        });

        // 发送压缩事件
        this.ctx.onEvent({
          type: 'context_compressed',
          data: {
            savedTokens: result.savedTokens,
            strategy: result.strategy,
            newMessageCount: result.messages.length,
          },
        } as AgentEvent);
      }
    } catch (error) {
      logger.error('[AgentLoop] Auto compression failed:', error);
    }
  }

  // ========================================================================
  // Adaptive Thinking: 交错思考管理
  // ========================================================================

  /**
   * 根据 effort 级别判断是否应该在 tool call 之间注入思考步骤
   */

  shouldThink(hasErrors: boolean): boolean {
    this.ctx.thinkingStepCount++;

    switch (this.ctx.effortLevel) {
      case 'max':
        return true; // 每次 tool call 后都思考
      case 'high':
        return this.ctx.thinkingStepCount % 2 === 0 || hasErrors; // 每隔一次 + 错误时
      case 'medium':
        return hasErrors || this.ctx.thinkingStepCount === 1; // 仅在错误恢复或首次
      case 'low':
        return this.ctx.thinkingStepCount === 1; // 仅初始规划
      default:
        return false;
    }
  }

  /**
   * 生成思考引导 prompt
   */

  generateThinkingPrompt(
    toolCalls: import('../../../shared/contract').ToolCall[],
    toolResults: import('../../../shared/contract').ToolResult[]
  ): string {
    const hasErrors = toolResults.some(r => !r.success);
    const toolNames = toolCalls.map(tc => tc.name).join(', ');

    if (hasErrors) {
      const errors = toolResults
        .filter(r => !r.success)
        .map(r => `${r.toolCallId}: ${r.error}`)
        .join('\n');
      return (
        `<thinking>\n` +
        `刚执行了 ${toolNames}，其中有工具失败。\n` +
        `错误信息：\n${errors}\n\n` +
        `请分析：\n` +
        `1. 错误的根本原因是什么？\n` +
        `2. 是否需要更换策略？\n` +
        `3. 下一步应该怎么做？\n` +
        `</thinking>`
      );
    }

    return (
      `<thinking>\n` +
      `刚执行了 ${toolNames}。\n` +
      `请简要分析：\n` +
      `1. 执行结果是否符合预期？\n` +
      `2. 离最终目标还有多远？\n` +
      `3. 下一步的最优行动是什么？\n` +
      `</thinking>`
    );
  }

  /**
   * 在 tool call 之间可能注入思考步骤
   */

  async maybeInjectThinking(
    toolCalls: import('../../../shared/contract').ToolCall[],
    toolResults: import('../../../shared/contract').ToolResult[]
  ): Promise<void> {
    const hasErrors = toolResults.some(r => !r.success);

    if (!this.shouldThink(hasErrors)) {
      return;
    }

    try {
      const thinkingPrompt = this.generateThinkingPrompt(toolCalls, toolResults);
      this.injectSystemMessage(thinkingPrompt);

      // 记录思考注入
      const thinkingMessage: Message = {
        id: this.generateId(),
        role: 'system',
        content: thinkingPrompt,
        timestamp: Date.now(),
        thinking: thinkingPrompt,
        isMeta: true, // 不渲染到 UI，但发送给模型
      };

      // 发送思考事件到 UI（可折叠显示）
      this.ctx.onEvent({
        type: 'agent_thinking',
        data: {
          message: `[Thinking Step ${this.ctx.thinkingStepCount}] Effort: ${this.ctx.effortLevel}`,
          progress: undefined,
        },
      });

      logger.debug(`[AgentLoop] Thinking step ${this.ctx.thinkingStepCount} injected (effort: ${this.ctx.effortLevel})`);
    } catch (error) {
      logger.warn('[AgentLoop] Failed to inject thinking step:', error);
    }
  }

  /**
   * 设置 Effort 级别
   */
}
