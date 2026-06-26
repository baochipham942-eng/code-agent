// ============================================================================
// LearningPipeline — Session-end learning（GAP-005 重建）
// 跨会话经验沉淀，session 结束时两条链路：
//   (a) 重复失败模式（≥3 次）→ 全自动写入 Light Memory failure journal（telemetry）
//   (b) LLM 语义复盘 → class-level skill 草稿进待确认队列（conversationReview，严禁自动入库）
// 注：原 telemetry n-gram 成功蒸馏路已废弃移除——纯频次无语义会产 bash-bash-bash 垃圾草稿，
//   skill 沉淀统一走 (b) 的 LLM 反思路（见 内部文档）。
// 失败分类原料来自 telemetryCollector（telemetry_tool_calls 表），journal 长期整理复用 consolidation cron。
// ============================================================================

import type { AgentEvent } from '../../../shared/contract';
import type { TelemetryToolCall } from '../../../shared/contract/telemetry';
import type { RuntimeContext } from './runtimeContext';
import { getTelemetryStorage } from '../../telemetry/telemetryStorage';
import {
  recordFailurePatterns,
  buildFailurePatternKey,
  normalizeErrorMessage,
  type FailurePattern,
} from '../../lightMemory/failureJournal';
import {
  enqueueSkillDraft,
  type SkillDraftMeta,
} from '../../services/skills/skillDraftQueue';
import { reviewConversationForSkill } from '../../lightMemory/conversationReview';
import { broadcastToRenderer } from '../../platform/windowBridge';
import { LEARNING_PIPELINE, SKILL_REVIEW } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('LearningPipeline');

// ----------------------------------------------------------------------------
// 纯函数：模式提取（可单测）
// ----------------------------------------------------------------------------

/**
 * 从本 session 的工具调用中提取重复失败模式。
 * 按 toolName + errorCategory + 归一化错误消息分组，出现 ≥ 阈值才算模式。
 */
export function extractFailurePatterns(
  toolCalls: TelemetryToolCall[],
  sessionId: string,
): FailurePattern[] {
  const failed = toolCalls.filter((call) => !call.success && call.error);
  if (failed.length === 0) return [];

  const groups = new Map<string, FailurePattern>();
  for (const call of failed) {
    const errorCategory = call.errorCategory || 'unknown';
    const key = buildFailurePatternKey(call.name, errorCategory, call.error || '');
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      existing.lastSeen = Math.max(existing.lastSeen, call.timestamp);
    } else {
      groups.set(key, {
        key,
        toolName: call.name,
        errorCategory,
        pattern: normalizeErrorMessage(call.error || ''),
        count: 1,
        sessions: [sessionId],
        firstSeen: call.timestamp,
        lastSeen: call.timestamp,
        sampleError: (call.error || '').substring(0, 200),
      });
    }
  }

  return Array.from(groups.values()).filter(
    (pattern) => pattern.count >= LEARNING_PIPELINE.FAILURE_PATTERN_THRESHOLD,
  );
}

// ----------------------------------------------------------------------------
// LearningPipeline
// ----------------------------------------------------------------------------

export class LearningPipeline {
  constructor(protected ctx: RuntimeContext) {}

  // Convenience: emit event through context
  protected onEvent(event: AgentEvent): void {
    this.ctx.onEvent(event);
  }

  private emitSkillDraftPending(drafts: SkillDraftMeta[]): void {
    const event: AgentEvent = {
      type: 'skill_draft_pending',
      data: {
        sessionId: this.ctx.sessionId,
        drafts: drafts.map((draft) => ({
          id: draft.id,
          name: draft.name,
          description: draft.description,
          toolSequence: draft.toolSequence,
          occurrences: draft.occurrences,
          origin: draft.origin,
        })),
      },
    };

    this.onEvent(event);
    broadcastToRenderer('agent:event', event);
  }

  /**
   * Session 结束学习入口（runFinalizer 调用，fire-and-forget）。
   * 三条链路相互独立，单边失败不影响另一边：
   *   - 失败模式 / n-gram 成功蒸馏：依赖本会话 telemetry，无工具调用则跳过
   *   - LLM 语义复盘：读对话内容，即使没有工具调用（纯对话纠正）也值得沉淀
   */
  async runSessionEndLearning(): Promise<void> {
    const toolCalls = this.getSessionToolCalls();

    const passes: Promise<void>[] = [this.runConversationReviewDistillation()];
    if (toolCalls.length > 0) {
      passes.push(this.runErrorPatternLearning(toolCalls));
    }

    const results = await Promise.allSettled(passes);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('Learning pass failed', { reason: String(result.reason) });
      }
    }
  }

  /**
   * LLM 语义复盘蒸馏（半自动确认制）：读本会话对话内容，让 quick model 提炼一条
   * class-level skill 草稿（借鉴 Hermes background_review，看语义而非工具序列）。
   * 产出进 skill-drafts 队列由用户确认，绝不自动入库。
   */
  async runConversationReviewDistillation(): Promise<void> {
    const messages = this.ctx.messages ?? [];
    const userMessages = messages
      .filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => m.content as string);
    if (userMessages.length < SKILL_REVIEW.MIN_USER_TURNS) return;

    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0);
    const lastAssistantText = typeof lastAssistant?.content === 'string' ? lastAssistant.content : undefined;

    const reviewed = await reviewConversationForSkill({ userMessages, lastAssistant: lastAssistantText });
    if (!reviewed) return;

    const draft = await enqueueSkillDraft({
      name: reviewed.name,
      description: reviewed.description,
      // 以 skill 名做去重 key：同一类技能不重复打扰，被拒绝过的不再入队
      patternKey: `${SKILL_REVIEW.ORIGIN}:${reviewed.name}`,
      origin: SKILL_REVIEW.ORIGIN,
      body: reviewed.body,
      sessionId: this.ctx.sessionId,
    });
    if (!draft) return;

    logger.info('Conversation-review skill draft enqueued, awaiting user confirmation', {
      sessionId: this.ctx.sessionId,
      name: draft.name,
      signal: reviewed.signal,
    });
    this.emitSkillDraftPending([draft]);
  }

  /**
   * Failure Journal（全自动）：重复失败模式 → Light Memory。
   */
  async runErrorPatternLearning(toolCalls?: TelemetryToolCall[]): Promise<void> {
    const calls = toolCalls ?? this.getSessionToolCalls();
    const patterns = extractFailurePatterns(calls, this.ctx.sessionId);
    if (patterns.length === 0) return;

    const written = await recordFailurePatterns(patterns);
    if (written > 0) {
      logger.info('Failure patterns recorded to journal', {
        sessionId: this.ctx.sessionId,
        patterns: written,
      });
      this.onEvent({
        type: 'memory_learned',
        data: {
          sessionId: this.ctx.sessionId,
          knowledgeExtracted: written,
          codeStylesLearned: 0,
          toolPreferencesUpdated: 0,
        },
      });
    }
  }

  private getSessionToolCalls(): TelemetryToolCall[] {
    try {
      return getTelemetryStorage().getToolCallsBySession(this.ctx.sessionId);
    } catch (error) {
      logger.debug('Telemetry unavailable for learning', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
