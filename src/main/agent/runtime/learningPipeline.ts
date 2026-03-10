// ============================================================================
// LearningPipeline — Session-end learning, pattern extraction, error learning
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
} from '../../../shared/types';
import type { StructuredOutputConfig, StructuredOutputResult } from '../../agent/structuredOutput';
import { parseStructuredOutput, generateFormatCorrectionPrompt } from '../../agent/structuredOutput';
import type { ToolRegistryLike } from '../../tools/types';
import type { ToolExecutor } from '../../tools/toolExecutor';
import { getToolSearchService } from '../../tools/search';
import { ModelRouter, ContextLengthExceededError } from '../../model/modelRouter';
import type { PlanningService } from '../../planning';
import { getMemoryService } from '../../memory/memoryService';
import { getContinuousLearningService } from '../../memory/continuousLearningService';
import { sanitizeMemoryContent } from '../../memory/sanitizeMemoryContent';
import { buildSeedMemoryBlock } from '../../memory/seedMemoryInjector';
import { getConfigService, getAuthService, getLangfuseService, getBudgetService, BudgetAlertLevel, getSessionManager } from '../../services';
import { logCollector } from '../../mcp/logCollector.js';
import { generateMessageId } from '../../../shared/utils/id';
import { taskComplexityAnalyzer } from '../../planning/taskComplexityAnalyzer';
import { classifyIntent } from '../../routing/intentClassifier';
import { getTaskOrchestrator } from '../../planning/taskOrchestrator';
import { getMaxIterations } from '../../services/cloud/featureFlagService';
import { createLogger } from '../../services/infra/logger';
import { HookManager, createHookManager } from '../../hooks';
import type { BudgetEventData } from '../../../shared/types';
import { getContextHealthService } from '../../context/contextHealthService';
import { getSystemPromptCache } from '../../telemetry/systemPromptCache';
import { DEFAULT_MODELS, MODEL_MAX_TOKENS, CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW, TOOL_PROGRESS, TOOL_TIMEOUT_THRESHOLDS } from '../../../shared/constants';

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
import { getPromptForTask, buildDynamicPromptV2, type AgentMode } from '../../prompts/builder';
import { AntiPatternDetector } from '../../agent/antiPattern/detector';
import { cleanXmlResidues } from '../../agent/antiPattern/cleanXml';
import { GoalTracker } from '../../agent/goalTracker';
import { NudgeManager } from '../../agent/nudgeManager';
import { getSessionRecoveryService } from '../../agent/sessionRecovery';
import { getIncompleteTasks } from '../../tools/planning/taskStore';
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
import { getTraceRecorder } from '../../evolution/traceRecorder';
import { getOutcomeDetector } from '../../evolution/outcomeDetector';
import { getInputSanitizer } from '../../security/inputSanitizer';
import { getDiffTracker } from '../../services/diff/diffTracker';
import { getCitationService } from '../../services/citation/citationService';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { getVerifierRegistry, initializeVerifiers } from '../../agent/verifier';
import type { VerificationContext, VerificationResult } from '../../agent/verifier';
import { analyzeTask } from '../../agent/hybrid/taskRouter';
import type { RuntimeContext } from './runtimeContext';



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

export class LearningPipeline {
  constructor(protected ctx: RuntimeContext) {}

  // Convenience: emit event through context
  protected onEvent(event: AgentEvent): void {
    this.ctx.onEvent(event);
  }

  async runSessionEndLearning(): Promise<void> {
    try {
      const memoryService = getMemoryService();
      const result = await memoryService.learnFromSession(this.ctx.messages);

      logger.info(
        `[AgentLoop] Session learning completed: ` +
        `${result.knowledgeExtracted} knowledge, ` +
        `${result.codeStylesLearned} code styles, ` +
        `${result.toolPreferencesUpdated} tool preferences`
      );

      logCollector.agent('INFO', 'Session learning completed', {
        knowledgeExtracted: result.knowledgeExtracted,
        codeStylesLearned: result.codeStylesLearned,
        toolPreferencesUpdated: result.toolPreferencesUpdated,
      });

      if (result.knowledgeExtracted > 0 || result.codeStylesLearned > 0) {
        this.ctx.onEvent({
          type: 'memory_learned',
          data: {
            sessionId: this.ctx.sessionId,
            knowledgeExtracted: result.knowledgeExtracted,
            codeStylesLearned: result.codeStylesLearned,
            toolPreferencesUpdated: result.toolPreferencesUpdated,
          },
        } as AgentEvent);
      }

      // 从会话中提取错误模式并学习
      await this.runErrorPatternLearning();

      // 清理低置信度的记忆
      const cleanedCount = memoryService.cleanupDecayedMemories();
      if (cleanedCount > 0) {
        logger.info(`[AgentLoop] Cleaned up ${cleanedCount} decayed memories`);
      }

      // 记录记忆衰减统计
      const decayStats = memoryService.getMemoryDecayStats();
      logger.debug('[AgentLoop] Memory decay stats', {
        total: decayStats.total,
        valid: decayStats.valid,
        needsCleanup: decayStats.needsCleanup,
        avgConfidence: decayStats.avgConfidence.toFixed(2),
      });


      // Continuous learning: pattern extraction + entity relations
      this.runContinuousLearning().catch((err: unknown) => {
        logger.debug('[AgentLoop] Continuous learning skipped:', { error: (err as Error).message });
      });
    } catch (error) {
      logger.debug('[AgentLoop] Session end learning failed:', { errorMessage: (error as Error).message });
    }
  }

