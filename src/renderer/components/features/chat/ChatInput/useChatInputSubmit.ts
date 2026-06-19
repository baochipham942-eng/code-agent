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
import { buildAppshotXml, buildAppshotAttachment } from '@shared/contract/appshot';
import { buildGoalSeedTodos } from '@shared/utils/goalTodos';
import { toast } from '../../../../hooks/useToast';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useAppshotsStore } from '../../../../stores/appshotsStore';
import { useLoopStore } from '../../../../stores/loopStore';
import { cronClient, type CreateCronJobInput } from '../../../../services/cronClient';
import { loopClient } from '../../../../services/loopClient';
import { buildGoalNoticeMessage } from '../goalNotice';
import type { InputAreaRef } from './InputArea';
import type { BuildEnvelope } from './useChatInputEnvelope';
import { parseScheduleCommand, isScheduleCommand } from './parseScheduleCommand';
import { parseLoopCommand, isLoopCommand } from './parseLoopCommand';
import {
  parseGoalCommand,
  isGoalCommand,
  normalizeGoalCommand,
  type ParsedGoalCommand,
} from './parseGoalCommand';
import { getAgentCommandToken, parseAgentSlashCommand } from './agentCommand';
import { shouldClearComposerAfterSend } from './utils';

type VoiceInputContextValue = {
  anchor: string;
  metadata: ConversationVoiceInputMetadata;
} | null;

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
  setGoalComposerOpen: React.Dispatch<React.SetStateAction<boolean>>;
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
    setGoalComposerOpen,
    setActiveAgentId,
  } = params;

  // 定时任务创建统一入口：内联 /schedule 和对话式卡片都走这里（cron:generateFromPrompt → createJob）。
  const runScheduleCreation = useCallback(async (description: string): Promise<boolean> => {
    toast.info('正在解析定时任务…');
    try {
      const draft = await cronClient.generateFromPrompt(description);
      const job = await cronClient.createJob(draft as unknown as CreateCronJobInput);
      toast.success(`已创建定时任务「${job.name || '未命名'}」，可在「定时任务」面板查看`);
      return true;
    } catch (err) {
      toast.error(`创建定时任务失败：${err instanceof Error ? err.message : '未知错误'}`);
      return false;
    }
  }, []);

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
    setGoalComposerOpen(false);
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
  }, [addToInputHistory, attachments, buildEnvelope, currentSessionId, onSend, setAttachments, setGoalComposerOpen, setValue]);

  // 处理提交
  // 运行中允许提交，把新输入排到当前回复结束后发送。
  // P3-18: ! prefix executes shell command directly
  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmedValue = value.trim();
    let contentToSend = trimmedValue;
    let preferredAgentIdOverride: string | null | undefined;
    let selectedAgentOverride: ComposerAgentSelection | null | undefined;

    // /schedule：自然语言 → 定时任务。复用 cron:generateFromPrompt（LLM 出配置）+ createJob。
    if (isScheduleCommand(trimmedValue)) {
      const parsed = parseScheduleCommand(trimmedValue);
      if (!parsed?.description) {
        // 不带描述 → 打开对话式创建卡片（解释怎么运作 + 模板/自定义），而非直接报错
        setValue('');
        setGoalComposerOpen(false);
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
        toast.warning('用法：/loop [间隔] <要反复做的事> [--until "<停止条件>"]，例如 /loop 30s 查部署状态，好了告诉我');
        inputAreaRef.current?.focus();
        return;
      }
      if (!currentSessionId) {
        toast.warning('请先打开一个会话再启动循环');
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
        });
        useLoopStore.getState().track(state);
        toast.success(
          parsed.intervalMs
            ? `循环已启动（每 ${Math.round(parsed.intervalMs / 1000)}s 一轮）`
            : '循环已启动（自定步调）',
        );
      } catch (err) {
        toast.error(`启动循环失败：${err instanceof Error ? err.message : '未知错误'}`);
      }
      return;
    }

    // /goal 自治模式：拦截斜杠命令，只有目标文本也能启动；未给判据时默认走软目标评审。
    if (isGoalCommand(trimmedValue)) {
      const rawParsed = parseGoalCommand(trimmedValue);
      if (!rawParsed?.goal) {
        setValue('');
        setScheduleComposerOpen(false);
        setGoalComposerOpen(true);
        return;
      }
      const parsed = normalizeGoalCommand(rawParsed);
      await startGoalRun(parsed, trimmedValue);
      return;
    }

    const agentCommand = parseAgentSlashCommand(trimmedValue, agentEntries);
    if (agentCommand.kind === 'prompt') {
      openAgentCommand();
      return;
    }
    if (agentCommand.kind === 'unknown') {
      toast.warning(`没找到 agent: ${agentCommand.token}`);
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
        toast.info('已恢复自动 agent');
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
        toast.info(`已切到 ${agentCommand.agent.name || agentCommand.agent.id}`);
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
          const sent = await onSend(nextEnvelope);
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
