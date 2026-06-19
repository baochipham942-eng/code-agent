/* eslint-disable max-lines -- 既有贴线文件（prompt 命令 prefill 接入前已 ~1215 行），拆分另议 */
// ============================================================================
// ChatInput - 消息输入组件主入口
// 支持多模态输入：文本、图片、代码、PDF、文件夹
// 深度研究通过语义自动检测触发，无需手动切换
// ============================================================================

import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Image, FileText, Clock3, CornerDownRight, X, UserPlus } from 'lucide-react';
import type { MessageAttachment } from '../../../../../shared/contract';
import type { SpeechTranscribeResult } from '@shared/contract';
import type { AppSettings } from '@shared/contract/settings';
import type {
  ComposerAgentSelection,
  ComposerPromptCommandSelection,
  ConversationEnvelope,
  ConversationVoiceInputMetadata,
  RuntimeInputMode,
} from '@shared/contract/conversationEnvelope';
import { getModelCapabilities, getModelDisplayLabel, getProviderDisplayName, UI } from '@shared/constants';

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
import { SlashCommandPopover, type SlashCommand } from './SlashCommandPopover';
import { useFileUpload } from './useFileUpload';
import { useChatInputSessionScope } from './useChatInputSessionScope';
import { useFileAutocomplete } from '../../../../hooks/useFileAutocomplete';
import { useWorkbenchBrowserSession } from '../../../../hooks/useWorkbenchBrowserSession';
import { useSessionUIStore } from '../../../../stores/sessionUIStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useComposerStore } from '../../../../stores/composerStore';
import { useSkillStore } from '../../../../stores/skillStore';
import { useSwarmStore } from '../../../../stores/swarmStore';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import { ComboSkillCard } from './ComboSkillCard';
import { SkillDraftNotifications } from './SkillDraftCard';
import { RoleDraftNotifications } from './RoleDraftCard';
import { startCreateRoleChat } from '../../../../utils/startCreateRoleChat';
import { computeSlashMenuValue } from '../../../../utils/composerShortcuts';
import {
  buildCapabilitySemanticSuggestions,
  CapabilitySuggestionStrip,
  type SkillRecommendationView,
} from './CapabilitySuggestionStrip';
import { useSkillRecommendations } from './useSkillRecommendations';
import { useAppStore } from '../../../../stores/appStore';
import { useAppshotsStore } from '../../../../stores/appshotsStore';
import { AppshotChip } from './AppshotChip';
import { InlineWorkbenchBar } from '../InlineWorkbenchBar';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import type { WorkbenchCapabilityRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';
import { buildAppshotXml, buildAppshotAttachment } from '@shared/contract/appshot';
import {
  ModelSwitcher,
  MODEL_OVERRIDE_CHANGE_EVENT,
  type ModelOverrideChangeDetail,
} from '../../../StatusBar/ModelSwitcher';
import { buildRuntimeModelOptions, isDynamicCustomProviderId } from '@shared/modelRuntime';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';
import { trackRenderer } from '../../../../observability/posthogRenderer';
import { POSTHOG_EVENTS } from '@shared/observability/posthog-events';
import {
  goalComposerDraftToParsed,
  parseGoalCommand,
  isGoalCommand,
  normalizeGoalCommand,
  type ParsedGoalCommand,
} from './parseGoalCommand';
import { parseScheduleCommand, isScheduleCommand } from './parseScheduleCommand';
import { parseLoopCommand, isLoopCommand } from './parseLoopCommand';
import { cronClient, type CreateCronJobInput } from '../../../../services/cronClient';
import { loopClient } from '../../../../services/loopClient';
import { useLoopStore } from '../../../../stores/loopStore';
import { LoopStatusBar } from './LoopStatusBar';
import { ScheduleComposerCard } from './ScheduleComposerCard';
import { GoalComposerCard } from './GoalComposerCard';
import { buildGoalNoticeMessage } from '../goalNotice';
import { buildGoalSeedTodos } from '@shared/utils/goalTodos';
import {
  applyAgentMentionSuggestion,
  buildDirectRoutingPlaceholder,
  getLeadingAgentMentionAutocomplete,
  getPreferredAgentMentionToken,
  isLeadingAgentMentionInput,
} from './agentMentionRouting';
import {
  applyAgentCommandOption,
  getAgentCommandToken,
  getAgentCommandOptions,
  getAgentSlashCommandQuery,
  parseAgentSlashCommand,
} from './agentCommand';
import { shouldClearComposerAfterSend } from './utils';
import { useDragAndDrop } from './useDragAndDrop';
import { useChatInputEnvelope } from './useChatInputEnvelope';
import {
  clearDebugDraftParamsFromCurrentUrl,
  readDebugDraftFromLocation,
} from './debugDraftUrl';
import {
  buildInlineSkillTokenValue,
  buildLeadingSlashCommandValue,
  getTrailingSlashToken,
  removeTrailingSlashToken,
} from './slashPickerModel';
import { AgentChip } from './AgentChip';
import {
  applyModelStrategyRecommendationAction,
  buildModelStrategyRecommendationFeedback,
  buildModelStrategyRecommendation,
  type ModelStrategyCandidate,
  type ModelStrategyRecommendationFeedbackEvent,
  type ModelStrategyProviderHealthSnapshot,
} from './modelStrategyRecommendation';
import { ModelStrategyRecommendationStrip } from './ModelStrategyRecommendationStrip';

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
  const [voiceInputContext, setVoiceInputContext] = useState<{
    anchor: string;
    metadata: ConversationVoiceInputMetadata;
  } | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  // 会话作用域：currentSessionId / engine 类型 / 切换会话时清空草稿
  const { currentSessionId, sessionEngineKind, sessionEngineFailure } = useChatInputSessionScope(setValue, setAttachments);
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
  const [selectedAgentMentionIndex, setSelectedAgentMentionIndex] = useState(0);
  const [selectedAgentCommandIndex, setSelectedAgentCommandIndex] = useState(0);
  const [dismissedAgentAutocompleteValue, setDismissedAgentAutocompleteValue] = useState<string | null>(null);
  const [providerHealthMap, setProviderHealthMap] = useState<Record<string, ModelStrategyProviderHealthSnapshot>>({});
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
  // /goal 不带参数时的目标合同创建卡片
  const [goalComposerOpen, setGoalComposerOpen] = useState(false);
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
  // 输入命中技能关键词时的推荐（已安装→挂载 / 未安装→从推荐目录安装）
  const {
    recommendations: skillRecommendations,
    installingSkillName,
    mountRecommendedSkill,
    installRecommendedSkill,
  } = useSkillRecommendations(currentSessionId, value);
  const capabilityRegistry = useWorkbenchCapabilityRegistry();
  const setSelectedSkillIds = useComposerStore((state) => state.setSelectedSkillIds);
  const setSelectedConnectorIds = useComposerStore((state) => state.setSelectedConnectorIds);
  const setSelectedMcpServerIds = useComposerStore((state) => state.setSelectedMcpServerIds);
  const setTurnCapabilityScopeMode = useComposerStore((state) => state.setTurnCapabilityScopeMode);
  const openCapabilitySettingsTarget = useAppStore((state) => state.openCapabilitySettingsTarget);
  const capabilitySuggestions = useMemo(
    () => buildCapabilitySemanticSuggestions(value, capabilityRegistry.items),
    [capabilityRegistry.items, value],
  );
  const browserSession = useWorkbenchBrowserSession();
  const buildContext = useComposerStore((state) => state.buildContext);
  const mountSkill = useSkillStore((state) => state.mountSkill);
  const setSkillCurrentSession = useSkillStore((state) => state.setCurrentSession);
  const routingMode = useComposerStore((state) => state.routingMode);
  const targetAgentIds = useComposerStore((state) => state.targetAgentIds);
  const agentEntries = useAgentRegistryStore((state) => state.entries);
  const activeAgentId = useAppStore((state) => state.activeAgentId);
  const setActiveAgentId = useAppStore((state) => state.setActiveAgentId);
  const createSession = useSessionStore((state) => state.createSession);
  const updateSessionEngine = useSessionStore((state) => state.updateSessionEngine);
  const hasMessages = useSessionStore((state) => state.messages.length > 0);
  const currentSessionMemoryMode = useSessionStore((state) =>
    currentSessionId
      ? state.sessions.find((session) => session.id === currentSessionId)?.memoryMode || 'auto'
      : 'auto'
  );
  const updateSessionMemoryMode = useSessionStore((state) => state.updateSessionMemoryMode);
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

  const handleAgentMentionSelect = useCallback((agentId: string) => {
    const agent = swarmAgents.find((item) => item.id === agentId);
    if (!agent) return;
    setValue((prev) => applyAgentMentionSuggestion(prev, agent));
    setDismissedAgentAutocompleteValue(null);
    inputAreaRef.current?.focus();
  }, [swarmAgents]);

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => inputAreaRef.current?.focus());
  }, []);

  const openAgentCommand = useCallback(() => {
    setValue('/agent ');
    setShowSlashPopover(false);
    setSlashFilter('');
    setDismissedAgentAutocompleteValue(null);
    focusComposer();
  }, [focusComposer]);

  const markSkillSelected = useCallback((skillName: string) => {
    const currentSelectedSkillIds = useComposerStore.getState().selectedSkillIds;
    setSelectedSkillIds([...new Set([...currentSelectedSkillIds, skillName])]);
    setValue((prev) => buildInlineSkillTokenValue(prev, skillName));
    focusComposer();
  }, [focusComposer, setSelectedSkillIds]);

  const ensureSessionForSkill = useCallback(async (): Promise<string | null> => {
    if (currentSessionId) return currentSessionId;
    const session = await createSession('新对话');
    return session?.id ?? null;
  }, [createSession, currentSessionId]);

  const selectSkillForCurrentTurn = useCallback(async (input: {
    skillName: string;
    libraryId: string;
    mounted?: boolean;
    recommendation?: SkillRecommendationView;
    recommendationAction?: 'mount' | 'install';
  }): Promise<boolean> => {
    if (!input.mounted) {
      const targetSessionId = await ensureSessionForSkill();
      if (!targetSessionId) {
        toast.error(`挂载 Skill 失败：无法创建会话`);
        focusComposer();
        return false;
      }

      let mounted: boolean;
      if (input.recommendation && input.recommendationAction === 'install') {
        mounted = await installRecommendedSkill(input.recommendation, targetSessionId);
      } else if (input.recommendation) {
        mounted = await mountRecommendedSkill(input.recommendation, targetSessionId);
      } else {
        setSkillCurrentSession(targetSessionId);
        mounted = await mountSkill(input.skillName, input.libraryId);
      }

      if (!mounted) {
        toast.error(`挂载 Skill 失败：${input.skillName}`);
        focusComposer();
        return false;
      }
    }

    markSkillSelected(input.skillName);
    return true;
  }, [
    ensureSessionForSkill,
    focusComposer,
    installRecommendedSkill,
    markSkillSelected,
    mountRecommendedSkill,
    mountSkill,
    setSkillCurrentSession,
  ]);

  const selectWorkbenchCapabilityForCurrentTurn = useCallback((capability: WorkbenchCapabilityRegistryItem) => {
    setTurnCapabilityScopeMode('manual');

    if (capability.kind === 'skill') {
      void selectSkillForCurrentTurn({
        skillName: capability.id,
        libraryId: capability.libraryId || capability.source || 'unknown',
        mounted: capability.mounted,
      });
      return;
    }

    if (capability.kind === 'connector') {
      if (!capability.connected) {
        toast.warning(capability.blockedReason?.detail || `请先连接 ${capability.label}`);
        openCapabilitySettingsTarget({ kind: capability.kind, id: capability.id });
        focusComposer();
        return;
      }
      const currentSelectedConnectorIds = useComposerStore.getState().selectedConnectorIds;
      setSelectedConnectorIds([...new Set([...currentSelectedConnectorIds, capability.id])]);
      setValue((prev) => removeTrailingSlashToken(prev));
      focusComposer();
      return;
    }

    if (capability.status !== 'connected' && capability.status !== 'lazy') {
      toast.warning(capability.blockedReason?.detail || `请先连接 MCP：${capability.label}`);
      openCapabilitySettingsTarget({ kind: capability.kind, id: capability.id });
      focusComposer();
      return;
    }
    const currentSelectedMcpServerIds = useComposerStore.getState().selectedMcpServerIds;
    setSelectedMcpServerIds([...new Set([...currentSelectedMcpServerIds, capability.id])]);
    setValue((prev) => removeTrailingSlashToken(prev));
    focusComposer();
  }, [
    focusComposer,
    openCapabilitySettingsTarget,
    selectSkillForCurrentTurn,
    setSelectedConnectorIds,
    setSelectedMcpServerIds,
    setTurnCapabilityScopeMode,
  ]);

  const handleSlashCommandSelect = useCallback((cmd: SlashCommand) => {
    setShowSlashPopover(false);
    setSlashFilter('');
    if (cmd.actionKind !== 'prefill-prompt') {
      setPendingPromptCommand(null);
    }

    if (cmd.actionKind === 'open-agent-command') {
      openAgentCommand();
      return;
    }

    if (cmd.actionKind === 'create-role') {
      setValue('');
      void startCreateRoleChat();
      return;
    }

    if (cmd.actionKind === 'select-agent' && cmd.agentToken) {
      if (cmd.agentId) {
        setActiveAgentId(cmd.agentId);
        setPendingAgentSelection({
          id: cmd.agentId,
          name: cmd.label,
          token: cmd.agentToken,
          via: 'slash_picker',
        });
      } else {
        setActiveAgentId(null);
        setPendingAgentSelection({ id: null, name: 'Default', token: cmd.agentToken, via: 'slash_picker' });
      }
      setValue(removeTrailingSlashToken(value));
      focusComposer();
      return;
    }

    if (cmd.actionKind === 'prefill-prompt' && cmd.promptName) {
      setPendingPromptCommand({
        name: cmd.promptName,
        source: cmd.promptSource,
        hints: cmd.promptHints,
        via: 'slash_picker',
      });
      setValue(buildLeadingSlashCommandValue(value, cmd.promptName));
      focusComposer();
      return;
    }

    if (cmd.id === 'goal') {
      setValue('');
      setScheduleComposerOpen(false);
      setGoalComposerOpen(true);
      focusComposer();
      return;
    }

    if (cmd.actionKind === 'prefill-leading-command' && cmd.commandId) {
      setValue(buildLeadingSlashCommandValue(value, cmd.commandId));
      focusComposer();
      return;
    }

    if (cmd.actionKind === 'select-skill' && cmd.skillName) {
      const recommendation = skillRecommendations.find((item) => item.skillName === cmd.skillName);
      void selectSkillForCurrentTurn({
        skillName: cmd.skillName,
        libraryId: cmd.skillLibraryId || 'unknown',
        mounted: cmd.skillMounted,
        recommendation,
        recommendationAction: cmd.skillRecommendationAction,
      });
      return;
    }

    if (cmd.actionKind === 'select-connector' && cmd.connectorId) {
      const capability = capabilityRegistry.items.find((item) => item.kind === 'connector' && item.id === cmd.connectorId);
      if (capability) selectWorkbenchCapabilityForCurrentTurn(capability);
      return;
    }

    if (cmd.actionKind === 'select-mcp' && cmd.mcpServerId) {
      const capability = capabilityRegistry.items.find((item) => item.kind === 'mcp' && item.id === cmd.mcpServerId);
      if (capability) selectWorkbenchCapabilityForCurrentTurn(capability);
      return;
    }

    setValue(removeTrailingSlashToken(value));
    cmd.action();
    focusComposer();
  }, [
    capabilityRegistry.items,
    focusComposer,
    openAgentCommand,
    selectSkillForCurrentTurn,
    selectWorkbenchCapabilityForCurrentTurn,
    setActiveAgentId,
    skillRecommendations,
    value,
  ]);

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
  }, [addToInputHistory, attachments, buildEnvelope, currentSessionId, onSend]);

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
  const handleVoiceTranscript = useCallback((text: string, result?: SpeechTranscribeResult) => {
    const transcript = text.trim();
    if (transcript) {
      const rawTranscript = result?.rawText?.trim();
      setValue(prev => {
        const current = prev.trimEnd();
        if (!current) return transcript;
        return `${current}\n\n${transcript}`;
      });
      setVoiceInputContext({
        anchor: transcript.slice(0, 64),
        metadata: {
          inputSource: 'voice',
          asrEngine: result?.engine,
          language: result?.language,
          model: result?.model,
          durationMs: result?.durationMs,
          audioDurationSeconds: result?.audioDurationSeconds,
          transcriptionMode: result?.engine === 'groq' ? 'cloud' : result?.engine === 'local-whisper' ? 'local' : undefined,
          transcriptChars: transcript.length,
          rawTranscriptChars: rawTranscript?.length,
          postProcessed: Boolean(rawTranscript && rawTranscript !== transcript),
          chunkCount: result?.chunkCount,
        },
      });
      // 聚焦输入框
      inputAreaRef.current?.focus();
    }
  }, []);

  const handleMemoryModeToggle = useCallback(async () => {
    if (!currentSessionId) return;
    const nextMode = currentSessionMemoryMode === 'off' ? 'auto' : 'off';
    try {
      await updateSessionMemoryMode(currentSessionId, nextMode);
      toast.success(nextMode === 'off' ? '本会话记忆已关闭' : '本会话记忆已开启');
    } catch (error) {
      toast.error(`更新记忆设置失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }, [currentSessionId, currentSessionMemoryMode, updateSessionMemoryMode]);

  const modelConfig = useAppStore((s) => s.modelConfig);
  const [sessionModelOverride, setSessionModelOverride] = useState<ModelOverrideChangeDetail['override']>(null);
  const [modelSettings, setModelSettings] = useState<AppSettings | null>(null);
  const [dismissedModelStrategyKey, setDismissedModelStrategyKey] = useState<string | null>(null);
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
  const effectiveProviderId = sessionModelOverride?.provider ?? modelConfig.provider;
  const effectiveModelId = sessionModelOverride?.model ?? modelConfig.model;
  useEffect(() => {
    let cancelled = false;
    const request = window.domainAPI?.invoke<AppSettings>(IPC_DOMAINS.SETTINGS, 'get', {});
    if (!request) return;
    request.then((res) => {
      if (!cancelled && res?.success && res.data) {
        setModelSettings(res.data);
      }
    })
      .catch(() => {
        if (!cancelled) setModelSettings(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (sessionEngineKind !== 'native') return;
    let cancelled = false;
    const request = window.domainAPI?.invoke<Record<string, ModelStrategyProviderHealthSnapshot>>(
      IPC_DOMAINS.PROVIDER,
      'getHealthStatus',
      {},
    );
    if (!request) return;
    request.then((res) => {
      if (!cancelled && res?.success && res.data) {
        setProviderHealthMap(res.data);
      }
    })
      .catch(() => {
        if (!cancelled) setProviderHealthMap({});
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveProviderId, sessionEngineKind]);
  const effectiveModelCapabilities = useMemo(() => {
    const capabilities = new Set(getModelCapabilities(effectiveModelId));
    if (effectiveModelId === modelConfig.model) {
      for (const capability of modelConfig.capabilities ?? []) {
        if (capability === 'vision') capabilities.add('vision');
        if (capability === 'longContext') capabilities.add('long-context');
      }
    }
    return Array.from(capabilities);
  }, [effectiveModelId, modelConfig.capabilities, modelConfig.model]);
  const modelStrategyCandidates = useMemo<ModelStrategyCandidate[]>(() => {
    if (!modelSettings) return [];
    return buildRuntimeModelOptions(modelSettings).map((option) => ({
      provider: option.provider,
      providerLabel: option.providerLabel,
      model: option.model,
      modelLabel: option.label,
      capabilities: Array.from(new Set([
        ...option.features,
        ...getModelCapabilities(option.model),
      ])),
      providerHealth: providerHealthMap[option.provider],
    }));
  }, [modelSettings, providerHealthMap]);
  const effectiveProviderBillingMode = useMemo(() => {
    const configured = modelSettings?.models.providers?.[effectiveProviderId]?.billingMode;
    if (configured) return configured;
    return isDynamicCustomProviderId(effectiveProviderId) ? 'unknown' : 'payg';
  }, [effectiveProviderId, modelSettings]);
  const modelStrategyRecommendation = useMemo(() => buildModelStrategyRecommendation({
    inputValue: value,
    hasImageAttachments,
    engineKind: sessionEngineKind,
    modelLabel: getModelDisplayLabel(effectiveModelId),
    modelCapabilities: effectiveModelCapabilities,
    adaptiveEnabled: Boolean(sessionModelOverride?.adaptive || modelConfig.adaptive),
    currentProvider: effectiveProviderId,
    currentModel: effectiveModelId,
    providerLabel: getProviderDisplayName(effectiveProviderId),
    providerHealth: providerHealthMap[effectiveProviderId],
    billingMode: effectiveProviderBillingMode,
    externalEngineFailure: sessionEngineFailure,
    candidates: modelStrategyCandidates,
  }), [
    effectiveModelCapabilities,
    effectiveModelId,
    effectiveProviderId,
    effectiveProviderBillingMode,
    hasImageAttachments,
    modelStrategyCandidates,
    modelConfig.adaptive,
    providerHealthMap,
    sessionEngineFailure,
    sessionEngineKind,
    sessionModelOverride?.adaptive,
    value,
  ]);
  const visibleModelStrategyRecommendation =
    modelStrategyRecommendation?.key === dismissedModelStrategyKey ? null : modelStrategyRecommendation;

  const applyModelStrategyOverride = useCallback((override: ModelOverrideChangeDetail['override']) => {
    setSessionModelOverride(override);
    if (!currentSessionId) return;
    window.dispatchEvent(new CustomEvent<ModelOverrideChangeDetail>(MODEL_OVERRIDE_CHANGE_EVENT, {
      detail: { sessionId: currentSessionId, override },
    }));
  }, [currentSessionId]);

  const recordModelStrategyFeedback = useCallback((feedback: ModelStrategyRecommendationFeedbackEvent) => {
    trackRenderer(POSTHOG_EVENTS.MODEL_STRATEGY_RECOMMENDATION_FEEDBACK, { ...feedback });
  }, []);

  const handleApplyModelStrategyRecommendation = useCallback(async () => {
    await applyModelStrategyRecommendationAction({
      currentSessionId,
      recommendation: visibleModelStrategyRecommendation,
      currentProvider: effectiveProviderId,
      currentModel: effectiveModelId,
      switchModel: async (request) => {
        const res = await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'switchModel', request);
        return res as { success?: boolean; error?: { message?: string } } | undefined;
      },
      updateSessionEngine,
      applyOverride: applyModelStrategyOverride,
      dismiss: setDismissedModelStrategyKey,
      recordFeedback: recordModelStrategyFeedback,
      notifySuccess: toast.success,
      notifyError: toast.error,
    });
  }, [applyModelStrategyOverride, currentSessionId, effectiveModelId, effectiveProviderId, recordModelStrategyFeedback, updateSessionEngine, visibleModelStrategyRecommendation]);

  const handleDismissModelStrategyRecommendation = useCallback(() => {
    if (!visibleModelStrategyRecommendation) return;
    const feedback = buildModelStrategyRecommendationFeedback(visibleModelStrategyRecommendation, 'dismissed');
    if (feedback) recordModelStrategyFeedback(feedback);
    setDismissedModelStrategyKey(visibleModelStrategyRecommendation.key);
  }, [recordModelStrategyFeedback, visibleModelStrategyRecommendation]);

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
            onSubmit={async (description) => {
              setCreatingSchedule(true);
              const ok = await runScheduleCreation(description);
              setCreatingSchedule(false);
              if (ok) setScheduleComposerOpen(false);
            }}
            onDismiss={() => setScheduleComposerOpen(false)}
          />
        )}
        {goalComposerOpen && (
          <GoalComposerCard
            submitting={submittingGoal}
            onSubmit={async (draft) => {
              setSubmittingGoal(true);
              const parsed = goalComposerDraftToParsed(draft);
              const ok = await startGoalRun(parsed, `/goal ${parsed.goal}`);
              setSubmittingGoal(false);
              if (!ok) setGoalComposerOpen(true);
            }}
            onDismiss={() => setGoalComposerOpen(false)}
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

        {visibleModelStrategyRecommendation && (
          <ModelStrategyRecommendationStrip
            recommendation={visibleModelStrategyRecommendation}
            onApply={handleApplyModelStrategyRecommendation}
            onDismiss={handleDismissModelStrategyRecommendation}
          />
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
        <RoleDraftNotifications />

        {/* Suggestion Bar - show when input is empty */}
        {value.trim().length === 0 && suggestions.length > 0 && (
          <SuggestionBar suggestions={suggestions} onSelect={handleSuggestionSelect} />
        )}

        <InlineWorkbenchBar />

        {/* Skill / MCP / Connector 推荐条 - 输入命中关键词时显示 */}
        <CapabilitySuggestionStrip
          skillRecommendations={showSlashPopover ? [] : skillRecommendations}
          capabilitySuggestions={showSlashPopover ? [] : capabilitySuggestions}
          onSkillMount={(recommendation) => {
            void selectSkillForCurrentTurn({
              skillName: recommendation.skillName,
              libraryId: recommendation.libraryId,
              mounted: false,
              recommendation,
              recommendationAction: recommendation.action ?? 'mount',
            });
          }}
          onSkillInstall={(recommendation) => {
            void selectSkillForCurrentTurn({
              skillName: recommendation.skillName,
              libraryId: recommendation.libraryId,
              mounted: false,
              recommendation,
              recommendationAction: 'install',
            });
          }}
          onCapabilitySelect={selectWorkbenchCapabilityForCurrentTurn}
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
              {/* 角色名单底部"招新"：对话式建角色入口（role-creation-flow §7） */}
              <button
                type="button"
                onClick={() => { setValue(''); void startCreateRoleChat(); }}
                className="flex w-full items-center gap-1.5 border-t border-zinc-800 px-3 py-2 text-left text-xs text-emerald-300 transition-colors hover:bg-emerald-500/10"
              >
                <UserPlus className="h-3.5 w-3.5 shrink-0" />
                新建角色…
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
