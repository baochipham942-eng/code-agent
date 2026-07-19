import { useCallback } from 'react';
import type React from 'react';
import type { MessageAttachment } from '@shared/contract';
import type {
  ComposerAgentSelection,
  ComposerPromptCommandSelection,
  ConversationEnvelope,
  ConversationVoiceInputMetadata,
  RuntimeInputMode,
} from '@shared/contract/conversationEnvelope';
import type { SteerOrQueueOutcome } from '@shared/contract/appService';
import { buildAppshotXml, buildAppshotAttachment } from '@shared/contract/appshot';
import { buildGoalSeedTodos } from '@shared/utils/goalTodos';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useAppshotsStore } from '../../../../stores/appshotsStore';
import { useLoopStore } from '../../../../stores/loopStore';
import { cronClient, type CreateCronJobInput } from '../../../../services/cronClient';
import { loopClient } from '../../../../services/loopClient';
import { invoke } from '../../../../services/ipcService';
import { buildGoalNoticeMessage } from '../goalNotice';
import { buildAutomationNoticeMessage, formatCronScheduleLabel, formatLoopIntervalLabel } from '../automationNotice';
import type { InputAreaRef } from './InputArea';
import type { BuildEnvelope } from './useChatInputEnvelope';
import { IPC_CHANNELS } from '@shared/ipc';
import { parseScheduleCommand, isScheduleCommand } from './parseScheduleCommand';
import { parseLoopCommand, isLoopCommand } from './parseLoopCommand';
import {
  parseGoalCommand,
  isGoalCommand,
  normalizeGoalCommand,
  type ParsedGoalCommand,
} from './parseGoalCommand';
import { shouldOpenGoalConfirm } from './goalConfirm';
import { getAgentCommandToken, parseAgentSlashCommand } from './agentCommand';
import { shouldClearComposerAfterSend } from './utils';

type VoiceInputContextValue = {
  anchor: string;
  metadata: ConversationVoiceInputMetadata;
} | null;

export interface ParsedCompactCommand {
  focusText?: string;
}

export function parseCompactCommand(input: string): ParsedCompactCommand | null {
  const match = input.trim().match(/^\/compact(?:\s+(.*))?$/s);
  if (!match) return null;
  const focusText = match[1]?.trim();
  return focusText ? { focusText } : {};
}

export interface UseChatInputSubmitParams {
  value: string;
  attachments: MessageAttachment[];
  voiceInputContext: VoiceInputContextValue;
  pendingAppshot: Parameters<typeof buildAppshotAttachment>[0] | null;
  pendingPromptCommand: ComposerPromptCommandSelection | null;
  pendingAgentSelection: ComposerAgentSelection | null;
  currentSessionId: string | null;
  isProcessing?: boolean;
  disabled?: boolean;
  isUploading: boolean;
  onSend: (envelope: ConversationEnvelope) => boolean | Promise<boolean>;
  onSteer?: (envelope: ConversationEnvelope) => Promise<SteerOrQueueOutcome | undefined>;
  agentEntries: Parameters<typeof parseAgentSlashCommand>[1];
  buildEnvelope: BuildEnvelope;
  openAgentCommand: () => void;
  addToInputHistory: (entry: string) => void;
  clearAppshot: () => void;
  inputAreaRef: React.RefObject<InputAreaRef | null>;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  setAttachments: React.Dispatch<React.SetStateAction<MessageAttachment[]>>;
  setVoiceInputContext: React.Dispatch<React.SetStateAction<VoiceInputContextValue>>;
  setPendingPromptCommand: React.Dispatch<React.SetStateAction<ComposerPromptCommandSelection | null>>;
  setPendingAgentSelection: React.Dispatch<React.SetStateAction<ComposerAgentSelection | null>>;
  setScheduleComposerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** 打开 /goal 安静确认卡（initialGoal = 用户自然语言原话，空串 = 引导态） */
  openGoalConfirm: (initialGoal: string) => void;
  closeGoalConfirm: () => void;
  setActiveAgentId: (id: string | null) => void;
}

