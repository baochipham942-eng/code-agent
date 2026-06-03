// ============================================================================
// ChatInput - 消息输入组件主入口
// 支持多模态输入：文本、图片、代码、PDF、文件夹
// 深度研究通过语义自动检测触发，无需手动切换
// ============================================================================

import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { AlertTriangle, Image, FileText, Clock3, CornerDownRight, X } from 'lucide-react';
import type { MessageAttachment } from '../../../../../shared/contract';
import type { ConversationEnvelope, RuntimeInputMode } from '@shared/contract/conversationEnvelope';
import { getModelDisplayLabel, MODEL_FEATURES, UI } from '@shared/constants';

import { InputArea, InputAreaRef } from './InputArea';
import { InputAddMenu } from './InputAddMenu';
import { AttachmentBar } from './AttachmentBar';
import { SendButton } from './SendButton';
import { SuggestionBar } from './SuggestionBar';
import { VoiceInputButton } from './VoiceInputButton';
import { PermissionToggle } from './PermissionToggle';
import { ContextUsagePill } from '../ContextUsagePill';
import { CostDisplay } from '../../../StatusBar/CostDisplay';
import { useStatusStore } from '../../../../stores/statusStore';
import { CommandPalette } from '../../../CommandPalette';
import { SlashCommandPopover } from './SlashCommandPopover';
import { useFileUpload } from './useFileUpload';
import { useChatInputSessionScope } from './useChatInputSessionScope';
import { useFileAutocomplete } from '../../../../hooks/useFileAutocomplete';
import { useWorkbenchBrowserSession } from '../../../../hooks/useWorkbenchBrowserSession';
import { useSessionUIStore } from '../../../../stores/sessionUIStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useComposerStore } from '../../../../stores/composerStore';
import { useSwarmStore } from '../../../../stores/swarmStore';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import { ComboSkillCard } from './ComboSkillCard';
import { SkillDraftNotifications } from './SkillDraftCard';
import { CapabilitySuggestionStrip } from './CapabilitySuggestionStrip';
import { useSkillRecommendations } from './useSkillRecommendations';
import { useAppStore } from '../../../../stores/appStore';
import { useAppshotsStore } from '../../../../stores/appshotsStore';
import { AppshotChip } from './AppshotChip';
import { buildAppshotXml, buildAppshotAttachment } from '@shared/contract/appshot';
import {
  ModelSwitcher,
  MODEL_OVERRIDE_CHANGE_EVENT,
  type ModelOverrideChangeDetail,
} from '../../../StatusBar/ModelSwitcher';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';
import { parseGoalCommand, isGoalCommand, normalizeGoalCommand } from './parseGoalCommand';
import { buildGoalNoticeMessage } from '../goalNotice';
import { buildGoalSeedTodos } from '@shared/utils/goalTodos';
import {
  applyAgentMentionSuggestion,
  buildDirectRoutingPlaceholder,
  getLeadingAgentMentionAutocomplete,
  getPreferredAgentMentionToken,
  isLeadingAgentMentionInput,
  parseLeadingAgentMentions,
} from './agentMentionRouting';
import {
  applyAgentCommandOption,
  getAgentCommandOptions,
  getAgentSlashCommandQuery,
  parseAgentSlashCommand,
} from './agentCommand';
import { shouldClearComposerAfterSend } from './utils';
import { useDragAndDrop } from './useDragAndDrop';
import { buildBrowserSessionIntentSnapshot } from '../../../../utils/browserExecutionIntent';
import {
  clearDebugDraftParamsFromCurrentUrl,
  readDebugDraftFromLocation,
} from './debugDraftUrl';

// ============================================================================
// 类型定义
// ============================================================================

export interface ChatInputProps {
  onSend: (envelope: ConversationEnvelope) => boolean | Promise<boolean>;
  disabled?: boolean;
  /** 是否正在处理（用于显示停止按钮） */
  isProcessing?: boolean;
  /** 运行中输入正在接入 */
  isInterrupting?: boolean;
  /** 停止处理回调 */
  onStop?: () => void;
  queuedRuntimeInputs?: Array<{
    id: string;
    content: string;
    mode: RuntimeInputMode;
    attachmentsCount: number;
    createdAt: number;
  }>;
  onCancelQueuedRuntimeInput?: (id: string) => void;
  onSendQueuedRuntimeInput?: (id: string) => void;
  /** 是否有 Plan */
  hasPlan?: boolean;
  /** 点击 Plan 入口 */
  onPlanClick?: () => void;
}

