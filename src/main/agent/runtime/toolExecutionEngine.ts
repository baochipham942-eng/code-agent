// ============================================================================
// ToolExecutionEngine — Tool execution with hooks, circuit breaker, content verification
// Extracted from AgentLoop
// ============================================================================

// ============================================================================
// Agent Loop - Core event loop for AI agent execution
// Enhanced with Manus-style persistent planning hooks
// ============================================================================

import type {
  ToolCall,
  ToolResult,
  AgentEvent,
} from '../../../shared/contract';
import { getLangfuseService } from '../../services';
import { logCollector } from '../../mcp/logCollector.js';
import { createLogger } from '../../services/infra/logger';
import { TOOL_PROGRESS, TOOL_TIMEOUT_THRESHOLDS } from '../../../shared/constants';

// Import refactored modules
import type {
  AgentLoopConfig,
} from '../../agent/loopTypes';
import { classifyToolCalls } from '../../agent/toolExecution/parallelStrategy';
import { cleanXmlResidues } from '../../agent/antiPattern/cleanXml';
import { validateToolArgs } from './toolArgsValidator';
import { getToolDefinitionWithCloudMeta } from '../../tools/dispatch/toolDefinitions';
import { MAX_PARALLEL_TOOLS } from '../../agent/loopTypes';
import { getDiffTracker } from '../../services/diff/diffTracker';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer } from './runFinalizer';
import type { RuntimeControlPort } from './runtimeControl';
import {
  isSameArtifactRepairPath,
  seedArtifactRepairGuardFromContext,
} from './artifactRepairGuard';
import { detectStructuredToolFailure } from './toolResultNormalization';
import {
  extractReadFilePath,
  markFileEvidenceResult,
  sanitizeToolArgumentsForObservation,
  sanitizeToolResultForObservation,
  summarizeArtifactRepairFileEvidenceForObservation,
} from './toolObservationSanitizers';
import {
  buildArtifactRepairRecoveryPrompt,
  captureArtifactRepairRollbackSnapshot,
  enforceArtifactRepairGuard,
  enforceArtifactRepairRepeatedPatchGuard,
  getModifiedFilePath,
  isFileMutationTool,
} from './toolArtifactRepairPolicy';
import { maybeRepairArtifactContractEditAnchors } from './toolArtifactContractAnchors';
import { handleModifiedArtifactValidation } from './toolArtifactValidationLifecycle';
import { handleToolResultBookkeeping } from './toolResultLifecycle';
import {
  activateForceFinalResponse,
  getReadOnlyPreflightWarning,
  maybeFinishArtifactRepairIfAlreadyValid,
  semanticProgressReasonForToolCall,
} from './toolPreflightGuards';

const logger = createLogger('AgentLoop');

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

export class ToolExecutionEngine {
  contextAssembly!: ContextAssembly;
  runFinalizer!: RunFinalizer;
  runtimeControl!: RuntimeControlPort;
  private forceFinalResponseReasonAtBatchStart: string | undefined;
  private forceFinalResponseBatchActive = false;

  constructor(protected ctx: RuntimeContext) {}

  setModules(
    contextAssembly: ContextAssembly,
    runFinalizer: RunFinalizer,
    runtimeControl: RuntimeControlPort,
  ): void {
    this.contextAssembly = contextAssembly;
    this.runFinalizer = runFinalizer;
    this.runtimeControl = runtimeControl;
  }

  // Convenience: emit event through context
  protected onEvent(event: AgentEvent): void {
    this.ctx.onEvent(event);
  }

  private isRunCancelled(): boolean {
    return this.ctx.isCancelled || Boolean(this.ctx.runAbortController?.signal.aborted);
  }

  private buildSuppressedCancelledResult(toolCall: ToolCall, startTime: number): ToolResult {
    return {
      toolCallId: toolCall.id,
      success: false,
      error: 'cancelled',
      duration: Date.now() - startTime,
      metadata: {
        cancelledByRun: true,
        suppressObservation: true,
      },
    };
  }

  private shouldSuppressResult(result: ToolResult): boolean {
    return result.metadata?.cancelledByRun === true && result.metadata?.suppressObservation === true;
  }

  private shouldSkipToolBecauseForceFinalWasSetInBatch(): boolean {
    return (
      this.forceFinalResponseBatchActive &&
      Boolean(this.ctx.forceFinalResponseReason) &&
      this.ctx.forceFinalResponseReason !== this.forceFinalResponseReasonAtBatchStart
    );
  }

