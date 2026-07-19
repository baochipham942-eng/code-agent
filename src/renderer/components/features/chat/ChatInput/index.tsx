// ============================================================================
// ChatInput - 消息输入组件主入口
// 支持多模态输入：文本、图片、代码、PDF、文件夹
// 深度研究通过语义自动检测触发，无需手动切换
// ============================================================================

import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Image, FileText, Clock3, CornerDownRight, X, UserPlus } from 'lucide-react';
import type { MessageAttachment } from '../../../../../shared/contract';
import type {
  ComposerAgentSelection,
  ComposerPromptCommandSelection,
  ConversationEnvelope,
  ConversationVoiceInputMetadata,
  RuntimeInputMode,
} from '@shared/contract/conversationEnvelope';
import type { SteerOrQueueOutcome } from '@shared/contract/appService';
import { UI } from '@shared/constants';
import { IPC_DOMAINS } from '@shared/ipc';

import { InputArea, InputAreaRef } from './InputArea';
import { InputAddMenu } from './InputAddMenu';
import { AttachmentBar } from './AttachmentBar';
import { NeoContinuationChip } from './NeoContinuationChip';
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
import { RoleDraftNotifications } from './RoleDraftCard';
import { startCreateRoleChat } from '../../../../utils/startCreateRoleChat';
import { computeSlashMenuValue } from '../../../../utils/composerShortcuts';
import { useSkillRecommendations } from './useSkillRecommendations';
import { CapabilitySuggestionStrip } from './CapabilitySuggestionStrip';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppStore } from '../../../../stores/appStore';
import { useAppshotsStore } from '../../../../stores/appshotsStore';
import { AppshotChip } from './AppshotChip';
import { InlineWorkbenchBar } from '../InlineWorkbenchBar';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import { ModelSwitcher } from '../../../StatusBar/ModelSwitcher';
import ipcService from '../../../../services/ipcService';
import {
  invokeNativeCommandAction,
  isNativeCommandRuntimeAvailable,
} from '../../../../services/nativeCommandFacade';
import { goalComposerDraftToParsed } from './parseGoalCommand';
import { LoopStatusBar } from './LoopStatusBar';
import { ScheduleComposerCard } from './ScheduleComposerCard';
import { GoalConfirmCard } from './GoalConfirmCard';
import { buildVerifyCandidates } from './goalConfirm';
import { readWorkspaceFile } from '../../../design/designFiles';
import {
  buildDirectRoutingPlaceholder,
  getPreferredAgentMentionToken,
  isLeadingAgentMentionInput,
} from './agentMentionRouting';
import { isLeadingNeoTagInput, parseLeadingNeoTagInvocation } from './neoMentionRouting';
import { useDragAndDrop } from './useDragAndDrop';
import { useChatInputEnvelope } from './useChatInputEnvelope';
import { useChatInputAgentCommand } from './useChatInputAgentCommand';
import { useChatInputSlashCommands } from './useChatInputSlashCommands';
import { useChatInputSubmit } from './useChatInputSubmit';
import { useChatInputComposerActions } from './useChatInputComposerActions';
import {
  clearDebugDraftParamsFromCurrentUrl,
  readDebugDraftFromLocation,
} from './debugDraftUrl';
import { getTrailingSlashToken } from './slashPickerModel';
import { AgentChip } from './AgentChip';

// ============================================================================
// 类型定义
// ============================================================================