// Imperative handle exposed to parent (e.g. ChatView drop zone)
export interface ChatInputHandle {
  addAttachments: (items: MessageAttachment[]) => void;
  setDraft: (draft: { content: string; attachments?: MessageAttachment[] }) => void;
  focus: () => void;
}

// ============================================================================
// 主组件
// ============================================================================

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(({
  onSend,
  disabled,
  isProcessing,
  isInterrupting,
  onStop,
  queuedRuntimeInputs = [],
  onCancelQueuedRuntimeInput,
  onSendQueuedRuntimeInput,
  hasPlan,
  onPlanClick,
}, ref) => {
  const [value, setValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  // 会话作用域：currentSessionId / engine 类型 / 切换会话时清空草稿
  const { currentSessionId, sessionEngineKind } = useChatInputSessionScope(setValue, setAttachments);
  const pendingAppshot = useAppshotsStore((s) =>
    s.pendingSessionId === currentSessionId ? s.pending : null
  );
  const clearAppshot = useAppshotsStore((s) => s.clear);
  const appshotSlotRef = useRef<HTMLDivElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; text: string; source: string }>>([]);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [showSlashPopover, setShowSlashPopover] = useState(false);
  const [selectedAgentMentionIndex, setSelectedAgentMentionIndex] = useState(0);
  const [selectedAgentCommandIndex, setSelectedAgentCommandIndex] = useState(0);
  const [dismissedAgentAutocompleteValue, setDismissedAgentAutocompleteValue] = useState<string | null>(null);
  const [comboSuggestion, setComboSuggestion] = useState<{
    sessionId: string;
    suggestedName: string;
    suggestedDescription: string;
    turnCount: number;
    stepCount: number;
    toolNames: string[];
  } | null>(null);
  const inputAreaRef = useRef<InputAreaRef>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const debugDraftAppliedRef = useRef(false);
  const { processFile, processFolderEntry } = useFileUpload();
  // 拖放附件处理（高亮状态 + 文件/文件夹拖入转附件）
  const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useDragAndDrop({
    processFile,
    processFolderEntry,
    setAttachments,
    setIsUploading: (uploading) => setIsUploading(uploading),
  });
  // 输入命中技能关键词时的推荐（已安装→挂载 / 未安装→从推荐目录安装）
  const {
    recommendations: skillRecommendations,
    installingSkillName,
    mountRecommendedSkill,
    installRecommendedSkill,
  } = useSkillRecommendations(currentSessionId, value);
  const browserSession = useWorkbenchBrowserSession();
  const buildContext = useComposerStore((state) => state.buildContext);
  const routingMode = useComposerStore((state) => state.routingMode);
  const targetAgentIds = useComposerStore((state) => state.targetAgentIds);
  const agentEntries = useAgentRegistryStore((state) => state.entries);
  const activeAgentId = useAppStore((state) => state.activeAgentId);
  const setActiveAgentId = useAppStore((state) => state.setActiveAgentId);
  const hasMessages = useSessionStore((state) => state.messages.length > 0);
  const swarmAgents = useSwarmStore((state) => state.agents);
  const agentMentionAutocomplete = useMemo(
    () => getLeadingAgentMentionAutocomplete(value, swarmAgents),
    [swarmAgents, value],
  );
  const isAgentMentionAutocompleteOpen = Boolean(
    agentMentionAutocomplete
    && agentMentionAutocomplete.matches.length > 0
    && dismissedAgentAutocompleteValue !== value,
  );
  const agentSlashCommandQuery = useMemo(() => getAgentSlashCommandQuery(value), [value]);
  const agentCommandOptions = useMemo(
    () => agentSlashCommandQuery === null ? [] : getAgentCommandOptions(agentEntries, agentSlashCommandQuery),
    [agentEntries, agentSlashCommandQuery],
  );
  const isAgentCommandAutocompleteOpen = agentSlashCommandQuery !== null && agentCommandOptions.length > 0;
  const selectedDirectAgents = useMemo(
    () => swarmAgents.filter((agent) => targetAgentIds.includes(agent.id)),
    [swarmAgents, targetAgentIds],
  );
  const inputPlaceholder = useMemo(() => {
    if (routingMode === 'direct') {
      return buildDirectRoutingPlaceholder(selectedDirectAgents, swarmAgents);
    }
    return undefined;
  }, [routingMode, selectedDirectAgents, swarmAgents]);

  const buildEnvelope = useCallback((
    rawContent: string,
    nextAttachments?: MessageAttachment[],
    nextRuntimeInputMode?: RuntimeInputMode,
    preferredAgentIdOverride?: string | null,
  ): ConversationEnvelope => {
    const parsedMentions = parseLeadingAgentMentions(rawContent, swarmAgents);
    const content = parsedMentions ? parsedMentions.content : rawContent.trim();
    const baseContext = buildContext();
    const preferredAgentId = preferredAgentIdOverride === undefined ? activeAgentId : preferredAgentIdOverride;
    const nextContext = parsedMentions
      ? {
          ...baseContext,
          ...(preferredAgentId ? { preferredAgentId } : {}),
          routing: {
            mode: 'direct' as const,
            targetAgentIds: parsedMentions.targetAgentIds,
          },
        }
      : {
          ...baseContext,
          ...(preferredAgentId ? { preferredAgentId } : {}),
        };
    const browserSessionMode = nextContext?.executionIntent?.browserSessionMode;
    const context = browserSessionMode
      ? {
          ...nextContext,
          executionIntent: {
            ...nextContext.executionIntent,
            browserSessionSnapshot: buildBrowserSessionIntentSnapshot({
              mode: browserSessionMode,
              browserSession,
            }),
          },
        }
      : nextContext;
    const runtimeScopedContext = nextRuntimeInputMode
      ? {
          ...context,
          runtimeInput: {
            mode: nextRuntimeInputMode,
          },
        }
      : context;

    return {
      content,
      attachments: nextAttachments && nextAttachments.length > 0 ? nextAttachments : undefined,
      context: runtimeScopedContext,
    };
  }, [activeAgentId, browserSession, buildContext, swarmAgents]);

  // 上报 composer 槽位给 Rust，作为 Appshot 飞入动画的落点（屏幕逻辑坐标）
  useEffect(() => {
    // Window.__TAURI_INTERNALS__ 类型来自 types/tauri.d.ts 全局声明
    const internals = window.__TAURI_INTERNALS__;
    if (!internals) return;
    const report = () => {
      const el = appshotSlotRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      internals
        .invoke('appshots_report_composer_slot', {
          slot: { x: r.left + window.screenX, y: r.top + window.screenY, width: 56, height: 56 },
        })
        .catch(() => {});
    };
    const timer = window.setTimeout(report, 300);
    window.addEventListener('resize', report);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', report);
    };
  }, []);

  // Expose addAttachments to parent via ref (for global drop zone)
  useImperativeHandle(ref, () => ({
    addAttachments: (items: MessageAttachment[]) => {
      if (items.length > 0) {
        setAttachments((prev) => [...prev, ...items].slice(0, UI.MAX_ATTACHMENTS_DROP));
      }
    },
    setDraft: (draft) => {
      setValue(draft.content);
      setAttachments((draft.attachments ?? []).slice(0, UI.MAX_ATTACHMENTS_DROP));
      inputAreaRef.current?.focus();
    },
    focus: () => {
      inputAreaRef.current?.focus();
    },
  }), []);

  useEffect(() => {
    if (debugDraftAppliedRef.current) return;
    const draft = readDebugDraftFromLocation(window.location);
    if (!draft) return;

    debugDraftAppliedRef.current = true;
    setValue(draft.content);
    setAttachments([]);
    clearDebugDraftParamsFromCurrentUrl(window);
    window.setTimeout(() => {
      inputAreaRef.current?.focus();
      if (draft.autoSubmit) {
        formRef.current?.requestSubmit();
      }
    }, 0);
  }, []);

  // Listen for context-aware suggestions from agent (pushed after each turn)
  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: { type: string; data: unknown }) => {
      if (event.type === 'suggestions_update' && Array.isArray(event.data)) {
        setSuggestions(event.data as Array<{ id: string; text: string; source: string }>);
      }
      // Combo Skill suggestion from backend
      if (event.type === 'combo_skill_suggestion' && event.data) {
        setComboSuggestion(event.data as typeof comboSuggestion);
      }
    });
    return () => { unsubscribe?.(); };
  }, []);

  // IACT protocol: listen for inline interaction events from message bubbles
  useEffect(() => {
    const handleSend = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (text?.trim()) {
        void onSend(buildEnvelope(text));
      }
    };
    const handleAdd = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (text?.trim()) {
        setValue(prev => prev.trim() ? `${prev} ${text}` : text);
        inputAreaRef.current?.focus();
      }
    };
    const handleRun = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      if (cmd?.trim()) {
        void onSend(buildEnvelope(`Execute this shell command and show the output: \`${cmd.trim()}\``));
      }
    };
    window.addEventListener('iact:send', handleSend);
    window.addEventListener('iact:add', handleAdd);
    window.addEventListener('iact:run', handleRun);
    return () => {
      window.removeEventListener('iact:send', handleSend);
      window.removeEventListener('iact:add', handleAdd);
      window.removeEventListener('iact:run', handleRun);
    };
  }, [buildEnvelope, onSend]);

  // Clear suggestions when user starts typing
  useEffect(() => {
    if (value.trim().length > 0) {
      setSuggestions([]);
    }
  }, [value]);

  useEffect(() => {
    setSelectedAgentMentionIndex(0);
    if (dismissedAgentAutocompleteValue && dismissedAgentAutocompleteValue !== value) {
      setDismissedAgentAutocompleteValue(null);
    }
  }, [agentMentionAutocomplete?.query, agentMentionAutocomplete?.matches.length, dismissedAgentAutocompleteValue, value]);

  useEffect(() => {
    setSelectedAgentCommandIndex(0);
  }, [agentSlashCommandQuery, agentCommandOptions.length]);

  // Handle suggestion selection
  const handleSuggestionSelect = useCallback((text: string) => {
    setValue(text);
    inputAreaRef.current?.focus();
  }, []);

  // @ file autocomplete
  const { matches: fileMatches, isOpen: isAutocompleteOpen, query: atQuery, search: searchFiles, dismiss: dismissAutocomplete } = useFileAutocomplete();

  // Track input changes for @ autocomplete and / command palette
  const handleValueChange = useCallback((newValue: string) => {
    setValue(newValue);
    if (newValue.toLowerCase().startsWith('/agent ')) {
      setShowSlashPopover(false);
      dismissAutocomplete();
      return;
    }
    // Detect / prefix to show inline slash command popover
    if (newValue.startsWith('/')) {
      setShowSlashPopover(true);
      setSlashFilter(newValue.slice(1));
      return;
    } else {
      setShowSlashPopover(false);
    }
    if (isLeadingAgentMentionInput(newValue, swarmAgents)) {
      dismissAutocomplete();
      return;
    }
    // Check for @ pattern at cursor position (approximate: end of string)
    searchFiles(newValue, newValue.length);
  }, [dismissAutocomplete, searchFiles, swarmAgents]);

  // Handle @ file selection
  const handleFileSelectAutocomplete = useCallback((filePath: string) => {
    // Replace @query with the file path
    const beforeAt = value.replace(new RegExp(`@${atQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
    setValue(beforeAt + '@' + filePath + ' ');
    dismissAutocomplete();
    inputAreaRef.current?.focus();
  }, [value, atQuery, dismissAutocomplete]);

  const handleAgentMentionSelect = useCallback((agentId: string) => {
    const agent = swarmAgents.find((item) => item.id === agentId);
    if (!agent) return;
    setValue((prev) => applyAgentMentionSuggestion(prev, agent));
    setDismissedAgentAutocompleteValue(null);
    inputAreaRef.current?.focus();
  }, [swarmAgents]);

  const openAgentCommand = useCallback(() => {
    setValue('/agent ');
    setShowSlashPopover(false);
    setSlashFilter('');
    setDismissedAgentAutocompleteValue(null);
    requestAnimationFrame(() => inputAreaRef.current?.focus());
  }, []);

  const handleAgentCommandOptionSelect = useCallback((index: number) => {
    const option = agentCommandOptions[index];
    if (!option) return;
    setValue(applyAgentCommandOption(option));
    setSelectedAgentCommandIndex(index);
    requestAnimationFrame(() => inputAreaRef.current?.focus());
  }, [agentCommandOptions]);

  const handleAutocompleteKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isAgentCommandAutocompleteOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedAgentCommandIndex((prev) => (prev + 1) % agentCommandOptions.length);
        return true;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedAgentCommandIndex((prev) => (
          prev === 0 ? agentCommandOptions.length - 1 : prev - 1
        ));
        return true;
      }

      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        handleAgentCommandOptionSelect(selectedAgentCommandIndex);
        return true;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        setValue('');
        return true;
      }
    }

    if (!isAgentMentionAutocompleteOpen || !agentMentionAutocomplete) {
      return false;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedAgentMentionIndex((prev) => (prev + 1) % agentMentionAutocomplete.matches.length);
      return true;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedAgentMentionIndex((prev) => (
        prev === 0 ? agentMentionAutocomplete.matches.length - 1 : prev - 1
      ));
      return true;
    }

    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      const selected = agentMentionAutocomplete.matches[selectedAgentMentionIndex];
      if (selected) {
        e.preventDefault();
        handleAgentMentionSelect(selected.id);
        return true;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissedAgentAutocompleteValue(value);
      return true;
    }

    return false;
  }, [
    agentMentionAutocomplete,
    agentCommandOptions.length,
    handleAgentCommandOptionSelect,
    handleAgentMentionSelect,
    isAgentCommandAutocompleteOpen,
    isAgentMentionAutocompleteOpen,
    selectedAgentCommandIndex,
    selectedAgentMentionIndex,
    value,
  ]);

  // 历史命令功能
  const {
    addToInputHistory,
    getPreviousInput,
    getNextInput,
    resetInputHistoryIndex,
  } = useSessionUIStore();

  const resolvedPlaceholder = useMemo(() => {
    if (inputPlaceholder) return inputPlaceholder;
    if (!isProcessing) return undefined;
    return '引导对话，本轮结束后发送...';
  }, [inputPlaceholder, isProcessing]);

  // 处理提交
  // 运行中允许提交，把新输入排到当前回复结束后发送。
  // P3-18: ! prefix executes shell command directly
  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmedValue = value.trim();
    let contentToSend = trimmedValue;
    let preferredAgentIdOverride: string | null | undefined;

    // /goal 自治模式：拦截斜杠命令，只有目标文本也能启动；未给判据时默认走软目标评审。
    if (isGoalCommand(trimmedValue)) {
      const rawParsed = parseGoalCommand(trimmedValue);
      if (!rawParsed?.goal) {
        toast.warning('用法：/goal <目标>（可选 --verify "<命令>" 或 --review "<软条件>"）');
        inputAreaRef.current?.focus();
        return;
      }
      const parsed = normalizeGoalCommand(rawParsed);
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
          },
        },
      };
      if (currentSessionId) {
        useAppStore.getState().startGoalRun(currentSessionId, {
          goal: parsed.goal,
          maxTurns: parsed.maxTurns,
          tokenBudget: parsed.budget,
        });
        useSessionStore.getState().setTodos(buildGoalSeedTodos(parsed.goal));
      }
      useSessionStore.getState().addMessage(buildGoalNoticeMessage({ kind: 'start', goal: parsed.goal }));
      addToInputHistory(trimmedValue);
      setValue('');
      setAttachments([]);
      try {
        await onSend(goalEnvelope);
      } catch {
        if (currentSessionId) useAppStore.getState().clearGoalRun(currentSessionId);
      }
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
      preferredAgentIdOverride = null;
      contentToSend = agentCommand.content;
      if (!contentToSend && attachments.length === 0) {
        setValue('');
        toast.info('已恢复自动 agent');
        return;
      }
    }
    if (agentCommand.kind === 'select') {
      setActiveAgentId(agentCommand.agent.id);
      preferredAgentIdOverride = agentCommand.agent.id;
      contentToSend = agentCommand.content;
      if (!contentToSend && attachments.length === 0) {
        setValue('');
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
        appshot: pendingAppshot,
      };
      const restoreDraft = () => {
        setValue(draftSnapshot.value);
        setAttachments(draftSnapshot.attachments);
        if (draftSnapshot.appshot) {
          useAppshotsStore.getState().setPending(draftSnapshot.appshot, currentSessionId);
        }
      };

      // 添加到输入历史
      if (contentToSend) {
        addToInputHistory(contentToSend);
      }
      setValue('');
      setAttachments([]);
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

  // 处理文件选择
  const handleFileSelect = async (files: FileList) => {
    setIsUploading(true);
    try {
      const newAttachments: MessageAttachment[] = [];
      for (const file of Array.from(files)) {
        const attachment = await processFile(file);
        if (attachment) newAttachments.push(attachment);
      }
      if (newAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...newAttachments].slice(0, UI.MAX_ATTACHMENTS_FILE_SELECT));
      }
    } finally {
      setIsUploading(false);
    }
  };

  // 处理图片粘贴（如微信截图）
  const handleImagePaste = useCallback(async (file: File) => {
    setIsUploading(true);
    try {
      const attachment = await processFile(file);
      if (attachment) {
        setAttachments((prev) => [...prev, attachment].slice(0, UI.MAX_ATTACHMENTS_FILE_SELECT));
      }
    } finally {
      setIsUploading(false);
    }
  }, [processFile]);

  // 移除附件
  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // 语音输入回调 - 追加到现有文本
  const handleVoiceTranscript = useCallback((text: string) => {
    if (text.trim()) {
      setValue(prev => prev.trim() ? `${prev} ${text}` : text);
      // 聚焦输入框
      inputAreaRef.current?.focus();
    }
  }, []);

  const modelConfig = useAppStore((s) => s.modelConfig);
  const [sessionModelOverride, setSessionModelOverride] = useState<ModelOverrideChangeDetail['override']>(null);
  const sessionCost = useStatusStore((s) => s.sessionCost);
  const statusStreaming = useStatusStore((s) => s.isStreaming);

  useEffect(() => {
    if (!currentSessionId) {
      setSessionModelOverride(null);
      return;
    }

    let cancelled = false;
    const overrideRequest = window.domainAPI?.invoke<ModelOverrideChangeDetail['override']>(
      IPC_DOMAINS.SESSION,
      'getModelOverride',
      { sessionId: currentSessionId },
    );
    if (!overrideRequest) {
      setSessionModelOverride(null);
    } else {
      overrideRequest.then((res) => {
        if (!cancelled && res?.success) {
          setSessionModelOverride(res.data ?? null);
        }
      })
        .catch(() => {
          if (!cancelled) setSessionModelOverride(null);
        });
    }

    const handleModelOverrideChange = (event: Event) => {
      const detail = (event as CustomEvent<ModelOverrideChangeDetail>).detail;
      if (detail?.sessionId === currentSessionId) {
        setSessionModelOverride(detail.override);
      }
    };

    window.addEventListener(MODEL_OVERRIDE_CHANGE_EVENT, handleModelOverrideChange);
    return () => {
      cancelled = true;
      window.removeEventListener(MODEL_OVERRIDE_CHANGE_EVENT, handleModelOverrideChange);
    };
  }, [currentSessionId]);

  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const hasImageAttachments = attachments.some((attachment) => (
    attachment.type === 'image' || attachment.category === 'image'
  ));
  const effectiveModelId = sessionModelOverride?.model ?? modelConfig.model;
  const effectiveModelFeatures = MODEL_FEATURES[effectiveModelId] ?? [];
  const selectedModelHasVision =
    effectiveModelFeatures.includes('vision') ||
    (effectiveModelId === modelConfig.model && (modelConfig.capabilities ?? []).includes('vision'));
  // 外部引擎（Codex/Claude CLI）自行处理图片，这条针对 Neo 原生模型的提示不适用
  const showVisionModelNotice = hasImageAttachments && !selectedModelHasVision && sessionEngineKind === 'native';

  return (
    <div
      className={`px-4 pb-3 pt-0 transition-colors ${isDragOver ? 'bg-primary-500/5' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Command Palette triggered by / */}
      <CommandPalette isOpen={showCommandPalette} onClose={() => setShowCommandPalette(false)} />
      <form ref={formRef} onSubmit={handleSubmit} className="max-w-3xl mx-auto">
        {/* Plan 入口按钮 - 仅当有 Plan 时显示 */}
        {hasPlan && onPlanClick && (
          <button
            type="button"
            onClick={onPlanClick}
            className="flex items-center gap-2 px-3 py-2 mb-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg hover:bg-indigo-500/20 transition-colors w-full text-left"
          >
            <FileText className="w-4 h-4 text-indigo-400" />
            <span className="text-sm text-indigo-400">查看实现计划</span>
          </button>
        )}

        {/* 文件处理中提示 */}
        {isUploading && (
          <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-amber-400">文件处理中...</span>
          </div>
        )}

        {/* Appshot 飞入动画落点锚（0 高，仅用于测量 composer 槽位屏幕坐标） */}
        <div ref={appshotSlotRef} aria-hidden className="h-0" />

        {/* Appshot 预览片 */}
        {pendingAppshot && (
          <div className="mb-2 px-2">
            <AppshotChip capture={pendingAppshot} onRemove={clearAppshot} />
          </div>
        )}

        {/* 附件预览区 */}
        {attachments.length > 0 && (
          <div className="mb-2">
            <AttachmentBar attachments={attachments} onRemove={removeAttachment} />
          </div>
        )}

        {showVisionModelNotice && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              当前 {getModelDisplayLabel(effectiveModelId)} 不直接读图，图片会走视觉模型或图片分析工具。
            </span>
          </div>
        )}

        {/* 拖放提示 */}
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-800-950/90 backdrop-blur-sm z-10 rounded-xl border-2 border-dashed border-primary-500">
            <div className="flex flex-col items-center gap-2 text-primary-400">
              <Image className="w-8 h-8" />
              <span className="text-sm">拖放文件或文件夹到这里</span>
            </div>
          </div>
        )}

        {/* Combo Skill suggestion card */}
        {comboSuggestion && (
          <ComboSkillCard
            suggestion={comboSuggestion}
            onDismiss={() => setComboSuggestion(null)}
            onSaved={() => setComboSuggestion(null)}
          />
        )}

        <SkillDraftNotifications />

        {/* Suggestion Bar - show when input is empty */}
        {value.trim().length === 0 && suggestions.length > 0 && (
          <SuggestionBar suggestions={suggestions} onSelect={handleSuggestionSelect} />
        )}

        {/* Skill 推荐条 - 输入命中技能关键词时显示（挂载已安装 / 安装未安装） */}
        <CapabilitySuggestionStrip
          skillRecommendations={skillRecommendations}
          capabilitySuggestions={[]}
          onSkillMount={mountRecommendedSkill}
          onSkillInstall={installRecommendedSkill}
          onCapabilitySelect={() => {}}
          installingSkillName={installingSkillName}
        />

        {/* Codex 风格融合：去掉明显边框 + 阴影，只用极弱 bg 区分输入区跟聊天内容 */}
        <div className="relative bg-white/[0.02] backdrop-blur-sm rounded-2xl focus-within:bg-white/[0.04] transition-colors duration-200">
          {/* Slash command inline popover */}
          <SlashCommandPopover
            isOpen={showSlashPopover}
            filter={slashFilter}
            onClose={() => { setShowSlashPopover(false); setValue(''); }}
            onSelect={(cmd) => {
              setShowSlashPopover(false);
              if (cmd.id === 'agent') {
                openAgentCommand();
                return;
              }
              if (cmd.id === 'goal') {
                setValue('/goal ');
                requestAnimationFrame(() => inputAreaRef.current?.focus());
                return;
              }
              if (cmd.id === 'workflow') {
                // 预填 /workflow 前缀，用户补目标；发送后模型经 gen8 carve-out 调 workflow 工具写脚本。
                setValue('/workflow ');
                requestAnimationFrame(() => inputAreaRef.current?.focus());
                return;
              }
              setValue('');
              cmd.action();
            }}
          />
          {isAgentCommandAutocompleteOpen && (
            <div className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-[240px] overflow-y-auto rounded-lg border border-zinc-700/70 bg-zinc-900 shadow-xl">
              <div className="border-b border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
                /agent
              </div>
              {agentCommandOptions.map((option, index) => (
                <button
                  key={option.id ?? 'default'}
                  type="button"
                  onClick={() => handleAgentCommandOptionSelect(index)}
                  className={`w-full px-3 py-2 text-left transition-colors ${
                    index === selectedAgentCommandIndex
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-300 hover:bg-zinc-800/70'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{option.name}</span>
                    <span className="ml-auto rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
                      {option.token}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                    {option.description}
                  </div>
                </button>
              ))}
            </div>
          )}
          {/* @ File autocomplete dropdown */}
          {!isAgentCommandAutocompleteOpen && isAgentMentionAutocompleteOpen && agentMentionAutocomplete && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-20 max-h-[240px] overflow-y-auto">
              {agentMentionAutocomplete.matches.map((agent, index) => {
                const agentRole = (agent as { role?: string }).role;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => handleAgentMentionSelect(agent.id)}
                    className={`w-full px-3 py-2 text-left transition-colors ${
                      index === selectedAgentMentionIndex
                        ? 'bg-zinc-700'
                        : 'hover:bg-zinc-800'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-zinc-200">@{getPreferredAgentMentionToken(agent)}</span>
                      <span className="text-xs text-zinc-500 truncate">{agent.name}</span>
                      {agentRole ? (
                        <span className="ml-auto text-[11px] text-zinc-600 truncate">{agentRole}</span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {(!isAgentMentionAutocompleteOpen && isAutocompleteOpen && fileMatches.length > 0) && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-20 max-h-[200px] overflow-y-auto">
              {fileMatches.map((f, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleFileSelectAutocomplete(f.path)}
                  className="w-full px-3 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-700 transition-colors font-mono truncate"
                >
                  {f.name}
                </button>
              ))}
            </div>
          )}
          <InputArea
            ref={inputAreaRef}
            value={value}
            onChange={handleValueChange}
            onSubmit={handleSubmit}
            onFileSelect={handleFileSelect}
            onImagePaste={handleImagePaste}
            disabled={disabled && !isProcessing}
            hasAttachments={attachments.length > 0}
            hasMessages={hasMessages}
            isFocused={isFocused}
            onFocusChange={setIsFocused}
            placeholder={resolvedPlaceholder}
            onHistoryPrev={getPreviousInput}
            onHistoryNext={getNextInput}
            onHistoryReset={resetInputHistoryIndex}
            onAutocompleteKeyDown={handleAutocompleteKeyDown}
          />
          {queuedRuntimeInputs.length > 0 && (
            <div className="px-4 pb-2 -mt-1 space-y-1.5">
              {queuedRuntimeInputs.map((item) => (
                <div
                  key={item.id}
                  className="flex justify-end"
                >
                  <div className="max-w-[86%]">
                    <div className="mb-1 flex items-center justify-end gap-2 text-[11px] text-zinc-400">
                      <CornerDownRight className="h-3.5 w-3.5" />
                      <span>已引导对话</span>
                      {item.attachmentsCount > 0 && (
                        <span className="text-zinc-500">附件 {item.attachmentsCount}</span>
                      )}
                      {isProcessing ? (
                        <span className="inline-flex items-center gap-1 text-zinc-500">
                          <Clock3 className="h-3 w-3" />
                          等待发送
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onSendQueuedRuntimeInput?.(item.id)}
                          className="text-zinc-400 hover:text-zinc-200"
                          title="立即发送这条排队消息"
                        >
                          发送
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onCancelQueuedRuntimeInput?.(item.id)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
                        title="撤回这条排队消息"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="rounded-2xl bg-zinc-800/70 border border-white/[0.04] px-4 py-2.5 text-zinc-100 shadow-sm">
                      <div className="leading-relaxed select-text">
                        {item.content}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* 底部工具栏 */}
          <div className="flex items-center gap-1 px-3 pb-3">
            {/* "+" 二级菜单（Codex 风格 B+）— 收纳 /命令 + 上传附件 + 交互模式 */}
            <InputAddMenu
              onSlashCommand={() => { setShowSlashPopover(true); setSlashFilter(''); }}
              onFileSelect={handleFileSelect}
            />

            {/* 权限模式 chip — Default / Full Access（高频，保留独立位置） */}
            <PermissionToggle disabled={disabled && !isProcessing} />

            {/* B+ 移除: AbilityMenu (Routing/Browser/Live Preview) — 挪到 Settings；
                Live Preview 后续挪到 SessionWorkspaceBar 顶栏 */}

            {/* 弹性空白 */}
            <div className="flex-1" />

            {/* 累计费用 — Context pill 左边 */}
            {sessionCost > 0 && (
              <span className="text-xs mr-1 tabular-nums">
                <CostDisplay cost={sessionCost} isStreaming={statusStreaming} />
              </span>
            )}

            {/* B+ 移除: InteractionModeIndicator — 已收进 InputAddMenu 二级菜单 */}

            {/* 上下文使用 pill — 模型选择器左边，Codex 风格 */}
            <ContextUsagePill />

            {/* 模型选择器（已合并 Agent Engine 选择到下拉框顶部 chip 行） */}
            <div className="text-xs">
              <ModelSwitcher currentModel={modelConfig.model} />
            </div>

            {/* 语音输入按钮 */}
            {!disabled && (
              <VoiceInputButton
                onTranscript={handleVoiceTranscript}
                disabled={disabled}
              />
            )}
            {/* 发送/停止/引导按钮 */}
            <SendButton
              disabled={disabled && !isProcessing}
              isProcessing={isProcessing}
              isInterrupting={isInterrupting}
              hasContent={hasContent}
              type="submit"
              onStop={onStop}
            />
          </div>
        </div>
      </form>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';

export default ChatInput;