  async runSessionStartHook(): Promise<void> {
    if (!this.ctx.planningService) return;

    try {
      const result = await this.ctx.planningService.hooks.onSessionStart();

      if (result.injectContext) {
        this.contextAssembly.injectSystemMessage(result.injectContext);
      }

      if (result.notification) {
        this.ctx.onEvent({
          type: 'notification',
          data: { message: result.notification },
        });
      }
    } catch (error) {
      logger.error('Session start hook error:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Tool Execution
  // --------------------------------------------------------------------------

  async executeToolsWithHooks(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    logger.debug(` executeToolsWithHooks called with ${toolCalls.length} tool calls`);
    this.forceFinalResponseBatchActive = true;
    this.forceFinalResponseReasonAtBatchStart = this.ctx.forceFinalResponseReason;
    seedArtifactRepairGuardFromContext(this.ctx);

    // Check for external file changes before executing tools
    try {
      const { getFileWatcherService } = await import('../../services/git/fileWatcherService');
      const externalChanges = getFileWatcherService().getRecentExternalChanges();
      if (externalChanges.length > 0) {
        const changedFiles = externalChanges.map(c => `${c.type}: ${c.path}`).slice(0, 10);
        this.contextAssembly.injectSystemMessage(
          `<external-file-changes>\n` +
          `以下文件在 Agent 外部被修改，请注意内容可能已变更：\n` +
          changedFiles.join('\n') +
          (externalChanges.length > 10 ? `\n...及另外 ${externalChanges.length - 10} 个文件` : '') +
          `\n如需操作这些文件，建议先重新读取最新内容。\n` +
          `</external-file-changes>`
        );
      }
    } catch { /* ignore in non-Electron environments */ }

    // Build MCP tool annotations map for annotation-based parallel classification
    let mcpAnnotations: Map<string, import('../../mcp/types').MCPToolAnnotations> | undefined;
    try {
      const { getMCPClient } = await import('../../mcp/mcpClient');
      const annotationsMap = getMCPClient().getToolAnnotationsMap();
      if (annotationsMap.size > 0) {
        mcpAnnotations = annotationsMap;
      }
    } catch { /* MCP client may not be initialized */ }

    const { parallelGroup, sequentialGroup } = classifyToolCalls(toolCalls, mcpAnnotations);
    logger.debug(` Tool classification: ${parallelGroup.length} parallel-safe, ${sequentialGroup.length} sequential`);

    const results: Array<ToolResult | undefined> = Array.from({ length: toolCalls.length });

    // Execute parallel-safe tools first
    if (parallelGroup.length > 1) {
      logger.debug(` Executing ${parallelGroup.length} parallel-safe tools in parallel (max ${MAX_PARALLEL_TOOLS})`);

      for (let batchStart = 0; batchStart < parallelGroup.length; batchStart += MAX_PARALLEL_TOOLS) {
        const batch = parallelGroup.slice(batchStart, batchStart + MAX_PARALLEL_TOOLS);

        for (const { index, toolCall } of batch) {
          this.ctx.toolsUsedInTurn.push(toolCall.name);
          this.runFinalizer.emitTaskProgress('tool_running', `并行执行 ${batch.length} 个工具`, {
            tool: toolCall.name,
            toolIndex: index,
            toolTotal: toolCalls.length,
            parallel: true,
          });
        }

        const batchPromises = batch.map(async ({ index, toolCall }) => {
          const result = await this.executeSingleTool(toolCall, index, toolCalls.length, true);
          return { index, result };
        });

        const batchResults = await Promise.all(batchPromises);

        for (const { index, result } of batchResults) {
          results[index] = result;
        }
      }
    } else if (parallelGroup.length === 1) {
      const { index, toolCall } = parallelGroup[0];
      this.ctx.toolsUsedInTurn.push(toolCall.name);
      // Research mode: show friendly message for web_fetch
      const singleToolLabel = this.ctx._researchModeActive && toolCall.name === 'web_fetch'
        ? '正在抓取详情...'
        : `执行 ${toolCall.name}`;
      this.runFinalizer.emitTaskProgress('tool_running', singleToolLabel, {
        tool: toolCall.name,
        toolIndex: index,
        toolTotal: toolCalls.length,
      });
      results[index] = await this.executeSingleTool(toolCall, index, toolCalls.length, false);
    }

    // Execute sequential tools one by one
    for (const { index, toolCall } of sequentialGroup) {
      if (this.ctx.isCancelled || this.ctx.needsReinference) {
        logger.debug('[AgentLoop] Cancelled/steered, breaking out of sequential tool execution');
        break;
      }

      this.ctx.toolsUsedInTurn.push(toolCall.name);
      const progress = Math.round((index / toolCalls.length) * 100);
      // Research mode: show friendly message for web_fetch
      const toolStepLabel = this.ctx._researchModeActive && toolCall.name === 'web_fetch'
        ? '正在抓取详情...'
        : `执行 ${toolCall.name}`;
      this.runFinalizer.emitTaskProgress('tool_running', toolStepLabel, {
        tool: toolCall.name,
        toolIndex: index,
        toolTotal: toolCalls.length,
        progress,
      });
      results[index] = await this.executeSingleTool(toolCall, index, toolCalls.length, false);
    }

    this.forceFinalResponseBatchActive = false;
    this.forceFinalResponseReasonAtBatchStart = undefined;
    return results.filter((r): r is ToolResult => r !== undefined && !this.shouldSuppressResult(r));
  }

  async executeSingleTool(
    incomingToolCall: ToolCall,
    index: number,
    total: number,
    parallel = false,
  ): Promise<ToolResult> {
    // Mutable copy: hooks may replace arguments via updatedInput
    let toolCall = maybeRepairArtifactContractEditAnchors(this.ctx, incomingToolCall);
    logger.debug(` [${index + 1}/${total}] Processing tool: ${toolCall.name}, id: ${toolCall.id}`);

    // User-configurable Pre-Tool Hook
    let toolCallStarted = false;
    const emitToolCallStart = () => {
      if (toolCallStarted) return;
      toolCallStarted = true;
      const observedArgs = sanitizeToolArgumentsForObservation(toolCall);
      this.ctx.onEvent({
        type: 'tool_call_start',
        data: { ...toolCall, arguments: observedArgs, _index: index, turnId: this.ctx.currentTurnId },
      });
      this.ctx.telemetryAdapter?.onToolCallStart(
        this.ctx.currentTurnId,
        toolCall.id,
        toolCall.name,
        observedArgs,
        index,
        parallel,
      );
    };
    const emitBlockedToolResult = (toolResult: ToolResult): ToolResult => {
      emitToolCallStart();
      this.ctx.telemetryAdapter?.onToolCallEnd(
        this.ctx.currentTurnId,
        toolCall.id,
        false,
        toolResult.error,
        toolResult.duration || 0,
        undefined,
        toolResult.metadata,
      );
      this.ctx.onEvent({ type: 'tool_call_end', data: sanitizeToolResultForObservation(toolCall, toolResult) });
      return toolResult;
    };

    if (this.shouldSkipToolBecauseForceFinalWasSetInBatch()) {
      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: `Tool skipped because final response is already forced: ${this.ctx.forceFinalResponseReason}`,
        duration: 0,
        metadata: {
          skipped: true,
          blocked: true,
          forceFinalResponseReason: this.ctx.forceFinalResponseReason,
        },
      };
      return emitBlockedToolResult(toolResult);
    }

    if (this.ctx.hookManager) {
      try {
        const toolInput = JSON.stringify(toolCall.arguments);
        const userHookResult = await this.ctx.hookManager.triggerPreToolUse(
          toolCall.name,
          toolInput,
          this.ctx.sessionId
        );

        if (!userHookResult.shouldProceed) {
          logger.info('[AgentLoop] Tool blocked by user hook', {
            tool: toolCall.name,
            message: userHookResult.message,
          });

          const blockedResult: ToolResult = {
            toolCallId: toolCall.id,
            success: false,
            error: `Tool blocked by hook: ${userHookResult.message || 'User-defined hook rejected this tool call'}`,
            duration: userHookResult.totalDuration,
          };

          this.contextAssembly.injectSystemMessage(
            `<tool-blocked-by-hook>\n` +
            `⚠️ The tool "${toolCall.name}" was blocked by a user-defined hook.\n` +
            `Reason: ${userHookResult.message || 'No reason provided'}\n` +
            `You may need to adjust your approach or ask the user for guidance.\n` +
            `</tool-blocked-by-hook>`
          );

          emitToolCallStart();
          this.ctx.telemetryAdapter?.onToolCallEnd(this.ctx.currentTurnId, toolCall.id, false, blockedResult.error, blockedResult.duration || 0, undefined);
          this.ctx.onEvent({ type: 'tool_call_end', data: sanitizeToolResultForObservation(toolCall, blockedResult) });
          return blockedResult;
        }

        // Hook can modify tool input (updatedInput)
        if (userHookResult.modifiedInput) {
          try {
            const updatedArgs = JSON.parse(userHookResult.modifiedInput) as Record<string, unknown>;
            toolCall = { ...toolCall, arguments: updatedArgs };
            logger.info(`[AgentLoop] Tool input modified by hook for ${toolCall.name}`);
          } catch {
            logger.warn('[AgentLoop] Hook returned invalid modifiedInput JSON, ignoring');
          }
        }

        if (userHookResult.message) {
          this.contextAssembly.injectSystemMessage(`<pre-tool-hook>\n${userHookResult.message}\n</pre-tool-hook>`);
        }
      } catch (error) {
        logger.error('[AgentLoop] User pre-tool hook error:', error);
      }
    }

    // Planning Pre-Tool Hook
    if (this.ctx.enableHooks && this.ctx.planningService) {
      try {
        const preResult = await this.ctx.planningService.hooks.preToolUse({
          toolName: toolCall.name,
          toolParams: toolCall.arguments,
        });

        if (preResult.injectContext) {
          this.contextAssembly.injectSystemMessage(preResult.injectContext);
        }
      } catch (error) {
        logger.error('Pre-tool hook error:', error);
      }
    }

    const startTime = Date.now();

    const artifactRepairBlock = enforceArtifactRepairGuard(this.ctx, toolCall);
    if (artifactRepairBlock) {
      const guard = this.ctx.artifactRepairGuard;
      if (guard) {
        guard.lastBlockedTool = toolCall.name;
      }
      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: artifactRepairBlock,
        duration: Date.now() - startTime,
        metadata: {
          artifactRepairGuard: {
            blocked: true,
            targetFile: guard?.targetFile,
            phase: guard?.phase,
            attempts: guard?.attempts,
            lastBlockedTool: toolCall.name,
          },
        },
      };
      this.contextAssembly.injectSystemMessage(
        [
          '<artifact-repair-tool-blocked>',
          artifactRepairBlock,
          'The next action should patch the target artifact or run validation.',
          '</artifact-repair-tool-blocked>',
        ].join('\n'),
      );
      if (guard?.targetFile) {
        const alreadyValid = await maybeFinishArtifactRepairIfAlreadyValid(this.ctx, this.contextAssembly, guard);
        if (!alreadyValid) {
          this.contextAssembly.pushPersistentSystemContext(
            buildArtifactRepairRecoveryPrompt(guard.targetFile, guard.activeIssueCodes),
          );
          this.ctx.needsReinference = true;
        }
      }
      emitToolCallStart();
      this.ctx.telemetryAdapter?.onToolCallEnd(this.ctx.currentTurnId, toolCall.id, false, toolResult.error, toolResult.duration || 0, undefined, toolResult.metadata);
      this.ctx.onEvent({ type: 'tool_call_end', data: sanitizeToolResultForObservation(toolCall, toolResult) });
      return toolResult;
    }

    const repeatedArtifactRepairPatchBlock = enforceArtifactRepairRepeatedPatchGuard(this.ctx, toolCall);
    if (repeatedArtifactRepairPatchBlock) {
      const guard = this.ctx.artifactRepairGuard;
      if (guard) {
        guard.lastBlockedTool = toolCall.name;
      }
      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: repeatedArtifactRepairPatchBlock,
        duration: Date.now() - startTime,
        metadata: {
          artifactRepairGuard: {
            blocked: true,
            targetFile: guard?.targetFile,
            phase: guard?.phase,
            attempts: guard?.attempts,
            lastBlockedTool: toolCall.name,
            repeatedFailedPatch: true,
          },
        },
      };
      this.contextAssembly.injectSystemMessage(repeatedArtifactRepairPatchBlock);
      if (guard?.targetFile) {
        this.contextAssembly.pushPersistentSystemContext(
          buildArtifactRepairRecoveryPrompt(guard.targetFile, guard.activeIssueCodes),
        );
        this.ctx.needsReinference = true;
      }
      emitToolCallStart();
      this.ctx.telemetryAdapter?.onToolCallEnd(this.ctx.currentTurnId, toolCall.id, false, toolResult.error, toolResult.duration || 0, undefined, toolResult.metadata);
      this.ctx.onEvent({ type: 'tool_call_end', data: sanitizeToolResultForObservation(toolCall, toolResult) });
      return toolResult;
    }

    // Check for parse errors in arguments
    const args = toolCall.arguments as Record<string, unknown>;
    if (args?.__parseError === true) {
      const errorMessage = args.__errorMessage as string || 'Unknown JSON parse error';
      const rawArgs = args.__rawArguments as string || '';

      logger.error(`[AgentLoop] Tool ${toolCall.name} arguments failed to parse: ${errorMessage}`);
      logCollector.tool('ERROR', `Tool ${toolCall.name} arguments parse error: ${errorMessage}`, {
        toolCallId: toolCall.id,
        rawArguments: rawArgs.substring(0, 500),
      });

      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: `Tool arguments JSON parse error: ${errorMessage}. Raw: ${rawArgs.substring(0, 200)}...`,
        duration: Date.now() - startTime,
      };

      this.contextAssembly.injectSystemMessage(
        `<tool-arguments-parse-error>\n` +
        `⚠️ ERROR: Failed to parse JSON arguments for tool "${toolCall.name}".\n` +
        `Parse error: ${errorMessage}\n` +
        `Raw arguments (truncated): ${rawArgs.substring(0, 300)}\n\n` +
        `Please ensure your tool call arguments are valid JSON.\n` +
        `</tool-arguments-parse-error>`
      );

      emitToolCallStart();
      this.ctx.telemetryAdapter?.onToolCallEnd(this.ctx.currentTurnId, toolCall.id, false, toolResult.error, toolResult.duration || 0, undefined, toolResult.metadata);
      this.ctx.onEvent({ type: 'tool_call_end', data: sanitizeToolResultForObservation(toolCall, toolResult) });
      // Tool execution logging (non-blocking)
      if (this.ctx.onToolExecutionLog && this.ctx.sessionId) {
        try {
          const safeToolResult = sanitizeToolResultForObservation(toolCall, toolResult);
          this.ctx.onToolExecutionLog({
            sessionId: this.ctx.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: sanitizeToolArgumentsForObservation(toolCall) as Record<string, unknown>,
            result: safeToolResult,
          });
        } catch {
          // Never let logging break tool execution
        }
      }

      return toolResult;
    }