  /**
   * 持续学习：从会话中提取模式并建立实体关系
   */

  async runContinuousLearning(): Promise<void> {
    if (!this.ctx.sessionId || this.ctx.messages.length < 4) return;

    const cls = getContinuousLearningService();
    const result = await cls.learnFromSession(this.ctx.sessionId, this.ctx.messages);

    if (!result || result.patternsExtracted === 0) return;

    logger.info(
      `[AgentLoop] Continuous learning: ${result.patternsExtracted} patterns, ${result.skillsSynthesized} skills`
    );

    // Write extracted patterns as entity relations via SQLite database (with dedup)
    try {
      const { getDatabase } = await import('../../services/core/databaseService');
      const { getMemoryDeduplicator } = await import('../../memory/memoryDeduplicator');
      const db = getDatabase();
      const dedup = getMemoryDeduplicator(db);

      // Collect all candidate relations first
      const candidates: Array<{
        sourceId: string;
        targetId: string;
        relationType: 'modifies' | 'references';
        confidence: number;
        evidence: string;
        sessionId: string;
      }> = [];

      for (const pattern of result.patterns || []) {
        if (pattern.confidence < 0.7) continue;

        const filesModified: string[] = pattern.context?.filesModified || [];
        const toolsUsed: string[] = pattern.context?.toolsUsed || [];

        for (const file of filesModified.slice(0, 5)) {
          for (const tool of toolsUsed.slice(0, 5)) {
            candidates.push({
              sourceId: file,
              targetId: tool,
              relationType: 'modifies',
              confidence: pattern.confidence,
              evidence: (pattern.content || pattern.type || '').substring(0, 200),
              sessionId: this.ctx.sessionId!,
            });
          }
        }

        // File co-modification relations
        for (let i = 0; i < Math.min(filesModified.length, 5); i++) {
          for (let j = i + 1; j < Math.min(filesModified.length, 5); j++) {
            candidates.push({
              sourceId: filesModified[i],
              targetId: filesModified[j],
              relationType: 'references',
              confidence: pattern.confidence * 0.8,
              evidence: `Co-modified in pattern: ${pattern.type}`,
              sessionId: this.ctx.sessionId!,
            });
          }
        }
      }

      // Deduplicate before writing
      const { toInsert, toMerge } = dedup.deduplicateRelations(candidates);
      for (const rel of toInsert) {
        db.addRelation(rel);
      }
      for (const { existingId, candidate } of toMerge) {
        db.updateRelationConfidence(existingId, candidate.confidence, candidate.evidence);
      }
    } catch (err) {
      logger.debug('[AgentLoop] Entity relation writing failed:', { error: (err as Error).message });
    }
  }

  /**
   * 从会话中提取错误模式并学习
   */

  async runErrorPatternLearning(): Promise<void> {
    try {
      const memoryService = getMemoryService();

      // 从消息历史中提取错误
      for (const message of this.ctx.messages) {
        if (message.toolResults && message.toolCalls) {
          // 创建 toolCallId -> toolName 映射
          const toolCallMap = new Map<string, string>();
          for (const tc of message.toolCalls) {
            toolCallMap.set(tc.id, tc.name);
          }

          for (const result of message.toolResults) {
            if (!result.success && result.error) {
              // 通过 toolCallId 获取工具名称
              const toolName = toolCallMap.get(result.toolCallId) || 'unknown';

              // 记录错误到学习服务
              memoryService.recordError(
                result.error,
                {
                  toolName,
                  sessionId: this.ctx.sessionId,
                  timestamp: message.timestamp,
                },
                toolName
              );

              // 检查后续是否有成功的重试（简单启发式）
              const errorTime = message.timestamp;
              const laterSuccess = this.ctx.messages.some((m) => {
                if (m.timestamp <= errorTime) return false;
                if (!m.toolResults || !m.toolCalls) return false;
                // 检查是否有同一工具的成功调用
                const laterToolMap = new Map<string, string>();
                for (const tc of m.toolCalls) {
                  laterToolMap.set(tc.id, tc.name);
                }
                return m.toolResults.some((r) => {
                  const laterToolName = laterToolMap.get(r.toolCallId);
                  return laterToolName === toolName && r.success;
                });
              });

              if (laterSuccess) {
                // 如果后来同一工具成功了，记录为已解决
                const pattern = memoryService.getSuggestedErrorFixes(result.error, toolName);
                if (pattern.length > 0) {
                  memoryService.recordErrorResolution(
                    `${toolName}:${result.error.slice(0, 50)}`,
                    'retry_with_modification',
                    true
                  );
                }
              }
            }
          }
        }
      }

      // 记录错误学习统计
      const errorStats = memoryService.getErrorLearningStats();
      if (errorStats.totalErrors > 0) {
        logger.info('[AgentLoop] Error learning stats', {
          totalPatterns: errorStats.totalPatterns,
          totalErrors: errorStats.totalErrors,
          topCategories: Object.entries(errorStats.byCategory)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([cat, count]) => `${cat}:${count}`)
            .join(', '),
        });
      }
    } catch (error) {
      logger.error('[AgentLoop] Error pattern learning failed:', error);
    }
  }
}
