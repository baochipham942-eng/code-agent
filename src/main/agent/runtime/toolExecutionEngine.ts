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
import { TOOL_PROGRESS, TOOL_TIMEOUT_THRESHOLDS, DESIGN_QUALITY } from '../../../shared/constants';
import { runDesignQualityReview } from '../../quality/designQualityHook';
import { isFrontendPath } from '../../quality/detect';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

// Import refactored modules
import type {
  AgentLoopConfig,
} from '../../agent/loopTypes';
import { classifyToolCalls } from '../../agent/toolExecution/parallelStrategy';
import { cleanXmlResidues } from '../../agent/antiPattern/cleanXml';
import { validateToolArgs, formatSchemaForModel } from './toolArgsValidator';
import { ToolArgsRepairGate, buildRepairExhaustedMessage } from './toolArgsRepairGate';
import { TOOL_ARGS_REPAIR_MAX_ATTEMPTS } from '../../../shared/constants/repair';
import { getToolDefinitionWithCloudMeta } from '../../tools/dispatch/toolDefinitions';
import { MAX_PARALLEL_TOOLS } from '../../agent/loopTypes';
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
} from './toolArtifactRepairPolicy';
import { registerArtifactRepairBlockedToolTurn } from './artifactRepairAdmission';
import { maybeRepairArtifactContractEditAnchors } from './toolArtifactContractAnchors';
import { handleModifiedArtifactValidation } from './toolArtifactValidationLifecycle';
import { handleToolResultBookkeeping } from './toolResultLifecycle';
import { trackFileMutationSideEffects } from './toolFileMutationTracking';
import { isTaskMutationToolCall } from '../nudgeManager';
import { handleToolExecutionError } from './toolExecutionErrorHandler';
import { applySwarmBudgetClamp, recordSwarmSpend } from './swarmGoalIntegration';
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
  // 工具入参 repair 节流闸：按 toolName 统计连续校验失败，超上限切终止指引
  // （Kimi 借鉴 #1）。引擎实例随 AgentLoop 跨多轮复用，run 起点须 reset。
  private readonly repairGate = new ToolArgsRepairGate(TOOL_ARGS_REPAIR_MAX_ATTEMPTS);

  constructor(protected ctx: RuntimeContext) {}

  /** run 起点重置 repair 计数（每条 user 消息开新的连续失败统计窗口）。 */
  resetRepairGate(): void {
    this.repairGate.reset();
  }

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
    // Swarm goal（P4）预算下行 clamp：workflow 扇出预算压到 goal 剩余预算以内（模型自报不可信）
    applySwarmBudgetClamp(this.ctx, toolCalls);

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
    // Swarm goal（P4）预算上行记账：workflow 结果的 tokensSpent → goal 消耗（闸3 可见）。
    // 放在 suppress 过滤前——token 已真实花掉，结果被压制也要记账。
    recordSwarmSpend(this.ctx.goalMode, toolCalls, results);
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
      // Block 路径也喂 repairTurnsWithoutProgress 计数器：可用但被闸拦的工具此前不计数，
      // 当目标不可达时会无限死锁（2026-06-25 dogfood）。连续 N 次无进展即硬停。
      const repairForceStopped = registerArtifactRepairBlockedToolTurn(this.ctx, guard, toolCall.name);
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
      // 硬停时不再注入恢复提示/重推理——activateArtifactRepairAdmissionStop 已设
      // forceFinalResponse，让本轮强制收尾，别再对同一被拦动作多花一次模型请求。
      if (!repairForceStopped && guard?.targetFile) {
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

      // 回贴 schema：只报"JSON 语法错误"会让模型重发同样缺字段的调用，触发
      // "先修语法→又报字段错→再修"的连环重试。把工具自身 inputSchema 一并回灌，
      // 模型重发时能同时修正语法和字段。schema 来源与 validation 分支同源。
      const parseErrorDefinition = getToolDefinitionWithCloudMeta(toolCall.name);
      const parseErrorSchema = parseErrorDefinition?.inputSchema;
      let schemaSection = '';
      if (parseErrorSchema?.properties) {
        const properties = parseErrorSchema.properties;
        const required = parseErrorSchema.required ?? [];
        // 字段过多时只列必填，避免 schema 回灌膨胀
        const requiredOnly = Object.keys(properties).length > 25;
        schemaSection = '\n\n' + formatSchemaForModel(properties, required, requiredOnly).join('\n');
      }

      this.contextAssembly.injectSystemMessage(
        `<tool-arguments-parse-error>\n` +
        `⚠️ ERROR: Failed to parse JSON arguments for tool "${toolCall.name}".\n` +
        `Parse error: ${errorMessage}\n` +
        `Raw arguments (truncated): ${rawArgs.substring(0, 300)}\n\n` +
        `Please ensure your tool call arguments are valid JSON.` +
        schemaSection + `\n` +
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
      // repair 节流：连续失败超上限 → 不再重注入 schema，改注入终止指引断死循环
      const repair = this.repairGate.recordFailure(toolCall.name);
      const injectMessage = repair.exhausted
        ? buildRepairExhaustedMessage(toolCall.name, repair.attempt)
        : validation.message;

      logger.warn(`[AgentLoop] Tool ${toolCall.name} args failed schema validation (attempt ${repair.attempt}${repair.exhausted ? ', repair exhausted' : ''})`);
      logCollector.tool('WARN', `Tool ${toolCall.name} args failed schema validation`, {
        toolCallId: toolCall.id,
        validationIssues: validation.issues,
        repairAttempt: repair.attempt,
        repairExhausted: repair.exhausted,
      });

      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: injectMessage,
        duration: Date.now() - startTime,
        metadata: {
          validationFailed: true,
          repairAttempt: repair.attempt,
          repairExhausted: repair.exhausted,
          validationIssues: validation.issues.map((issue) => ({
            field: issue.field,
            reason: issue.reason,
            expected: issue.expected,
            actual: issue.actual,
          })),
        },
      };

      this.contextAssembly.injectSystemMessage(injectMessage);

      emitToolCallStart();
      this.ctx.telemetryAdapter?.onToolCallEnd(this.ctx.currentTurnId, toolCall.id, false, toolResult.error, toolResult.duration || 0, undefined, toolResult.metadata);
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

    // 入参通过校验 → 该工具的连续校验失败 streak 清零（即使后续运行时失败，
    // 也说明"参数对了"，不算 repair 死循环的一环）。
    this.repairGate.recordSuccess(toolCall.name);

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

      // P3 Nudge / E3 diff：文件改动副作用跟踪（已抽取为 trackFileMutationSideEffects，行为不变）
      await trackFileMutationSideEffects({
        ctx: this.ctx,
        toolCall,
        normalizedResult,
        toolResult,
      });

      // taskGate（roadmap 1.3）：模型主动写过任务（task_create/task_update 或
      // TaskManager facade 的 create/update）→ 收尾前强制任务收口检查
      // （只读调用刻意不触发，防旧任务劫持）
      if (normalizedResult.success && isTaskMutationToolCall(toolCall.name, toolCall.arguments)) {
        this.ctx.nudgeManager.recordTaskManagerUse();
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

      // Builtin 设计质量自检（Kun 借鉴）：写/改前端文件后扫 AI 痕迹，advisory 回注让模型下一轮自我修正。
      // 纯 advisory：不把工具标记为失败、不拦截本轮。详见 src/main/quality 与借鉴清单。
      if (normalizedResult.success && (DESIGN_QUALITY.REVIEW_TOOLS as readonly string[]).includes(toolCall.name)) {
        try {
          const args = toolCall.arguments as Record<string, unknown> | undefined;
          const rawPath = typeof args?.file_path === 'string' ? args.file_path : undefined;
          if (rawPath && isFrontendPath(rawPath)) {
            // Write 携带完整内容；Edit/MultiEdit 不带，改后回读磁盘取最终状态。
            let source = typeof args?.content === 'string' ? args.content : undefined;
            if (source === undefined) {
              const abs = isAbsolute(rawPath) ? rawPath : resolvePath(this.ctx.workingDirectory, rawPath);
              try {
                source = readFileSync(abs, 'utf8');
              } catch {
                source = undefined;
              }
            }
            if (source) {
              const review = runDesignQualityReview({ toolName: toolCall.name, filePath: rawPath, source });
              if (review) {
                this.contextAssembly.injectSystemMessage(`<design-quality-review>\n${review}\n</design-quality-review>`);
              }
            }
          }
        } catch (error) {
          logger.error('[AgentLoop] Design-quality review error:', error);
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
      // catch 错误处理已抽取为 handleToolExecutionError（行为不变）。clearInterval
      // 引用局部 progressInterval 故留在此处；其余逻辑全部委托给 helper。
      return await handleToolExecutionError({
        ctx: this.ctx,
        contextAssembly: this.contextAssembly,
        toolCall,
        error,
        startTime,
        langfuse,
        toolSpanId,
      });
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