/**
 * ChatInput 的提交发送管线（全 app 最高风险路径）：
 * - runScheduleCreation：/schedule 自然语言 → 定时任务
 * - startGoalRun：/goal 自治模式启动
 * - handleSubmit：发送主链路（schedule/loop/goal/agent 命令分支 → appshot 注入
 *   → ! shell 快捷 → onSend → 失败 restoreDraft 回滚）
 * 纯结构性抽取自 index.tsx，零行为改动。
 */
export function useChatInputSubmit(params: UseChatInputSubmitParams) {
  const { t } = useI18n();
  const {
    value,
    attachments,
    voiceInputContext,
    pendingAppshot,
    pendingPromptCommand,
    pendingAgentSelection,
    currentSessionId,
    isProcessing,
    disabled,
    isUploading,
    onSend,
    onSteer,
    agentEntries,
    buildEnvelope,
    openAgentCommand,
    addToInputHistory,
    clearAppshot,
    inputAreaRef,
    setValue,
    setAttachments,
    setVoiceInputContext,
    setPendingPromptCommand,
    setPendingAgentSelection,
    setScheduleComposerOpen,
    openGoalConfirm,
    closeGoalConfirm,
    setActiveAgentId,
  } = params;

  // 定时任务创建统一入口：内联 /schedule 和对话式卡片都走这里（cron:generateFromPrompt → createJob）。
  const runScheduleCreation = useCallback(async (
    description: string,
    options: { handoffPrompt?: string } = {},
  ): Promise<boolean> => {
    const cs = t.chatInputSubmit;
    toast.info(cs.scheduleParsingToast);
    try {
      const draft = await cronClient.generateFromPrompt(description);
      const input = draft as unknown as CreateCronJobInput;
      const handoffPrompt = options.handoffPrompt?.trim();
      const action = input.action.type === 'agent' && currentSessionId
        ? {
            ...input.action,
            context: {
              ...(input.action.context ?? {}),
              sourceSessionId: currentSessionId,
            },
          }
        : input.action;
      const job = await cronClient.createJob({
        ...input,
        action,
        metadata: {
          ...(input.metadata ?? {}),
          ...(currentSessionId ? { sourceSessionId: currentSessionId } : {}),
          createdVia: 'slash_schedule',
          originalDescription: description,
          ...(handoffPrompt ? {
            handoffPrompt,
            nextStage: { prompt: handoffPrompt, title: cs.resumeAfterWakeTitle },
          } : {}),
        },
      });
      if (currentSessionId) {
        const automationType = job.action.type === 'agent' && job.action.context?.heartbeatTask ? 'heartbeat' : 'cron';
        useSessionStore.getState().addMessage(buildAutomationNoticeMessage({
          automationId: `${automationType}:${job.id}`,
          automationType,
          event: 'created',
          sourceSessionId: currentSessionId,
          sourceRefId: job.id,
          status: job.enabled ? 'active' : 'paused',
          title: job.name || cs.unnamedAutomation,
          cadenceLabel: formatCronScheduleLabel(job.schedule),
          nextRunAt: job.nextRunAt,
          handoffPrompt,
          nextStage: handoffPrompt ? { prompt: handoffPrompt, title: cs.resumeAfterWakeTitle } : undefined,
        }));
      }
      toast.success(`${cs.scheduleCreatedToastPrefix}${job.name || cs.unnamedSchedule}${cs.scheduleCreatedToastSuffix}`);
      return true;
    } catch (err) {
      toast.error(cs.scheduleCreateFailedPrefix + (err instanceof Error ? err.message : t.chatInput.unknownError));
      return false;
    }
  }, [currentSessionId, t]);

  const startGoalRun = useCallback(async (
    parsed: ParsedGoalCommand,
    historyEntry: string,
  ): Promise<boolean> => {
    const base = buildEnvelope(parsed.goal, attachments);
    const goalEnvelope: ConversationEnvelope = {
      ...base,
      options: {
        ...(base.options ?? {}),
        goal: {
          goal: parsed.goal,
          verify: parsed.verify,
          review: parsed.review,
          budget: parsed.budget,
          maxTurns: parsed.maxTurns,
          wallClockBudgetMs: parsed.wallClockBudgetMs,
        },
      },
    };
    if (currentSessionId) {
      useAppStore.getState().startGoalRun(currentSessionId, {
        goal: parsed.goal,
        maxTurns: parsed.maxTurns,
        tokenBudget: parsed.budget,
        wallClockBudgetMs: parsed.wallClockBudgetMs,
      });
      useSessionStore.getState().setTodos(buildGoalSeedTodos(parsed.goal));
    }
    useSessionStore.getState().addMessage(buildGoalNoticeMessage({ kind: 'start', goal: parsed.goal }));
    addToInputHistory(historyEntry);
    setValue('');
    setAttachments([]);
    closeGoalConfirm();
    try {
      const sent = await onSend(goalEnvelope);
      if (sent === false) {
        if (currentSessionId) useAppStore.getState().clearGoalRun(currentSessionId);
        return false;
      }
      return true;
    } catch {
      if (currentSessionId) useAppStore.getState().clearGoalRun(currentSessionId);
      return false;
    }
  }, [addToInputHistory, attachments, buildEnvelope, closeGoalConfirm, currentSessionId, onSend, setAttachments, setValue]);

  // 处理提交
  // 运行中允许提交，把新输入排到当前回复结束后发送。
  // P3-18: ! prefix executes shell command directly
  const handleSubmit = async (e?: React.FormEvent, opts?: { steer?: boolean }) => {
    e?.preventDefault();
    const trimmedValue = value.trim();
    let contentToSend = trimmedValue;
    let preferredAgentIdOverride: string | null | undefined;
    let selectedAgentOverride: ComposerAgentSelection | null | undefined;

    const compactCommand = parseCompactCommand(trimmedValue);
    if (compactCommand) {
      addToInputHistory(trimmedValue);
      setValue('');
      setVoiceInputContext(null);
      try {
        const result = await invoke(IPC_CHANNELS.CONTEXT_COMPACT_CURRENT, currentSessionId ?? undefined, compactCommand.focusText);
        if (result?.success) {
          toast.success(t.chatInputSubmit.contextCompactedToast);
        } else if (result?.reason) {
          toast.warning(t.chatInputSubmit.contextCompactNotExecutedPrefix + result.reason);
        }
      } catch (err) {
        toast.error(t.chatInputSubmit.contextCompactFailedPrefix + (err instanceof Error ? err.message : t.chatInput.unknownError));
      }
      return;
    }

    // /schedule：自然语言 → 定时任务。复用 cron:generateFromPrompt（LLM 出配置）+ createJob。
    if (isScheduleCommand(trimmedValue)) {
      const parsed = parseScheduleCommand(trimmedValue);
      if (!parsed?.description) {
        // 不带描述 → 打开对话式创建卡片（解释怎么运作 + 模板/自定义），而非直接报错
        setValue('');
        closeGoalConfirm();
        setScheduleComposerOpen(true);
        return;
      }
      addToInputHistory(trimmedValue);
      setValue('');
      setVoiceInputContext(null);
      await runScheduleCreation(parsed.description);
      return;
    }

    // /loop：会话内循环——在当前 session 反复执行同一 prompt，直到达成软条件 / 喊停 / 触到轮次上限。
    if (isLoopCommand(trimmedValue)) {
      const parsed = parseLoopCommand(trimmedValue);
      if (!parsed?.prompt) {
        toast.warning(t.chatInputSubmit.loopUsageWarning);
        inputAreaRef.current?.focus();
        return;
      }
      if (!currentSessionId) {
        toast.warning(t.chatInputSubmit.loopNeedSessionWarning);
        inputAreaRef.current?.focus();
        return;
      }
      addToInputHistory(trimmedValue);
      setValue('');
      setVoiceInputContext(null);
      try {
        const state = await loopClient.start({
          sessionId: currentSessionId,
          prompt: parsed.prompt,
          intervalMs: parsed.intervalMs,
          maxTurns: parsed.maxTurns,
          until: parsed.until,
          handoffPrompt: parsed.handoffPrompt,
        });
        useLoopStore.getState().track(state);
        useSessionStore.getState().addMessage(buildAutomationNoticeMessage({
          automationId: `loop:${state.id}`,
          automationType: 'loop',
          event: 'created',
          sourceSessionId: currentSessionId,
          sourceRefId: state.id,
          status: 'running',
          title: `${t.chatInputSubmit.loopTitlePrefix}${parsed.prompt.replace(/\s+/g, ' ').trim().slice(0, 40) || t.chatInputSubmit.loopUnnamedTask}`,
          cadenceLabel: formatLoopIntervalLabel(parsed.intervalMs),
          nextRunAt: state.nextRunAt,
          handoffPrompt: parsed.handoffPrompt,
          nextStage: parsed.handoffPrompt ? { prompt: parsed.handoffPrompt, title: t.chatInputSubmit.loopCompletedContinueTitle } : undefined,
        }));
        toast.success(
          parsed.intervalMs
            ? t.chatInputSubmit.loopStartedIntervalToast.replace('{s}', String(Math.round(parsed.intervalMs / 1000)))
            : t.chatInputSubmit.loopStartedSelfPacedToast,
        );
      } catch (err) {
        toast.error(t.chatInputSubmit.loopStartFailedPrefix + (err instanceof Error ? err.message : t.chatInput.unknownError));
      }
      return;
    }

    // /goal 自治模式：主路径 = 自然语言 → 安静确认卡（提炼草案 + 一键启动）；
    // 显式 --verify/--review/预算 flags = power-user 合同，跳过确认直接启动。
    if (isGoalCommand(trimmedValue)) {
      const rawParsed = parseGoalCommand(trimmedValue);
      if (!rawParsed || shouldOpenGoalConfirm(rawParsed)) {
        setValue('');
        setScheduleComposerOpen(false);
        openGoalConfirm(rawParsed?.goal ?? '');
        return;
      }
      const parsed = normalizeGoalCommand(rawParsed, t);
      await startGoalRun(parsed, trimmedValue);
      return;
    }

    const agentCommand = parseAgentSlashCommand(trimmedValue, agentEntries);
    if (agentCommand.kind === 'prompt') {
      openAgentCommand();
      return;
    }
    if (agentCommand.kind === 'unknown') {
      toast.warning(`${t.agentCommand.notFoundPrefix}${agentCommand.token}`);
      inputAreaRef.current?.focus();
      return;
    }
    if (agentCommand.kind === 'clear') {
      setActiveAgentId(null);
      setPendingAgentSelection({ id: null, name: 'Default', token: 'default', via: 'agent_command' });
      preferredAgentIdOverride = null;
      selectedAgentOverride = { id: null, name: 'Default', token: 'default', via: 'agent_command' };
      contentToSend = agentCommand.content;
      if (!contentToSend && attachments.length === 0) {
        setValue('');
        setVoiceInputContext(null);
        toast.info(t.agentCommand.restoredAuto);
        return;
      }
    }
    if (agentCommand.kind === 'select') {
      const agentToken = getAgentCommandToken(agentCommand.agent);
      setActiveAgentId(agentCommand.agent.id);
      setPendingAgentSelection({
        id: agentCommand.agent.id,
        name: agentCommand.agent.name,
        token: agentToken,
        via: 'agent_command',
      });
      preferredAgentIdOverride = agentCommand.agent.id;
      selectedAgentOverride = {
        id: agentCommand.agent.id,
        name: agentCommand.agent.name,
        token: agentToken,
        via: 'agent_command',
      };
      contentToSend = agentCommand.content;
      if (!contentToSend && attachments.length === 0) {
        setValue('');
        setVoiceInputContext(null);
        toast.info(`${t.agentCommand.switchedToPrefix}${agentCommand.agent.name || agentCommand.agent.id}`);
        return;
      }
    }

    const activeRuntimeInputMode: RuntimeInputMode | undefined = isProcessing ? 'supplement' : undefined;
    // Appshot：截图作为图片附件追加；窗口文本作为隐藏 XML 前置到消息内容。
    const appshotAttachment = pendingAppshot ? buildAppshotAttachment(pendingAppshot) : null;
    const effectiveAttachments = appshotAttachment ? [...attachments, appshotAttachment] : attachments;
    const appshotXml = pendingAppshot ? buildAppshotXml(pendingAppshot) : '';
    const baseEnvelope = buildEnvelope(
      contentToSend,
      effectiveAttachments,
      activeRuntimeInputMode,
      preferredAgentIdOverride,
      selectedAgentOverride,
    );
    // XML 在 envelope 构建后注入 content，避开 buildEnvelope 内的 @mention 解析。
    const nextEnvelope = appshotXml
      ? {
          ...baseEnvelope,
          content: appshotXml + (baseEnvelope.content.trim() ? `\n\n${baseEnvelope.content}` : ''),
        }
      : baseEnvelope;
    const canSubmit = ((nextEnvelope.content.trim().length > 0) || effectiveAttachments.length > 0) && (!disabled || isProcessing) && !isUploading;
    if (canSubmit) {
      const draftSnapshot = {
        value,
        attachments,
        voiceInputContext,
        appshot: pendingAppshot,
        pendingPromptCommand,
        pendingAgentSelection,
      };
        const restoreDraft = () => {
          setValue(draftSnapshot.value);
          setAttachments(draftSnapshot.attachments);
          setPendingPromptCommand(draftSnapshot.pendingPromptCommand);
          setPendingAgentSelection(draftSnapshot.pendingAgentSelection);
          setVoiceInputContext(draftSnapshot.voiceInputContext);
          if (draftSnapshot.appshot) {
            useAppshotsStore.getState().setPending(draftSnapshot.appshot, currentSessionId);
          }
      };

      // 添加到输入历史
      if (contentToSend) {
        addToInputHistory(contentToSend);
      }
      setValue('');
      setVoiceInputContext(null);
      setAttachments([]);
      setPendingPromptCommand(null);
      setPendingAgentSelection(null);
      clearAppshot();

      // P3-18: Shell shortcut - ! prefix sends command to agent as bash request
      if (nextEnvelope.content.startsWith('!')) {
        const shellCmd = nextEnvelope.content.slice(1).trim();
        if (shellCmd) {
          try {
            const sent = await onSend({
              content: `Execute this shell command and show the output: \`${shellCmd}\``,
              context: nextEnvelope.context,
            });
            if (!shouldClearComposerAfterSend(sent)) {
              restoreDraft();
              inputAreaRef.current?.focus();
              return;
            }
          } catch {
            restoreDraft();
            inputAreaRef.current?.focus();
            return;
          }
        }
      } else {
        try {
          const sent = opts?.steer && isProcessing && onSteer
            ? (await onSteer(nextEnvelope)) !== undefined
            : await onSend(nextEnvelope);
          if (!shouldClearComposerAfterSend(sent)) {
            restoreDraft();
            inputAreaRef.current?.focus();
            return;
          }
        } catch {
          restoreDraft();
          inputAreaRef.current?.focus();
          return;
        }
      }
    }
  };

  return { handleSubmit, runScheduleCreation, startGoalRun };
}