export interface ChatInputProps {
  onSend: (envelope: ConversationEnvelope) => boolean | Promise<boolean>;
  onSteer?: (envelope: ConversationEnvelope) => Promise<SteerOrQueueOutcome | undefined>;
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

export const RuntimeInputShortcutHint: React.FC<{ isProcessing: boolean }> = ({ isProcessing }) => {
  const { t } = useI18n();
  if (!isProcessing) return null;

  return (
    <div
      data-testid="runtime-input-shortcut-hint"
      className="px-4 pb-2 -mt-1 text-right text-[11px] text-zinc-500"
    >
      {typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0
        ? t.chatInput.runtimeInputShortcutHintMac
        : t.chatInput.runtimeInputShortcutHintWin}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(({
  onSend,
  onSteer,
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
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [voiceInputContext, setVoiceInputContext] = useState<{
    anchor: string;
    metadata: ConversationVoiceInputMetadata;
  } | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  // 会话作用域：currentSessionId / engine 类型 / 切换会话时清空草稿
  const { currentSessionId } = useChatInputSessionScope(setValue, setAttachments);
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
  const [pendingPromptCommand, setPendingPromptCommand] = useState<ComposerPromptCommandSelection | null>(null);
  const [pendingAgentSelection, setPendingAgentSelection] = useState<ComposerAgentSelection | null>(null);
  const [comboSuggestion, setComboSuggestion] = useState<{
    sessionId: string;
    suggestedName: string;
    suggestedDescription: string;
    turnCount: number;
    stepCount: number;
    toolNames: string[];
  } | null>(null);
  // /schedule 不带参数时的对话式创建卡片
  const [scheduleComposerOpen, setScheduleComposerOpen] = useState(false);
  const [creatingSchedule, setCreatingSchedule] = useState(false);
  // /goal 安静确认卡（主路径：自然语言 → 提炼草案 → 轻确认启动）
  const [goalConfirm, setGoalConfirm] = useState<{ initialGoal: string } | null>(null);
  const [goalVerifyCandidates, setGoalVerifyCandidates] = useState<string[]>([]);
  const [submittingGoal, setSubmittingGoal] = useState(false);
  const inputAreaRef = useRef<InputAreaRef>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const debugDraftAppliedRef = useRef(false);

  useEffect(() => {
    const handleOpenCommandPalette = () => setShowCommandPalette(true);
    window.addEventListener('app:openCommandPalette', handleOpenCommandPalette);
    return () => {
      window.removeEventListener('app:openCommandPalette', handleOpenCommandPalette);
    };
  }, []);

  // /goal 确认卡打开时探测项目 package.json scripts 作为验证命令候选
  // （fail-closed：候选只来自项目真实脚本，读不到就空）。
  // 会话尚未落 workingDirectory（首轮前为 null）时兜底问主进程当前工作目录。
  useEffect(() => {
    if (!goalConfirm) return;
    let cancelled = false;
    void (async () => {
      let workingDirectory = useAppStore.getState().workingDirectory;
      if (!workingDirectory && currentSessionId) {
        workingDirectory = useSessionStore.getState().sessions
          .find((session) => session.id === currentSessionId)?.workingDirectory ?? null;
      }
      if (!workingDirectory) {
        try {
          const res = await window.domainAPI?.invoke<string | null>(IPC_DOMAINS.WORKSPACE, 'getCurrent');
          workingDirectory = (res?.success ? res.data : null) ?? null;
        } catch {
          workingDirectory = null;
        }
      }
      if (!workingDirectory) {
        if (!cancelled) setGoalVerifyCandidates([]);
        return;
      }
      const raw = await readWorkspaceFile(`${workingDirectory}/package.json`);
      if (!cancelled) setGoalVerifyCandidates(buildVerifyCandidates(raw));
    })();
    return () => {
      cancelled = true;
    };
  }, [goalConfirm, currentSessionId]);

  useEffect(() => {
    const handleOpenSlashMenu = () => {
      setValue((current) => computeSlashMenuValue(current));
      setSlashFilter('');
      setShowSlashPopover(true);
      requestAnimationFrame(() => inputAreaRef.current?.focus());
    };
    window.addEventListener('app:openSlashMenu', handleOpenSlashMenu);
    return () => {
      window.removeEventListener('app:openSlashMenu', handleOpenSlashMenu);
    };
  }, []);

  const { processFile, processFolderEntry } = useFileUpload();
  // 拖放附件处理（高亮状态 + 文件/文件夹拖入转附件）
  const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useDragAndDrop({
    processFile,
    processFolderEntry,
    setAttachments,
    setIsUploading: (uploading) => setIsUploading(uploading),
  });
  // Composer typing stays passive for generic heuristics; only official registry skill
  // keyword/domain hits surface here, and only for not-yet-installed marketplace skills.
  const {
    recommendations: skillRecommendations,
    installingSkillName,
    mountRecommendedSkill,
    installRecommendedSkill,
  } = useSkillRecommendations(currentSessionId, value);
  const capabilityRegistry = useWorkbenchCapabilityRegistry();
  const capabilitySuggestions = useMemo(() => [], []);
  const browserSession = useWorkbenchBrowserSession();
  const buildContext = useComposerStore((state) => state.buildContext);
  const routingMode = useComposerStore((state) => state.routingMode);
  const targetAgentIds = useComposerStore((state) => state.targetAgentIds);
  const agentEntries = useAgentRegistryStore((state) => state.entries);
  const activeAgentId = useAppStore((state) => state.activeAgentId);
  const setActiveAgentId = useAppStore((state) => state.setActiveAgentId);
  const hasMessages = useSessionStore((state) => state.messages.length > 0);
  const currentSessionMemoryMode = useSessionStore((state) =>
    currentSessionId
      ? state.sessions.find((session) => session.id === currentSessionId)?.memoryMode || 'auto'
      : 'auto'
  );
  const swarmAgents = useSwarmStore((state) => state.agents);
  const selectedDirectAgents = useMemo(
    () => swarmAgents.filter((agent) => targetAgentIds.includes(agent.id)),
    [swarmAgents, targetAgentIds],
  );
  const inputPlaceholder = useMemo(() => {
    if (routingMode === 'direct') {
      return buildDirectRoutingPlaceholder(selectedDirectAgents, swarmAgents, t);
    }
    return undefined;
  }, [routingMode, selectedDirectAgents, swarmAgents, t]);
  const neoTagInvocation = useMemo(() => parseLeadingNeoTagInvocation(value), [value]);

  const buildEnvelope = useChatInputEnvelope({
    swarmAgents,
    agentEntries,
    activeAgentId,
    browserSession,
    voiceInputContext,
    buildContext,
    pendingPromptCommand,
    pendingAgentSelection,
  });

  // 上报 composer 槽位给 Rust，作为 Appshot 飞入动画的落点（屏幕逻辑坐标）
  useEffect(() => {
    if (!isNativeCommandRuntimeAvailable()) return;
    const report = () => {
      const el = appshotSlotRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      invokeNativeCommandAction('reportAppshotComposerSlot', {
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
      setVoiceInputContext(null);
      inputAreaRef.current?.focus();
    },
    focus: () => {
      inputAreaRef.current?.focus();
    },
  }), []);

  useEffect(() => {
    setVoiceInputContext(null);
  }, [currentSessionId]);

  useEffect(() => {
    if (debugDraftAppliedRef.current) return;
    const draft = readDebugDraftFromLocation(window.location);
    if (!draft) return;

    debugDraftAppliedRef.current = true;
    setValue(draft.content);
    setAttachments([]);
    setVoiceInputContext(null);
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
    if (pendingPromptCommand && !newValue.trimStart().startsWith(`/${pendingPromptCommand.name}`)) {
      setPendingPromptCommand(null);
    }
    if (newValue.toLowerCase().startsWith('/agent ')) {
      setShowSlashPopover(false);
      dismissAutocomplete();
      return;
    }
    const slashToken = getTrailingSlashToken(newValue);
    // Composer-native slash picker: supports leading "/" and tail tokens like "帮我整理 /sum".
    if (slashToken) {
      setShowSlashPopover(true);
      setSlashFilter(slashToken.query);
      dismissAutocomplete();
      return;
    }
    setShowSlashPopover(false);
    if (isLeadingNeoTagInput(newValue)) {
      dismissAutocomplete();
      return;
    }
    if (isLeadingAgentMentionInput(newValue, swarmAgents)) {
      dismissAutocomplete();
      return;
    }
    // Check for @ pattern at cursor position (approximate: end of string)
    searchFiles(newValue, newValue.length);
  }, [dismissAutocomplete, pendingPromptCommand, searchFiles, swarmAgents]);

  // Handle @ file selection
  const handleFileSelectAutocomplete = useCallback((filePath: string) => {
    // Replace @query with the file path
    const beforeAt = value.replace(new RegExp(`@${atQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
    setValue(beforeAt + '@' + filePath + ' ');
    dismissAutocomplete();
    inputAreaRef.current?.focus();
  }, [value, atQuery, dismissAutocomplete]);

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => inputAreaRef.current?.focus());
  }, []);

  // Agent 自动补全单元：@ mention 与 /agent 命令的 state / 派生 / 键盘导航 / 选择 handler
  const {
    selectedAgentMentionIndex,
    selectedAgentCommandIndex,
    agentMentionAutocomplete,
    agentCommandOptions,
    isAgentMentionAutocompleteOpen,
    isAgentCommandAutocompleteOpen,
    openAgentCommand,
    handleAgentMentionSelect,
    handleAgentCommandOptionSelect,
    handleAutocompleteKeyDown,
  } = useChatInputAgentCommand({
    value,
    swarmAgents,
    agentEntries,
    inputAreaRef,
    focusComposer,
    setValue,
    setShowSlashPopover,
    setSlashFilter,
  });

  // 斜杠命令 / 能力选择单元：slash popover 选择分发 + skill/connector/mcp 当轮挂载
  const {
    handleSlashCommandSelect,
  } = useChatInputSlashCommands({
    value,
    currentSessionId,
    skillRecommendations,
    mountRecommendedSkill,
    installRecommendedSkill,
    capabilityItems: capabilityRegistry.items,
    openAgentCommand,
    focusComposer,
    setValue,
    setShowSlashPopover,
    setSlashFilter,
    setPendingPromptCommand,
    setPendingAgentSelection,
    setActiveAgentId,
  });

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
    return t.chatInput.queuedGuidePlaceholder;
  }, [inputPlaceholder, isProcessing, t]);

  // 提交发送管线（schedule/loop/goal/agent 命令分支 + appshot 注入 + ! shell 快捷 + 失败回滚）
  const { handleSubmit, runScheduleCreation, startGoalRun } = useChatInputSubmit({
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
    openGoalConfirm: (initialGoal: string) => setGoalConfirm({ initialGoal }),
    closeGoalConfirm: () => setGoalConfirm(null),
    setActiveAgentId,
  });

  // 附件 / 语音 / 记忆开关动作单元
  const {
    handleFileSelect,
    handleImagePaste,
    removeAttachment,
    handleVoiceTranscript,
    handleMemoryModeToggle,
  } = useChatInputComposerActions({
    currentSessionId,
    currentSessionMemoryMode,
    processFile,
    inputAreaRef,
    setIsUploading,
    setAttachments,
    setValue,
    setVoiceInputContext,
  });

  const modelConfig = useAppStore((s) => s.modelConfig);
  const sessionCost = useStatusStore((s) => s.sessionCost);
  const statusStreaming = useStatusStore((s) => s.isStreaming);

  const hasContent = value.trim().length > 0 || attachments.length > 0;

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
        {/* 会话内循环（/loop）运行状态条 */}
        <LoopStatusBar sessionId={currentSessionId} />
        {/* 定时任务对话式创建卡片（/schedule 不带参数时） */}
        {scheduleComposerOpen && (
          <ScheduleComposerCard
            creating={creatingSchedule}
            onSubmit={async (description, options) => {
              setCreatingSchedule(true);
              const ok = await runScheduleCreation(description, options);
              setCreatingSchedule(false);
              if (ok) setScheduleComposerOpen(false);
            }}
            onDismiss={() => setScheduleComposerOpen(false)}
          />
        )}
        {goalConfirm && (
          <GoalConfirmCard
            initialGoal={goalConfirm.initialGoal}
            verifyCandidates={goalVerifyCandidates}
            submitting={submittingGoal}
            onSubmit={async (draft) => {
              setSubmittingGoal(true);
              const parsed = goalComposerDraftToParsed(draft, t);
              const ok = await startGoalRun(parsed, `/goal ${parsed.goal}`);
              setSubmittingGoal(false);
              if (!ok) setGoalConfirm({ initialGoal: parsed.goal });
            }}
            onDismiss={() => setGoalConfirm(null)}
          />
        )}
        {/* Plan 入口按钮 - 仅当有 Plan 时显示 */}
        {hasPlan && onPlanClick && (
          <button
            type="button"
            onClick={onPlanClick}
            className="flex items-center gap-2 px-3 py-2 mb-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg hover:bg-indigo-500/20 transition-colors w-full text-left"
          >
            <FileText className="w-4 h-4 text-indigo-400" />
            <span className="text-sm text-indigo-400">{t.chatInput.viewPlan}</span>
          </button>
        )}

        {/* 文件处理中提示 */}
        {isUploading && (
          <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-amber-400">{t.chatInput.processingFiles}</span>
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

        {/* @neo 续接 chip（ADR-035）：标记这条消息续接哪个 topic */}
        <div className="empty:hidden mb-2 px-2">
          <NeoContinuationChip />
        </div>

        {/* 附件预览区 */}
        {attachments.length > 0 && (
          <div className="mb-2">
            <AttachmentBar attachments={attachments} onRemove={removeAttachment} />
          </div>
        )}

        {/* 拖放提示 */}
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-800-950/90 backdrop-blur-sm z-10 rounded-xl border-2 border-dashed border-primary-500">
            <div className="flex flex-col items-center gap-2 text-primary-400">
              <Image className="w-8 h-8" />
              <span className="text-sm">{t.chat.dropFilesHere}</span>
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
        <RoleDraftNotifications />

        {/* Suggestion Bar - show when input is empty */}
        {value.trim().length === 0 && suggestions.length > 0 && (
          <SuggestionBar suggestions={suggestions} onSelect={handleSuggestionSelect} />
        )}

        <InlineWorkbenchBar />
        <CapabilitySuggestionStrip
          skillRecommendations={skillRecommendations}
          capabilitySuggestions={capabilitySuggestions}
          onSkillMount={(recommendation) => {
            void mountRecommendedSkill(recommendation);
          }}
          onSkillInstall={(recommendation) => {
            void installRecommendedSkill(recommendation);
          }}
          onCapabilitySelect={() => {}}
          installingSkillName={installingSkillName}
        />

        {/* Codex 风格融合：去掉明显边框 + 阴影，只用极弱 bg 区分输入区跟聊天内容 */}
        <div className="relative bg-white/[0.02] backdrop-blur-sm rounded-2xl focus-within:bg-white/[0.04] transition-colors duration-200">
          {/* Slash command inline popover */}
          <SlashCommandPopover
            isOpen={showSlashPopover}
            filter={slashFilter}
            agents={agentEntries}
            skillRecommendations={skillRecommendations}
            capabilityItems={capabilityRegistry.items}
            capabilitySuggestions={capabilitySuggestions}
            onClose={() => {
              setShowSlashPopover(false);
              setSlashFilter('');
            }}
            onSelect={handleSlashCommandSelect}
          />
          {isAgentCommandAutocompleteOpen && (
            <div className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-[240px] overflow-y-auto rounded-lg border border-zinc-700/70 bg-zinc-900 shadow-xl">
              <div className="border-b border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
                /agent
              </div>
              {agentCommandOptions.map((option, index) => (
                <React.Fragment key={option.id ?? 'default'}>
                  {option.group === 'role' && agentCommandOptions[index - 1]?.group !== 'role' && (
                    <div className="border-t border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
                      {t.agentCommand.roleGroupLabel}
                    </div>
                  )}
                <button
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
                </React.Fragment>
              ))}
              {/* 角色名单底部"招新"：对话式建角色入口（role-creation-flow §7） */}
              <button
                type="button"
                onClick={() => { setValue(''); void startCreateRoleChat(); }}
                className="flex w-full items-center gap-1.5 border-t border-zinc-800 px-3 py-2 text-left text-xs text-emerald-300 transition-colors hover:bg-emerald-500/10"
              >
                <UserPlus className="h-3.5 w-3.5 shrink-0" />
                {t.agentCommand.createRoleEntry}
              </button>
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
          {(!isAgentMentionAutocompleteOpen && !neoTagInvocation && isAutocompleteOpen && fileMatches.length > 0) && (
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
          {/* Neo Tag 轻量化重设计:@neo = 正常输入,composer 不再显示 "work card" 预览 chip
              (产品负责人 2026-07-02)。neoTagInvocation 仍用于压掉文件 mention 弹窗噪音。 */}
          <InputArea
            ref={inputAreaRef}
            value={value}
            onChange={handleValueChange}
            onSubmit={(opts) => { void handleSubmit(undefined, opts); }}
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
          <RuntimeInputShortcutHint isProcessing={Boolean(isProcessing)} />
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
                      <span>{t.chatInput.guidedBadge}</span>
                      {item.attachmentsCount > 0 && (
                        <span className="text-zinc-500">{t.chatInput.queuedAttachments.replace('{count}', String(item.attachmentsCount))}</span>
                      )}
                      {isProcessing ? (
                        <span className="inline-flex items-center gap-1 text-zinc-500">
                          <Clock3 className="h-3 w-3" />
                          {t.chatInput.queuedWaiting}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onSendQueuedRuntimeInput?.(item.id)}
                          className="text-zinc-400 hover:text-zinc-200"
                          title={t.chatInput.queuedSendNowTitle}
                        >
                          {t.chatInput.queuedSendNow}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onCancelQueuedRuntimeInput?.(item.id)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
                        title={t.chatInput.queuedWithdrawTitle}
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
              memoryMode={currentSessionMemoryMode}
              onToggleMemory={handleMemoryModeToggle}
              memoryToggleDisabled={!currentSessionId}
            />

            {/* 运行权限模式 chip（高频，保留独立位置） */}
            <PermissionToggle disabled={disabled && !isProcessing} />

            <AgentChip onOpenAgentCommand={openAgentCommand} />

            {/* C-6: 本会话记忆开关默认开启，已从底栏移入 InputAddMenu 二级菜单（低频功能不常驻） */}

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
