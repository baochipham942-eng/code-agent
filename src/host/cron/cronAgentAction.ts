// ============================================================================
// CronAgentAction - executeAction 的 agent 分支执行体
// ============================================================================
// 自 cronService.ts 原样搬出（N-MAXLINES-MINEFIELD-2-FU1-S9，move-only）：控制流、
// 错误处理、日志文本与 await 顺序逐字节保留；原先经 this 触达的三个成员
// （jobs.get(definition.id)?.definition / updateJob / deliverCronResult）改由
// host 闭包显式传入，接线点在 cronService.executeAction 的 case 'agent'。
// ============================================================================

import { UNATTENDED_TRUST_NOTICE } from '../../shared/unattendedTrust';
import { CRON_AGENT_SNAPSHOT, EXTERNAL_WATCH } from '../../shared/constants';
import type { AgentAction, CronJobDefinition } from '../../shared/contract/cron';
import {
  buildCronAgentActionResult,
  cronAgentRunHasAlert,
} from './cronNormalizers';
import { createCronAgentSession } from './cronAgentSession';
import { buildCronAgentRunOptions } from './cronAgentRoleContext';
import { BACKGROUND_AGENT_EVENT_FILTER } from '../protocol/events/eventFilter';
import type { AgentRunOptions } from '../research/types';
import { appendCronAgentExpertThreadReceipt } from './cronAgentExpertThreadReceipt';
import { buildCronAgentPrompt, truncateUtf8Snapshot } from './cronAgentPrompt';
import { beginArtifactRefresh, finishArtifactRefresh } from './artifactStandingRefresh';
import { runWithCronJobBudget } from './cronExecutionPolicy';
import { cronNotifyQuietRound } from './cronFailurePolicy';
import { getCronAutomationType } from './cronAutomationBridge';
import { parseStatedEventDecisions } from './cronEventDecisions';
import { enterObserveModeForCronRun } from './cronObserveMode';

export interface CronAgentActionHost {
  /** 从内存 job 表取该任务当前定义（快照写回与常设刷新结算都要最新底稿）。 */
  loadJob: (jobId: string) => CronJobDefinition | undefined;
  /** 即 CronService.updateJob：快照写回、常设刷新结算落库。 */
  updateJob: (jobId: string, updates: Partial<Omit<CronJobDefinition, 'id' | 'createdAt'>>) => Promise<unknown>;
  /** 即 CronService.deliverCronResult：安静轮判定通过后的通道推送。 */
  deliverCronResult: (definition: CronJobDefinition, result: unknown, executionId?: string) => Promise<void>;
}

