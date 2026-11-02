// ============================================================================
// Cron Automation Bridge — 把 cron / heartbeat 定时任务接入会话级自动化闭环
// ----------------------------------------------------------------------------
// 这些桥接逻辑原先内联在 cronService 里，抽出来保持 cronService 在 god-file 阈值下。
// 纯函数 + 显式依赖（resolveRuntime）便于独立测试；行为与原内联实现完全一致。
// ============================================================================

import type {
  CronJobAction,
  CronJobDefinition,
  CronJobExecution,
  CronScheduleConfig,
} from '../../shared/contract/cron';
import { getSessionAutomationService } from '../services/sessionAutomation';
import type {
  SessionAutomationConfig,
  SessionAutomationNextStageConfig,
  SessionAutomationStatus,
  SessionAutomationType,
} from '../../shared/contract/sessionAutomation';
import { isCronUrgency } from '../../shared/cronUrgency';
import { resolveCronArtifactsForReview } from '../../shared/cronArtifactPath';
import { formatCronExpressionLabel } from '../../shared/cronHumanize';
import { parseCronLoginWallStop } from '../../shared/utils/browserLoginWall';
import { getDatabase } from '../services/core/databaseService';

/**
 * 解析定时任务对应的「运行时定义」（带最新 nextRunAt）。
 * cronService 注入：从内存 job 表取实时调度状态，取不到回退到原始 definition。
 */
export type ResolveRuntimeDefinition = (definition: CronJobDefinition) => CronJobDefinition;