    // 清理工具参数中的 XML 标签残留（如 <arg_key>command</arg_key>）
    toolCall.arguments = cleanXmlResidues(toolCall.arguments) as Record<string, unknown>;

    // Schema validation gate — 在真实 dispatch 前用工具自身 inputSchema 校验
    // missing required + 顶层 type，失败时把 schema 信息回灌给模型自我修正
    const definition = getToolDefinitionWithCloudMeta(toolCall.name);
    const validation = validateToolArgs(
      toolCall.name,
      definition?.inputSchema,
      toolCall.arguments as Record<string, unknown>,
    );
    if (!validation.ok) {
      logger.warn(`[AgentLoop] Tool ${toolCall.name} args failed schema validation`);
      logCollector.tool('WARN', `Tool ${toolCall.name} args failed schema validation`, {
        toolCallId: toolCall.id,
      });

      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: validation.message,
        duration: Date.now() - startTime,
      };

      this.contextAssembly.injectSystemMessage(validation.message);

      emitToolCallStart();
      this.ctx.telemetryAdapter?.onToolCallEnd(this.ctx.currentTurnId, toolCall.id, false, toolResult.error, toolResult.duration || 0, undefined);
      this.ctx.onEvent({ type: 'tool_call_end', data: sanitizeToolResultForObservation(toolCall, toolResult) });