export async function executeCronAgentAction(
  host: CronAgentActionHost,
  definition: CronJobDefinition,
  action: AgentAction,
  executionId?: string,
  eventPayloadBlock?: string,
): Promise<unknown> {
  const runStartedAt = Date.now();
  // Heartbeat 任务: 检查 active_hours 窗口
  const ctx = action.context as Record<string, unknown> | undefined;
  if (ctx?.heartbeatTask && ctx?.activeHours) {
    const { isWithinActiveHours } = await import('./heartbeatTaskLoader');
    if (!isWithinActiveHours(ctx.activeHours as string)) {
      console.error(`[CronService] Heartbeat task skipped (outside active hours: ${ctx.activeHours})`);
      return { skipped: true, reason: 'outside_active_hours' };
    }
  }

  // 通过 TaskManager 获取 orchestrator（避免 cronService → bootstrap 循环依赖）
  const { getTaskManager } = await import('../task');
  const tm = getTaskManager();
  const cronSession = await createCronAgentSession(definition, action, executionId);
  const orchestrator = tm.getOrCreateCurrentOrchestrator(cronSession.id) ?? null;
  if (!orchestrator) {
    throw new Error(`AgentOrchestrator not available for cron session ${cronSession.id}`);
  }
  // cron/heartbeat 无人值守会话标 async_agent（2026-07-13 拍板）：bash 走
  // ask+forceConfirm，无人应答由 requestPermission 60s 超时 deny 兜底，
  // 与 readOnly 会话档双保险。必须在 sendMessage 前标注。
  orchestrator.setExecutionTopology('async_agent');
  if (cronSession.workingDirectory) {
    tm.setWorkingDirectory(cronSession.id, cronSession.workingDirectory);
  }
  const agentRunOptions: AgentRunOptions = {
    inputSource: 'automation',
    disableAutoAgent: true,
    mode: 'normal',
    ...await buildCronAgentRunOptions(action.roleId, cronSession.workingDirectory),
    eventFilter: BACKGROUND_AGENT_EVENT_FILTER,
  };
  agentRunOptions.systemInstructions = [UNATTENDED_TRUST_NOTICE];
  const previousSnapshot = ctx?.[CRON_AGENT_SNAPSHOT.CONTEXT_KEY];
  const snapshotTrackingEnabled = ctx?.[CRON_AGENT_SNAPSHOT.ENABLED_KEY] === true;
  // external_event（业务事件监听）任务：无 <cron_alert> = 无新料 = 本次安静。
  // notifyWhen / urgencyCriteria 的「值得打扰」判据收口在 cronAgentRunHasAlert。
  const isExternalWatch = Boolean(ctx?.[EXTERNAL_WATCH.CONTEXT_KEY]);

  let result: unknown; let finalAssistantText = '';
  let runError: unknown; let runFailed = false;
  // 常设刷新（metadata.artifactRefresh）：跑前建快照记基线；非刷新任务返回 undefined 零扰动
  const artifactRefresh = beginArtifactRefresh(definition);
  // 观察档（N-TRIGGER-OBSERVE-MODE）：本会话的对外副作用调用由 ToolExecutor 拦下记 would_act。
  const leaveObserveMode = enterObserveModeForCronRun(definition, cronSession.id, executionId);
  try {
    try {
      // 事件触发时通道载荷只以 untrusted 定界块追加在 prompt 尾部，并给该条
      // 用户消息标 memoryTainted（跳过自动记忆写）。调度触发的 run 字节不变。
      const sendMessage = () => orchestrator.sendMessage(
        buildCronAgentPrompt(action.prompt, previousSnapshot, snapshotTrackingEnabled, undefined, action.urgencyCriteria, action.notifyWhen)
          + (eventPayloadBlock === undefined ? '' : `\n\n${eventPayloadBlock}`),
        undefined,
        agentRunOptions,
        eventPayloadBlock === undefined ? undefined : { memoryTainted: true },
      );
      result = await runWithCronJobBudget(definition.maxRunBudget, sendMessage);
      const unattendedTimeout = (await import('../agent/unattendedApprovalTerminal')).takeUnattendedApprovalTimeout(cronSession.id);
      if (unattendedTimeout) throw new Error(unattendedTimeout);

      finalAssistantText = [...orchestrator.getMessages()].reverse().find((message) => message.role === 'assistant')?.content.trim() ?? '';
      const snapshotToPersist = snapshotTrackingEnabled ? finalAssistantText.match(CRON_AGENT_SNAPSHOT.TAG_PATTERN)?.[1]?.trim() : undefined;
      // 只认标记：解析不到就保留上一次的值。拿整段回答顶替会把叙述性文字
      // 当成状态存下来，下一轮再原样注回提示词。
      if (snapshotToPersist) {
        const boundedSnapshot = truncateUtf8Snapshot(snapshotToPersist);
        if (boundedSnapshot.truncated) {
          console.warn(
            `[CronService] Agent snapshot exceeded ${CRON_AGENT_SNAPSHOT.MAX_BYTES} UTF-8 bytes; truncated`,
          );
        }
        const latestDefinition = host.loadJob(definition.id);
        const latestAction = latestDefinition?.action.type === 'agent'
          ? latestDefinition.action
          : action;
        await host.updateJob(definition.id, {
          action: {
            ...latestAction,
            context: {
              ...latestAction.context,
              [CRON_AGENT_SNAPSHOT.CONTEXT_KEY]: boundedSnapshot.value,
            },
          },
        });
      }

      if (action.libraryProjectId) {
        try {
          const { getLibraryService } = await import('../services/library/libraryService');
          if (finalAssistantText) {
            getLibraryService().archiveText({
              projectId: action.libraryProjectId,
              title: definition.name,
              text: finalAssistantText,
              tags: ['定稿'],
              sourceSessionId: cronSession.id,
              sourceRoleId: action.roleId,
            });
            console.error(`[CronService] agent 产出已归档到资料库 project=${action.libraryProjectId}`);
          }
        } catch (archiveError) {
          // 归档是增量能力，失败不拖垮任务（fail-loud 日志，不中断）
          console.warn('[CronService] agent 产出归档失败（任务本身已完成）', archiveError);
        }
      }
    } catch (error) {
      runFailed = true;
      runError = ((code: string | undefined) => code ? new Error(code) : error)((await import('../agent/unattendedApprovalTerminal')).takeUnattendedApprovalTimeout(cronSession.id));
      try {
        const lastAssistant = [...orchestrator.getMessages()].reverse().find((message) => message.role === 'assistant');
        finalAssistantText = lastAssistant?.content.trim() ?? '';
      } catch (messageReadError) {
        console.warn('[CronService] Failed to read partial agent conclusion after cron run failure', messageReadError);
      }
    }
  } finally {
    leaveObserveMode();
    tm.cleanup(cronSession.id);
  }

  // runFailed 已知即结算常设刷新：成功走校验+留版（有标注则清），失败回滚快照并标注。
  // loadJob 重读当前定义：标注底稿用最新 metadata，不回退跑中保存的指令/节奏修改。
  if (artifactRefresh) await finishArtifactRefresh(artifactRefresh, { runFailed, error: runError, updateJob: (u) => host.updateJob(definition.id, u), loadJob: () => host.loadJob(definition.id) });

  if (action.roleId) {
    try {
      await appendCronAgentExpertThreadReceipt({
        definition,
        roleId: action.roleId,
        cronSessionId: cronSession.id,
        executionId,
        startedAt: runStartedAt,
        succeeded: !runFailed,
        finalAssistantText,
        error: runError,
        automationType: getCronAutomationType(definition),
        workingDirectory: cronSession.workingDirectory,
      });
    } catch (receiptError) {
      console.warn(
        `[CronService] Failed to append named-agent cron receipt; cron result preserved `
        + `(job=${definition.id}, role=${action.roleId}, cronSession=${cronSession.id})`,
        receiptError,
      );
    }
  }
  if (runFailed) {
    // 失败也把 cron 会话带出去（挂在 error 上）：失败告警（去重+冷却后）要能
    // 点击跳到这个半成品会话，执行台账也能关联到它。成功路径走 result.sessionId。
    if (runError instanceof Error && !('cronSessionId' in runError)) {
      (runError as Error & { cronSessionId?: string }).cronSessionId = cronSession.id;
    }
    throw runError;
  }

  // 安静轮判定单点：hasAlert 走 cronAgentRunHasAlert——gated（external-watch/
  // notifyWhen）任务只认 <cron_alert>；仅 urgencyCriteria 的任务只认显式
  // can_wait/fyi 头；其余恒有警报。失败路径在上面已 throw，到这里必是成功轮。
  const hasAlert = cronAgentRunHasAlert(action, { isExternalWatch, finalAssistantText });

  // 无新料的监听轮不投递（FB-239）：skipped 判定必须先于推送，
  // 否则安静轮照样把「没有更新」推到通道，跟 skipped 语义无进收件箱自相矛盾。
  // notifyWhen 未满足的安静轮同样不投递（N-CRON-RESTATE-HUMAN-WHEN，判定+留痕
  // 在 cronFailurePolicy.cronNotifyQuietRound）：执行仍 completed、仍进历史与收件箱。
  const quietWatchRound = isExternalWatch && !hasAlert;
  const notifyQuietRound = cronNotifyQuietRound(action, hasAlert, definition.id);
  if (!quietWatchRound && !notifyQuietRound) {
    // 推送正文必须是最后一条 assistant 正文：orchestrator.sendMessage 是 Promise<void>，
    // result 恒 undefined，推它等于永远不推（PR#2060 ai-review Important）。
    await host.deliverCronResult(definition, finalAssistantText || result, executionId);
  }

  // 无新料的监听运行整成 skipped 形状：复用 isSkippedResult 门，
  // 让它不进待过目收件箱、不写会话回流（快照已在上面照常写回）。
  // 结果组装（digest + 紧急档位 N-CRON-INBOX-URGENCY-TIER）在 cronNormalizers：
  // cronService 贴 max-lines 线，档位优先读摘要头部行、无摘要块读正文头部。
  // notifyQuietRound 只打 notifySuppressed 标记（通知门），不进 skipped 形状。
  const actionResult = buildCronAgentActionResult(action, result, cronSession.id, finalAssistantText, quietWatchRound, notifyQuietRound);
  // 事件 run：模型逐事件陈述的 act/ignore + 理由带出去，供决策台账结算（cronEventDecisions）。
  const eventDecisions = eventPayloadBlock === undefined ? [] : parseStatedEventDecisions(finalAssistantText);
  return eventDecisions.length > 0 ? { ...actionResult, eventDecisions } : actionResult;
}