const EVERY_UNIT_LABEL = {
  seconds: '秒',
  minutes: '分钟',
  hours: '小时',
  days: '天',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRunSessionWorkingDirectory(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  try {
    const session = getDatabase().getSession?.(sessionId);
    const cwd = session?.workingDirectory;
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readCronReviewSummaryLine(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const line = summary
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !/^urgency\s*:/i.test(item));
  return line ? line.slice(0, 120) : undefined;
}

function readCronReviewDigest(
  value: unknown,
  cwd: string | undefined,
): NonNullable<SessionAutomationConfig['pendingReview']>['digest'] | undefined {
  if (!isRecord(value) || !Array.isArray(value.artifacts)) return undefined;
  const summary = typeof value.summary === 'string' ? value.summary : undefined;
  const summaryLine = readCronReviewSummaryLine(summary);
  const artifacts = resolveCronArtifactsForReview(value.artifacts, cwd);
  if (artifacts.length === 0 && !summaryLine) return undefined;
  return {
    artifactCount: artifacts.length > 0 ? artifacts.length : value.artifacts.length,
    ...(summaryLine ? { summaryLine } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

/**
 * 源会话 id；面板/API 创建的任务没有源会话，返回 undefined。
 * 桥接层对 undefined 一律按 null 记录（automation 生命周期与待过目照常，
 * 仅跳过会话回流消息——writeAutomationMessage 对空 sourceSessionId 有守卫）。
 */
export function readCronSourceSessionId(
  definition: CronJobDefinition,
  action: CronJobAction = definition.action,
): string | undefined {
  const metadataSource = definition.metadata?.sourceSessionId;
  if (typeof metadataSource === 'string' && metadataSource.trim()) return metadataSource;
  if (action.type === 'agent') {
    const contextSource = action.context?.sourceSessionId;
    if (typeof contextSource === 'string' && contextSource.trim()) return contextSource;
  }
  return undefined;
}

export function getCronAutomationType(
  definition: CronJobDefinition,
  action: CronJobAction = definition.action,
): SessionAutomationType {
  if (action.type === 'agent' && action.context?.externalWatch) return 'external_event';
  return action.type === 'agent' && action.context?.heartbeatTask ? 'heartbeat' : 'cron';
}

function readAutomationNextStage(value: unknown): SessionAutomationNextStageConfig | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = typeof value.prompt === 'string' && value.prompt.trim() ? value.prompt.trim() : undefined;
  const goal = typeof value.goal === 'string' && value.goal.trim() ? value.goal.trim() : undefined;
  const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : undefined;
  if (!prompt && !goal && !title) return undefined;
  return {
    ...(prompt ? { prompt } : {}),
    ...(goal ? { goal } : {}),
    ...(title ? { title } : {}),
  };
}

export function buildCronAutomationConfig(definition: CronJobDefinition): SessionAutomationConfig {
  const handoffPrompt =
    typeof definition.metadata?.handoffPrompt === 'string' && definition.metadata.handoffPrompt.trim()
      ? definition.metadata.handoffPrompt.trim()
      : undefined;
  const nextStage = readAutomationNextStage(definition.metadata?.nextStage);
  return {
    createdVia: typeof definition.metadata?.createdVia === 'string' ? definition.metadata.createdVia : 'cron',
    runsOn: definition.runsOn,
    sourceMessageId: typeof definition.metadata?.sourceMessageId === 'string' ? definition.metadata.sourceMessageId : undefined,
    scheduleType: definition.scheduleType,
    actionType: definition.action.type,
    ...(handoffPrompt ? { handoffPrompt } : {}),
    ...(nextStage ? { nextStage } : {}),
  };
}

export function formatCronScheduleLabel(schedule: CronScheduleConfig): string {
  switch (schedule.type) {
    case 'every':
      return `每 ${schedule.interval} ${EVERY_UNIT_LABEL[schedule.unit]}`;
    case 'at': {
      const ts = typeof schedule.datetime === 'number' ? schedule.datetime : Date.parse(String(schedule.datetime));
      return Number.isFinite(ts)
        ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '一次性';
    }
    case 'cron':
      // cron 表达式说人话（FB-326）：`17 8 * * *` → 「每天 08:17」；复杂式回退「自定义时间 · 原文」。
      return formatCronExpressionLabel(schedule.expression, schedule.timezone, 'zh');
    default:
      return '按配置';
  }
}

/** 无新料的 external_event 运行整成 skipped 形状（见 cronService.ts executeAction）。 */
export function isSkippedResult(result: unknown): boolean {
  return isRecord(result) && result.skipped === true;
}

export async function recordCronAutomationCreated(
  definition: CronJobDefinition,
  resolveRuntime: ResolveRuntimeDefinition,
): Promise<void> {
  const sourceSessionId = readCronSourceSessionId(definition) ?? null;
  try {
    const withRuntimeState = resolveRuntime(definition);
    await getSessionAutomationService().recordCreated({
      id: `${getCronAutomationType(definition)}:${definition.id}`,
      sourceSessionId,
      type: getCronAutomationType(definition),
      status: definition.enabled ? 'active' : 'paused',
      title: definition.name,
      cadenceLabel: formatCronScheduleLabel(definition.schedule),
      nextRunAt: withRuntimeState.nextRunAt,
      sourceRefId: definition.id,
      config: buildCronAutomationConfig(definition),
    });
  } catch (error) {
    console.error('[CronService] Failed to record automation creation:', error);
  }
}

export function syncCronAutomationFromJob(
  definition: CronJobDefinition,
  resolveRuntime: ResolveRuntimeDefinition,
): void {
  const sourceSessionId = readCronSourceSessionId(definition) ?? null;
  try {
    const withRuntimeState = resolveRuntime(definition);
    getSessionAutomationService().upsert({
      id: `${getCronAutomationType(definition)}:${definition.id}`,
      sourceSessionId,
      type: getCronAutomationType(definition),
      status: definition.enabled ? 'active' : 'paused',
      title: definition.name,
      cadenceLabel: formatCronScheduleLabel(definition.schedule),
      nextRunAt: withRuntimeState.nextRunAt,
      sourceRefId: definition.id,
      config: buildCronAutomationConfig(definition),
    });
  } catch (error) {
    console.error('[CronService] Failed to sync automation from job:', error);
  }
}

export async function recordCronAutomationArchived(definition: CronJobDefinition): Promise<void> {
  const sourceSessionId = readCronSourceSessionId(definition) ?? null;
  try {
    const service = getSessionAutomationService();
    if (!service.getBySourceRef(getCronAutomationType(definition), definition.id)) {
      service.upsert({
        id: `${getCronAutomationType(definition)}:${definition.id}`,
        sourceSessionId,
        type: getCronAutomationType(definition),
        status: 'active',
        title: definition.name,
        cadenceLabel: formatCronScheduleLabel(definition.schedule),
        sourceRefId: definition.id,
        config: buildCronAutomationConfig(definition),
      });
    }
    await service.recordEvent({
      type: getCronAutomationType(definition),
      sourceRefId: definition.id,
      event: 'cancelled',
      status: 'cancelled',
      summary: '定时任务已删除。',
      eventId: `cancelled:${definition.id}`,
    });
  } catch (error) {
    console.error('[CronService] Failed to archive automation:', error);
  }
}

export async function recordCronAutomationExecution(
  definition: CronJobDefinition,
  execution: CronJobExecution,
  resolveRuntime: ResolveRuntimeDefinition,
): Promise<void> {
  const sourceSessionId = readCronSourceSessionId(definition) ?? null;
  try {
    const service = getSessionAutomationService();
    const withRuntimeState = resolveRuntime(definition);
    const existing = service.getBySourceRef(getCronAutomationType(definition), definition.id);
    if (!existing) {
      service.upsert({
        id: `${getCronAutomationType(definition)}:${definition.id}`,
        sourceSessionId,
        type: getCronAutomationType(definition),
        status: definition.enabled ? 'active' : 'paused',
        title: definition.name,
        cadenceLabel: formatCronScheduleLabel(definition.schedule),
        nextRunAt: withRuntimeState.nextRunAt,
        sourceRefId: definition.id,
        config: buildCronAutomationConfig(definition),
      });
    }
    const skipped = execution.status === 'completed' && isSkippedResult(execution.result);
    const loginWall = parseCronLoginWallStop(execution.error);
    const event = skipped ? 'skipped' : execution.status === 'failed' ? 'failed' : 'completed';
    const eventStatus: SessionAutomationStatus = skipped
      ? 'skipped'
      : execution.status === 'failed'
        ? 'failed'
        : 'completed';
    const keepActive = definition.enabled && definition.scheduleType !== 'at';
    // 成功且有结果会话的 agent 运行进入「待过目」：一次性任务状态落 pending_review；
    // recurring 记录保持 active，用 config.pendingReview 标记最近一次待审运行。
    const reviewable = !skipped && execution.status === 'completed'
      && definition.action.type === 'agent' && Boolean(execution.sessionId);
    // 紧急档位透传（N-CRON-INBOX-URGENCY-TIER）：agent 结果由 cronService 带上 urgency/
    // urgencyRaw；非 agent 结果与老记录没有这两个字段，收件箱按 fyi 呈现。
    const resultRecord = isRecord(execution.result) ? execution.result : undefined;
    const urgencyValue = resultRecord?.urgency;
    const urgency = isCronUrgency(urgencyValue) ? urgencyValue : undefined;
    const urgencyRaw = typeof resultRecord?.urgencyRaw === 'string' ? resultRecord.urgencyRaw : undefined;
    const digest = readCronReviewDigest(
      resultRecord?.digest,
      readRunSessionWorkingDirectory(execution.sessionId),
    );
    const recordStatus: SessionAutomationStatus = keepActive
      ? 'active'
      : reviewable
        ? 'pending_review'
        : eventStatus;
    await service.recordEvent({
      type: getCronAutomationType(definition),
      sourceRefId: definition.id,
      event,
      status: eventStatus,
      recordStatus,
      ...(reviewable
        ? { configPatch: { pendingReview: {
          resultSessionId: execution.sessionId,
          at: execution.completedAt ?? Date.now(),
          ...(urgency ? { urgency } : {}),
          ...(urgencyRaw ? { urgencyRaw } : {}),
          ...(digest ? { digest } : {}),
        } } }
        : loginWall
          ? { configPatch: { loginWall: { siteOrigin: loginWall.siteOrigin, at: execution.completedAt ?? Date.now() } } }
          : {}),
      resultSessionId: execution.sessionId,
      summary: skipped
        ? '当前触发被跳过。'
        : execution.status === 'failed'
          ? undefined
          : '定时任务已完成。',
      error: execution.error,
      eventId: `execution:${execution.id}`,
      nextRunAt: withRuntimeState.nextRunAt,
      lastRunAt: execution.completedAt,
    });
  } catch (error) {
    console.error('[CronService] Failed to record automation execution:', error);
  }
}

/**
 * 执行档切换写进自动化变更历史（N-TRIGGER-OBSERVE-MODE）：event 'action_mode_changed'，
 * configPatch 记下当前档与切换时刻。没有自动化记录时先补建（同 archived 先例）。
 * 与其它 record* 不同：这里**不吞错**——变更记不下来，切换就不能生效（调用方先记后落库）。
 */
export async function recordCronAutomationActionModeChanged(
  definition: CronJobDefinition,
  from: 'observe' | 'auto',
  to: 'observe' | 'auto',
): Promise<void> {
  const sourceSessionId = readCronSourceSessionId(definition) ?? null;
  const service = getSessionAutomationService();
  const existing = service.getBySourceRef(getCronAutomationType(definition), definition.id);
  if (!existing) {
    service.upsert({
      id: `${getCronAutomationType(definition)}:${definition.id}`,
      sourceSessionId,
      type: getCronAutomationType(definition),
      status: definition.enabled ? 'active' : 'paused',
      title: definition.name,
      cadenceLabel: formatCronScheduleLabel(definition.schedule),
      sourceRefId: definition.id,
      config: buildCronAutomationConfig(definition),
    });
  }
  const recorded = await service.recordEvent({
    type: getCronAutomationType(definition),
    sourceRefId: definition.id,
    event: 'action_mode_changed',
    summary: to === 'auto'
      ? '执行方式已切换为「自动执行」：之后的事件运行会真实发送回复与邮件。'
      : '执行方式已切换为「仅观察」：之后的事件运行只记录本会做什么，不发送任何内容。',
    eventId: `action_mode:${definition.id}:${definition.updatedAt}`,
    ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
    configPatch: { actionMode: to, actionModeChange: { from, to, at: definition.updatedAt } },
  });
  if (!recorded) throw new Error(`Automation record for cron job ${definition.id} is missing; action-mode change not recorded.`);
}

/**
 * 读回最近一次执行档切换（返修⑥：让「切换已记入变更历史」在详情页可见）。
 * 数据源就是 recordCronAutomationActionModeChange 写进自动化记录 config 的
 * actionModeChange；读不到（记录缺失/形状不对）返回 null，静默降级。
 */
export function readCronAutomationActionModeChange(
  definition: CronJobDefinition,
): { from: 'observe' | 'auto'; to: 'observe' | 'auto'; at: number } | null {
  try {
    const record = getSessionAutomationService()
      .getBySourceRef(getCronAutomationType(definition), definition.id);
    const change = record?.config?.actionModeChange;
    if (!change || typeof change !== 'object') return null;
    const { from, to, at } = change as Record<string, unknown>;
    if ((from !== 'observe' && from !== 'auto') || (to !== 'observe' && to !== 'auto')) return null;
    if (typeof at !== 'number') return null;
    return { from, to, at };
  } catch {
    return null;
  }
}