      if (this.ctx.onToolExecutionLog && this.ctx.sessionId) {
        try {
          const safeToolResult = sanitizeToolResultForObservation(toolCall, toolResult);
          this.ctx.onToolExecutionLog({
            sessionId: this.ctx.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: sanitizeToolArgumentsForObservation(toolCall) as Record<string, unknown>,
            result: safeToolResult,
          });
        } catch { /* never let logging break tool execution */ }
      }

      return toolResult;
    }

    if (this.isRunCancelled()) {
      return this.buildSuppressedCancelledResult(toolCall, startTime);
    }

    if (this.shouldSkipToolBecauseForceFinalWasSetInBatch()) {
      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: `Tool skipped because final response is already forced: ${this.ctx.forceFinalResponseReason}`,
        duration: Date.now() - startTime,
        metadata: {
          skipped: true,
          blocked: true,
          forceFinalResponseReason: this.ctx.forceFinalResponseReason,
        },
      };
      return emitBlockedToolResult(toolResult);
    }

    const readOnlyPreflight = getReadOnlyPreflightWarning(this.ctx, toolCall);
    if (readOnlyPreflight.warning === 'HARD_LIMIT') {
      activateForceFinalResponse(this.ctx, `连续只读操作达到硬阈值，已在执行前阻止 ${toolCall.name}`);
      const hardLimitResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: this.ctx.antiPatternDetector.generateHardLimitError(),
        duration: Date.now() - startTime,
        metadata: {
          blocked: true,
          skipped: true,
          hardLimitPreflight: true,
          forceFinalResponseReason: this.ctx.forceFinalResponseReason,
        },
      };
      return emitBlockedToolResult(hardLimitResult);
    }

    emitToolCallStart();

    // Langfuse: Start tool span
    const langfuse = getLangfuseService();
    const toolSpanId = `tool-${toolCall.id}`;
    langfuse.startNestedSpan(this.ctx.currentIterationSpanId, toolSpanId, {
      name: `Tool: ${toolCall.name}`,
      input: sanitizeToolArgumentsForObservation(toolCall),
      metadata: { toolId: toolCall.id, toolName: toolCall.name },
    });

    // Tool progress & timeout tracking
    const timeoutThreshold = TOOL_TIMEOUT_THRESHOLDS[toolCall.name] ?? TOOL_PROGRESS.DEFAULT_THRESHOLD;
    let timeoutEmitted = false;
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      this.ctx.onEvent({
        type: 'tool_progress',
        data: { toolCallId: toolCall.id, toolName: toolCall.name, elapsedMs: elapsed },
      });
      if (!timeoutEmitted && elapsed > timeoutThreshold) {
        timeoutEmitted = true;
        this.ctx.onEvent({
          type: 'tool_timeout',
          data: { toolCallId: toolCall.id, toolName: toolCall.name, elapsedMs: elapsed, threshold: timeoutThreshold },
        });
        logger.warn(`Tool ${toolCall.name} exceeded timeout threshold ${timeoutThreshold}ms (elapsed: ${elapsed}ms)`);
      }
    }, TOOL_PROGRESS.REPORT_INTERVAL);

    try {
      logger.debug(` Calling toolExecutor.execute for ${toolCall.name}...`);

      const currentAttachments = this.contextAssembly.getCurrentAttachments();
      const artifactRepairRollbackSnapshot = captureArtifactRepairRollbackSnapshot(this.ctx, toolCall);

      const result = await this.ctx.toolExecutor.execute(
        toolCall.name,
        toolCall.arguments,
        {
          planningService: this.ctx.planningService,
          modelConfig: this.ctx.modelConfig,
          setPlanMode: this.runtimeControl.setPlanMode.bind(this.runtimeControl),
          isPlanMode: this.runtimeControl.isPlanMode.bind(this.runtimeControl),
          emitEvent: (event: string, data: unknown) => this.ctx.onEvent({ type: event, data, sessionId: this.ctx.sessionId } as AgentEvent),
          sessionId: this.ctx.sessionId,
          // Per-agent BrowserPool / ComputerSurface 隔离的关键：把 RuntimeContext.agentId
          // 透传到 ToolContext。子 agent 通过 subagent pipeline 派活时填入此字段，工具
          // 实现层（BrowserTool/browserAction/computerUse）按 agentId 取自己的 BrowserContext。
          agentId: this.ctx.agentId,
          preApprovedTools: this.ctx.preApprovedTools,
          // GAP-001: skill allowed-tools 限权边界透传
          skillToolBoundary: this.ctx.skillToolBoundary,
          currentAttachments,
          // 传递当前工具调用 ID（用于 subagent 追踪）
          currentToolCallId: toolCall.id,
          // 模型回调：工具可用此回调二次调用模型（如 PPT 内容生成）
          modelCallback: this.createModelCallback(),
          // Hook 系统：传递给工具上下文（subagent/permission 事件触发）
          hookManager: this.ctx.hookManager,
          toolScope: this.ctx.toolScope,
          executionIntent: this.ctx.executionIntent,
          abortSignal: this.ctx.runAbortController?.signal,
        }
      );
      clearInterval(progressInterval);
      logger.debug(` toolExecutor.execute returned for ${toolCall.name}: success=${result.success}`);

      // G20: 记一条 tool_dispatch trace —— 工具名 / 成败 / 耗时 / 错误，
      // 用于回放"这个 turn 派了哪些工具、结果如何"（也是验证 G7 是否死代码的数据来源）。
      this.ctx.turnTrace.record('tool_dispatch', {
        toolName: toolCall.name,
        success: result.success,
        durationMs: Date.now() - startTime,
        error: result.error ?? null,
        fromCache: result.fromCache ?? false,
      });

      if (this.isRunCancelled()) {
        const suppressedResult = this.buildSuppressedCancelledResult(toolCall, startTime);
        langfuse.endSpan(toolSpanId, {
          success: false,
          error: suppressedResult.error,
          duration: suppressedResult.duration,
        }, 'WARNING', 'cancelled');
        return suppressedResult;
      }

      const structuredFailure = result.success
        ? detectStructuredToolFailure(result.output)
        : null;

      const normalizedResult = structuredFailure
        ? {
            ...result,
            success: false,
            output: undefined,
            error: structuredFailure,
            metadata: {
              ...result.metadata,
              rawOutput: result.output,
              normalizedStructuredError: true,
            },
          }
        : result;

      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: normalizedResult.success,
        output: normalizedResult.output,
        error: normalizedResult.error,
        outputPath: normalizedResult.outputPath,
        duration: Date.now() - startTime,
        metadata: normalizedResult.metadata,
      };

      logger.debug(` Tool ${toolCall.name} completed in ${toolResult.duration}ms`);

      handleToolResultBookkeeping({
        ctx: this.ctx,
        contextAssembly: this.contextAssembly,
        runtimeControl: this.runtimeControl,
        toolCall,
        normalizedResult,
        toolResult,
      });

      if (normalizedResult.success && this.ctx.artifactRepairGuard?.targetFile) {
        const readFilePath = extractReadFilePath(toolCall);
        if (
          readFilePath &&
          isSameArtifactRepairPath(this.ctx, readFilePath, this.ctx.artifactRepairGuard.targetFile)
        ) {
          await maybeFinishArtifactRepairIfAlreadyValid(this.ctx, this.contextAssembly, this.ctx.artifactRepairGuard);
        }
      }

      // P3 Nudge: Track modified files for completion checking
      if (isFileMutationTool(toolCall.name) && normalizedResult.success) {
        const filePath = getModifiedFilePath(toolCall);
        if (filePath) {
          this.ctx.nudgeManager.trackModifiedFile(filePath);

          // Mark as agent-modified to avoid false external change alerts
          try {
            const { getFileWatcherService } = await import('../../services/git/fileWatcherService');
            const path = await import('path');
            const absolutePath = path.default.isAbsolute(filePath)
              ? filePath
              : path.default.resolve(this.ctx.workingDirectory || process.cwd(), filePath);
            getFileWatcherService().markAsAgentModified(absolutePath);
          } catch { /* ignore */ }

          // E3: Diff tracking - compute and emit diff_computed event
          if (this.ctx.sessionId) {
            try {
              const diffTracker = getDiffTracker();
              const fs = await import('fs/promises');
              const path = await import('path');
              const absolutePath = path.default.isAbsolute(filePath)
                ? filePath
                : path.default.resolve(this.ctx.workingDirectory || process.cwd(), filePath);
              // Read current file content (after write/edit)
              let afterContent: string | null = null;
              try {
                afterContent = await fs.default.readFile(absolutePath, 'utf-8');
              } catch {
                // File may not exist after failed write
              }
              // before content is captured by FileCheckpointService - we use null here
              // The diff shows the full file as "added" for new files
              const messageId = toolCall.id;
              const diff = diffTracker.computeAndStore(
                this.ctx.sessionId,
                messageId,
                toolCall.id,
                absolutePath,
                null, // before state is in checkpoint
                afterContent
              );
              this.ctx.onEvent({ type: 'diff_computed', data: diff });
            } catch (error) {
              logger.debug('Failed to compute diff:', error);
            }
          }

          if (
            this.ctx.artifactRepairGuard?.targetFile &&
            isSameArtifactRepairPath(this.ctx, filePath, this.ctx.artifactRepairGuard.targetFile)
          ) {
            if (toolResult.success !== false) {
              this.ctx.artifactRepairGuard.patched = true;
            }
          }
        }
      }

      await handleModifiedArtifactValidation({
        ctx: this.ctx,
        contextAssembly: this.contextAssembly,
        runFinalizer: this.runFinalizer,
        toolCall,
        normalizedSuccess: normalizedResult.success,
        toolResult,
        artifactRepairRollbackSnapshot,
      });

      // Re-read loop detection (P0: observation masking death loop)
      if ((toolCall.name === 'read_file' || toolCall.name === 'Read') && normalizedResult.success) {
        const filePath = (toolCall.arguments?.file_path || toolCall.arguments?.path) as string;
        if (filePath) {
          const rereadWarning = this.ctx.antiPatternDetector.trackFileReread(filePath);
          if (rereadWarning) {
            this.contextAssembly.injectSystemMessage(rereadWarning);
          }
        }
      }

      const semanticProgressReason = semanticProgressReasonForToolCall(this.ctx, toolCall, normalizedResult);
      if (semanticProgressReason) {
        this.ctx.antiPatternDetector.markSemanticProgress(semanticProgressReason);
      }

      // Track read vs write operations
      let readWriteWarning = readOnlyPreflight.warning;
      if (!readOnlyPreflight.reserved) {
        readWriteWarning = this.ctx.antiPatternDetector.trackToolExecution(toolCall.name, normalizedResult.success);
        if (
          !readWriteWarning &&
          normalizedResult.success &&
          (toolCall.name === 'bash' || toolCall.name === 'Bash') &&
          typeof toolCall.arguments?.command === 'string' &&
          typeof this.ctx.antiPatternDetector.trackReadOnlyShellCommand === 'function'
        ) {
          readWriteWarning = this.ctx.antiPatternDetector.trackReadOnlyShellCommand(
            toolCall.arguments.command as string,
          );
        }
      }
      if (readWriteWarning === 'HARD_LIMIT') {
        activateForceFinalResponse(this.ctx, `连续只读操作达到硬阈值，最后一次工具为 ${toolCall.name}`);
        const hardLimitResult: ToolResult = {
          toolCallId: toolCall.id,
          success: false,
          error: this.ctx.antiPatternDetector.generateHardLimitError(),
          duration: Date.now() - startTime,
        };
        langfuse.endSpan(toolSpanId, {
          success: false,
          error: hardLimitResult.error,
          duration: hardLimitResult.duration,
        }, 'ERROR', hardLimitResult.error);
        this.ctx.telemetryAdapter?.onToolCallEnd(this.ctx.currentTurnId, toolCall.id, false, hardLimitResult.error, hardLimitResult.duration || 0, undefined);
        this.ctx.onEvent({ type: 'tool_call_end', data: sanitizeToolResultForObservation(toolCall, hardLimitResult) });
        return hardLimitResult;
      } else if (readWriteWarning) {
        this.contextAssembly.injectSystemMessage(readWriteWarning);
      }

      const preservedToolResult = markFileEvidenceResult(toolCall, toolResult);

      // User-configurable Post-Tool Hook
      if (this.ctx.hookManager) {
        try {
          const toolInput = JSON.stringify(toolCall.arguments);
          const toolOutput = preservedToolResult.output || '';
          const userPostResult = await this.ctx.hookManager.triggerPostToolUse(
            toolCall.name,
            toolInput,
            toolOutput,
            this.ctx.sessionId
          );

          if (userPostResult.message) {
            this.contextAssembly.injectSystemMessage(`<post-tool-hook>\n${userPostResult.message}\n</post-tool-hook>`);
          }
        } catch (error) {
          logger.error('[AgentLoop] User post-tool hook error:', error);
        }
      }

      // Auto-refresh git status after file-modifying tools (non-blocking)
      try {
        const { getGitStatusService } = await import('../../services/git/gitStatusService');
        getGitStatusService().onPostToolUse(toolCall.name, this.ctx.workingDirectory);
      } catch { /* ignore in non-Electron environments */ }

      // Plan Mode context restoration on exit
      if (
        (toolCall.name === 'exit_plan_mode' || (toolCall.name === 'PlanMode' && (toolCall.arguments as Record<string, unknown>)?.action === 'exit')) &&
        normalizedResult.success &&
        this.ctx.savedMessages
      ) {
        const planText = normalizedResult.metadata?.plan as string || '';
        // Restore saved messages
        this.ctx.messages.length = 0;
        for (const msg of this.ctx.savedMessages) {
          this.ctx.messages.push(msg);
        }
        // Inject approved plan as system message
        if (planText) {
          this.ctx.messages.push({
            id: this.contextAssembly.generateId(),
            role: 'system',
            content: `<approved-plan>\n${planText}\n</approved-plan>`,
            timestamp: Date.now(),
          });
        }
        this.ctx.savedMessages = null;
        logger.info('[AgentLoop] Plan mode exited: context restored, plan injected');
        this.ctx.onEvent({
          type: 'plan_mode_exited',
          data: { plan: planText },
        } as AgentEvent);
      }

      // Auto-approve plan mode (for CLI/testing)
      if (
        this.ctx.autoApprovePlan &&
        (toolCall.name === 'exit_plan_mode' || (toolCall.name === 'PlanMode' && (toolCall.arguments as Record<string, unknown>)?.action === 'exit')) &&
        normalizedResult.success &&
        normalizedResult.metadata?.requiresUserConfirmation
      ) {
        logger.info('[AgentLoop] Auto-approving plan (autoApprovePlan enabled)');
        this.ctx.messages.push({
          id: `auto-approve-${Date.now()}`,
          role: 'user',
          content: '确认执行，请按计划开始实现。',
          timestamp: Date.now(),
        });
      }

      // Planning Post-Tool Hook
      if (this.ctx.enableHooks && this.ctx.planningService) {
        try {
          const postResult = await this.ctx.planningService.hooks.postToolUse({
            toolName: toolCall.name,
            toolParams: toolCall.arguments,
            toolResult: normalizedResult,
          });

          if (postResult.injectContext) {
            this.contextAssembly.injectSystemMessage(postResult.injectContext);
          }
        } catch (error) {
          logger.error('Post-tool hook error:', error);
        }
      }

      langfuse.endSpan(toolSpanId, {
        success: preservedToolResult.success,
        outputLength: result.output?.length || 0,
        duration: toolResult.duration,
      });

      const observedToolResult = summarizeArtifactRepairFileEvidenceForObservation(
        sanitizeToolResultForObservation(toolCall, preservedToolResult),
        toolCall,
      );
      logger.debug(` Emitting tool_call_end for ${toolCall.name} (success)`);
      this.ctx.telemetryAdapter?.onToolCallEnd(this.ctx.currentTurnId, toolCall.id, preservedToolResult.success, preservedToolResult.error, preservedToolResult.duration || 0, observedToolResult.output?.substring(0, 500), observedToolResult.metadata);
      this.ctx.onEvent({ type: 'tool_call_end', data: observedToolResult });
      // Tool execution logging (non-blocking)
      if (this.ctx.onToolExecutionLog && this.ctx.sessionId) {
        try {
          const safeToolResult = observedToolResult;
          this.ctx.onToolExecutionLog({
            sessionId: this.ctx.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: sanitizeToolArgumentsForObservation(toolCall) as Record<string, unknown>,
            result: safeToolResult,
          });
        } catch {
          // Never let logging break tool execution
        }
      }


      return preservedToolResult;
    } catch (error) {
      clearInterval(progressInterval);
      if (this.isRunCancelled()) {
        const suppressedResult = this.buildSuppressedCancelledResult(toolCall, startTime);
        langfuse.endSpan(toolSpanId, {
          success: false,
          error: suppressedResult.error,
          duration: suppressedResult.duration,
        }, 'WARNING', 'cancelled');
        return suppressedResult;
      }

      logger.error(`Tool ${toolCall.name} threw exception:`, error);
      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      };

      logger.debug(` Tool ${toolCall.name} failed with error: ${toolResult.error}`);

      // Circuit breaker tracking for exceptions
      if (this.ctx.circuitBreaker.recordFailure(toolResult.error)) {
        this.contextAssembly.injectSystemMessage(this.ctx.circuitBreaker.generateWarningMessage(toolResult.error));
        this.ctx.onEvent({
          type: 'error',
          data: {
            message: this.ctx.circuitBreaker.generateUserErrorMessage(toolResult.error),
            code: 'CIRCUIT_BREAKER_TRIPPED',
          },
        });
      }

      // User-configurable Post-Tool Failure Hook
      if (this.ctx.hookManager) {
        try {
          const toolInput = JSON.stringify(toolCall.arguments);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const userFailResult = await this.ctx.hookManager.triggerPostToolUseFailure(
            toolCall.name,
            toolInput,
            errorMessage,
            this.ctx.sessionId
          );

          if (userFailResult.message) {
            this.contextAssembly.injectSystemMessage(`<post-tool-failure-hook>\n${userFailResult.message}\n</post-tool-failure-hook>`);
          }
        } catch (hookError) {
          logger.error('[AgentLoop] User post-tool failure hook error:', hookError);
        }
      }

      // Planning Error Hook
      if (this.ctx.enableHooks && this.ctx.planningService) {
        try {
          const errorResult = await this.ctx.planningService.hooks.onError({
            toolName: toolCall.name,
            toolParams: toolCall.arguments,
            error: error instanceof Error ? error : new Error('Unknown error'),
          });

          if (errorResult.injectContext) {
            this.contextAssembly.injectSystemMessage(errorResult.injectContext);
          }
        } catch (hookError) {
          logger.error('Error hook error:', hookError);
        }
      }

      langfuse.endSpan(toolSpanId, {
        success: false,
        error: toolResult.error,
        duration: toolResult.duration,
      }, 'ERROR', toolResult.error);

      logger.debug(` Emitting tool_call_end for ${toolCall.name} (error)`);
      this.ctx.telemetryAdapter?.onToolCallEnd(this.ctx.currentTurnId, toolCall.id, false, toolResult.error, toolResult.duration || 0, undefined);
      this.ctx.onEvent({ type: 'tool_call_end', data: sanitizeToolResultForObservation(toolCall, toolResult) });
      // Tool execution logging (non-blocking)
      if (this.ctx.onToolExecutionLog && this.ctx.sessionId) {
        try {
          const safeToolResult = sanitizeToolResultForObservation(toolCall, toolResult);
          this.ctx.onToolExecutionLog({
            sessionId: this.ctx.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: sanitizeToolArgumentsForObservation(toolCall) as Record<string, unknown>,
            result: safeToolResult,
          });
        } catch {
          // Never let logging break tool execution
        }
      }


      return toolResult;
    }
  }

  // --------------------------------------------------------------------------
  /**
   * 创建模型回调闭包，供工具内二次调用模型（如 PPT 内容生成）
   * 使用当前 modelConfig，不带工具定义，非流式
   */

  createModelCallback(): (prompt: string) => Promise<string> {
    return async (prompt: string): Promise<string> => {
      const response = await this.ctx.modelRouter.inference(
        [{ role: 'user', content: prompt }],
        [],
        this.ctx.modelConfig,
      );
      return typeof response.content === 'string' ? response.content : '';
    };
  }

}
