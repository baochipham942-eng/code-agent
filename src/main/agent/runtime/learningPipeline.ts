// ============================================================================
// LearningPipeline — Session-end learning（GAP-005 重建）
// 跨会话经验沉淀：session 结束时从 telemetry 提取
//   (a) 重复失败模式（≥3 次）→ 全自动写入 Light Memory failure journal
//   (b) 重复成功模式（≥3 次）→ 生成 skill 草稿进待确认队列（严禁自动入库）
// 原料来自 telemetryCollector 的失败分类持久化（telemetry_tool_calls 表），
// journal 的长期整理复用 lightMemory consolidation cron。
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
  type SkillDraftStep,
} from '../../services/skills/skillDraftQueue';
import { reviewConversationForSkill } from '../../lightMemory/conversationReview';
import { LEARNING_PIPELINE, SKILL_REVIEW } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('LearningPipeline');

// ----------------------------------------------------------------------------
// 纯函数：模式提取（可单测）
// ----------------------------------------------------------------------------

export interface SuccessPattern {
  /** 工具序列去重 key */
  key: string;
  toolSequence: string[];
  /** 该序列在本 session 中成功出现的次数 */
  count: number;
  /** 首次出现时各步骤的示例参数 */
  exampleSteps: SkillDraftStep[];
}

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

/**
 * 从本 session 的工具调用中提取重复成功模式（连续成功调用的 n-gram 序列）。
 * 序列在失败调用处断开；同一序列出现 ≥ 阈值才算模式；
 * 子序列被更长的合格序列覆盖时不重复报告。
 */
export function extractSuccessPatterns(toolCalls: TelemetryToolCall[]): SuccessPattern[] {
  // 按时间排序后切成连续成功段
  const sorted = [...toolCalls].sort((a, b) => a.timestamp - b.timestamp);
  const runs: TelemetryToolCall[][] = [];
  let current: TelemetryToolCall[] = [];
  for (const call of sorted) {
    if (call.success) {
      current.push(call);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);

  // 提取 n-gram 并计数
  const { SUCCESS_SEQUENCE_MIN_LENGTH: minLen, SUCCESS_SEQUENCE_MAX_LENGTH: maxLen } = LEARNING_PIPELINE;
  const counts = new Map<string, { sequence: string[]; count: number; firstSteps: SkillDraftStep[] }>();

  for (const run of runs) {
    for (let n = minLen; n <= maxLen; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const window = run.slice(i, i + n);
        const sequence = window.map((call) => call.name);
        const key = sequence.join(' → ');
        const existing = counts.get(key);
        if (existing) {
          existing.count++;
        } else {
          counts.set(key, {
            sequence,
            count: 1,
            firstSteps: window.map((call) => ({
              toolName: call.name,
              args: parseToolArguments(call.arguments),
            })),
          });
        }
      }
    }
  }

  const qualified = Array.from(counts.entries())
    .filter(([, value]) => value.count >= LEARNING_PIPELINE.SUCCESS_PATTERN_THRESHOLD)
    .map(([key, value]) => ({
      key,
      toolSequence: value.sequence,
      count: value.count,
      exampleSteps: value.firstSteps,
    }));

  // 去掉被更长合格序列覆盖的子序列
  return qualified.filter((pattern) =>
    !qualified.some(
      (other) =>
        other !== pattern
        && other.toolSequence.length > pattern.toolSequence.length
        && other.key.includes(pattern.key),
    ),
  );
}

function parseToolArguments(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 从工具序列生成建议的 skill 名（kebab-case） */
export function suggestSkillName(toolSequence: string[]): string {
  return toolSequence
    .map((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .join('-')
    .slice(0, 48) || 'distilled-workflow';
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
      passes.push(this.runErrorPatternLearning(toolCalls), this.runSkillDistillation(toolCalls));
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
   * class-level skill 草稿（借鉴 Hermes background_review）。与 telemetry n-gram 蒸馏互补——
   * 这条看语义、那条看工具序列。产出同样进 skill-drafts 队列由用户确认，绝不自动入库。
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
    this.onEvent({
      type: 'skill_draft_pending',
      data: {
        sessionId: this.ctx.sessionId,
        drafts: [{
          id: draft.id,
          name: draft.name,
          description: draft.description,
          toolSequence: draft.toolSequence,
          occurrences: draft.occurrences,
          origin: draft.origin,
        }],
      },
    });
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

  /**
   * Skill 蒸馏（半自动确认制）：重复成功模式 → 草稿队列 + 通知用户确认。
   * 严禁自动入库——草稿只有用户通过 skill:draft:confirm 确认后才进 skills 目录。
   */
  async runSkillDistillation(toolCalls?: TelemetryToolCall[]): Promise<void> {
    const calls = toolCalls ?? this.getSessionToolCalls();
    const patterns = extractSuccessPatterns(calls);
    if (patterns.length === 0) return;

    const enqueued: SkillDraftMeta[] = [];
    for (const pattern of patterns) {
      const draft = await enqueueSkillDraft({
        name: suggestSkillName(pattern.toolSequence),
        description: `自动蒸馏的工作流：${pattern.toolSequence.join(' → ')}（本会话成功 ${pattern.count} 次）`,
        patternKey: pattern.key,
        toolSequence: pattern.toolSequence,
        occurrences: pattern.count,
        sessionId: this.ctx.sessionId,
        exampleSteps: pattern.exampleSteps,
      });
      if (draft) enqueued.push(draft);
    }

    if (enqueued.length > 0) {
      logger.info('Skill drafts enqueued, awaiting user confirmation', {
        sessionId: this.ctx.sessionId,
        drafts: enqueued.map((draft) => draft.name),
      });
      // 通知前端弹确认卡片。走 ctx.onEvent → run SSE 流 → renderer agent:event
      // （与 suggestions_update / memory_learned 同一条产线通路；EventBus 桥接在
      //  webServer 架构下没有被启动，不能用）。
      this.onEvent({
        type: 'skill_draft_pending',
        data: {
          sessionId: this.ctx.sessionId,
          drafts: enqueued.map((draft) => ({
            id: draft.id,
            name: draft.name,
            description: draft.description,
            toolSequence: draft.toolSequence,
            occurrences: draft.occurrences,
            origin: draft.origin,
          })),
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
