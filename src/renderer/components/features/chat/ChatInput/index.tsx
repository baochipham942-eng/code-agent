// ============================================================================
// ChatInput - 消息输入组件主入口
// 支持多模态输入：文本、图片、代码、PDF、文件夹
// 深度研究通过语义自动检测触发，无需手动切换
// ============================================================================

import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Image, FileText, UserPlus } from 'lucide-react';
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
import { QueuedRuntimeInputCard } from './QueuedRuntimeInputCard';
import { InputAddMenu } from './InputAddMenu';
import { SendButton } from './SendButton';
import { SuggestionBar } from './SuggestionBar';
import { VoiceInputButton } from './VoiceInputButton';
import { DictationRecordingBar } from './DictationRecordingBar';
import {
  applyDictationPartial,
  beginDictationAnchor,
  cancelDictationAnchor,
  markDictationUserEdit,
  settleDictationFinal,
  type DictationComposerAnchor,
} from './dictationComposerAnchor';
import { useVoiceInput } from '../../../../hooks/useVoiceInput';
import { LiveVoiceButton } from '../../voice/LiveVoiceButton';
import { useVoiceLiveAvailability } from '../../voice/useVoiceLiveAvailability';
import { useVoiceCallStore, type VoiceCallPhase } from '../../../../stores/voiceCallStore';
import { VoiceChrome } from '../../voice/VoiceChrome';
import { PermissionToggle } from './PermissionToggle';
import { ContextUsagePill } from '../ContextUsagePill';
import { CommandPalette } from '../../../CommandPalette';
import { SlashCommandPopover } from './SlashCommandPopover';
import { useFileUpload } from './useFileUpload';
import { useChatInputSessionScope } from './useChatInputSessionScope';
import { useAtMentionPanel, type AtMentionFileRow } from './useAtMentionPanel';
import { AtMentionPopover } from './AtMentionPopover';
import { useWorkbenchBrowserSession } from '../../../../hooks/useWorkbenchBrowserSession';
import { useSessionUIStore } from '../../../../stores/sessionUIStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useComposerStore } from '../../../../stores/composerStore';
import { useSwarmStore } from '../../../../stores/swarmStore';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import { ComboSkillCard } from './ComboSkillCard';
import { SkillDraftNotifications } from './SkillDraftCard';
import { RoleDraftNotifications } from './RoleDraftCard';
import { TeamRecipeDraftNotifications } from './TeamRecipeDraftCard';
import { SessionMemberBar } from '../../expert/SessionMemberBar';
import { RoleInitialAvatar } from '../../expert/RoleInitialAvatar';
import { useMemberViewStore } from '../../../../stores/memberViewStore';
import { startCreateRoleChat } from '../../../../utils/startCreateRoleChat';
import { computeSlashMenuValue } from '../../../../utils/composerShortcuts';
import { useSkillRecommendations } from './useSkillRecommendations';
import { CapabilitySuggestionStrip } from './CapabilitySuggestionStrip';
import { buildIactChipSendText } from './iactChipConfirmation';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppStore } from '../../../../stores/appStore';
import { useAppshotsStore } from '../../../../stores/appshotsStore';
import { ComposerChipsRow } from './ComposerChipsRow';
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
import { SeedComposerCard, type SeedComposerKind } from './SeedComposerCard';
import { buildVerifyCandidates } from './goalConfirm';
import { readWorkspaceFile } from '../../../design/designFiles';
import {
  buildDirectRoutingPlaceholder,
  getPreferredAgentMentionToken,
  isLeadingAgentMentionInput,
} from './agentMentionRouting';
import { useDragAndDrop } from './useDragAndDrop';
import { useChatInputEnvelope } from './useChatInputEnvelope';
import { useChatInputAgentCommand } from './useChatInputAgentCommand';
import { useChatInputSlashCommands } from './useChatInputSlashCommands';
import { useComposerFocusRequest } from './useComposerFocusRequest';
import { useChatInputSubmit } from './useChatInputSubmit';
import { useChatInputComposerActions } from './useChatInputComposerActions';
import {
  clearDebugDraftParamsFromCurrentUrl,
  readDebugDraftFromLocation,
} from './debugDraftUrl';
import { getTrailingSlashToken } from './slashPickerModel';
import type { InlineChipRef } from './composerRichTextModel';
import type { InlineChipView } from './InlineComposerChip';
import { buildMentionAttachment } from './mentionAttachment';
import { AgentChip } from './AgentChip';
import { MountedConnectorIcons } from './MountedConnectorIcons';
import { getAgentSlashCommandQuery } from './agentCommand';
import { SurfaceExecutionComposerStatus } from '../../surfaceExecution/SurfaceExecutionRunStatus';
import { ComposerUploadStatus } from './ComposerUploadStatus';

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
  /** @returns 是否真的撤回成功——成功才把内容退回输入框（已发出去的不能退）。 */
  onCancelQueuedRuntimeInput?: (id: string) => void | Promise<boolean>;
  onSendQueuedRuntimeInput?: (id: string) => void;
  /** 是否有 Plan */
  hasPlan?: boolean;
  /** 点击 Plan 入口 */
  onPlanClick?: () => void;
  /**
   * 无会话语境（如协作空间页 composer）：按主界面新会话草稿同款语义处理——
   * 会话作用域视为 null，会话绑定部件（/loop、记忆开关、资料库 pin、实时通话）
   * 走既有草稿态降级，不会绑到页面背后那个会话上发错配置。
   */
  sessionless?: boolean;
}

// Imperative handle exposed to parent (e.g. ChatView drop zone)
export interface ChatInputHandle {
  addAttachments: (items: MessageAttachment[]) => void;
  setDraft: (draft: { content: string; attachments?: MessageAttachment[] }) => void;
  focus: () => void;
}

// ============================================================================
// 实时通话入口的槽位判定（单真源，组件外可测）
// ============================================================================
//   primary   = 占输入框右侧主按钮位（空输入框 + 没在跑 + 空闲相位 + 入口可用）；
//   secondary = 主位被停止键占用（正在跑）时退到停止键左边的次位——通话入口
//               挂在原地、照常可拨，不是整个消失（X5.5 返工批 R4c 真机：一通挂断后
//               派出去的活还在跑，isProcessing 把主位判给停止键，通话按钮「短暂消失、
//               跑完（下一通前）才回来」）；
//   none      = 通话中（VoiceChrome 接管）/ 无会话 / 总开关关 / 有草稿（发送键有事可做）。
export type LiveVoiceSlot = 'primary' | 'secondary' | 'none';

export function resolveLiveVoiceSlot(params: {
  hasContent: boolean;
  isProcessing: boolean;
  sessionId: string | null;
  enabled: boolean;
  phase: VoiceCallPhase;
}): LiveVoiceSlot {
  if (!params.sessionId || !params.enabled || params.phase !== 'idle') return 'none';
  if (params.hasContent) return 'none';
  return params.isProcessing ? 'secondary' : 'primary';
}

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
  sessionless = false,
}, ref) => {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  // @ 文件附件是异步读盘构建的，chip 替换触发词时需要此刻的最新文本（闭包里的 value 可能已旧）
  const latestValueRef = useRef('');
  latestValueRef.current = value;
  const [voiceInputContext, setVoiceInputContext] = useState<{
    anchor: string;
    metadata: ConversationVoiceInputMetadata;
  } | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  // 会话作用域：currentSessionId / engine 类型 / 切换会话时清空草稿
  // （sessionless 时强制 null——项目页等无会话语境，见 ChatInputProps.sessionless）
  const { currentSessionId } = useChatInputSessionScope(setValue, setAttachments, sessionless);
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
  const currentSessionProjectId = useSessionStore((s) => s.sessions.find((x) => x.id === currentSessionId)?.projectId ?? null);
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
  const [seedComposer, setSeedComposer] = useState<{ kind: SeedComposerKind; initialText: string } | null>(null);
  const [submittingSeedComposer, setSubmittingSeedComposer] = useState(false);
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
    const handleOpenSeedComposer = (event: Event) => {
      const kind = (event as CustomEvent<{ kind?: SeedComposerKind }>).detail?.kind;
      if (kind === 'team' || kind === 'role') setSeedComposer({ kind, initialText: '' });
    };
    window.addEventListener('app:openSeedComposer', handleOpenSeedComposer);
    return () => window.removeEventListener('app:openSeedComposer', handleOpenSeedComposer);
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
  const pendingCommand = useComposerStore((state) => state.pendingCommand);
  const selectedSkillIds = useComposerStore((state) => state.selectedSkillIds);
  const agentEntries = useAgentRegistryStore((state) => state.entries);
  const activeAgentId = useAppStore((state) => state.activeAgentId);
  const viewingMemberId = useMemberViewStore((state) => state.viewingMemberId);
  const setViewingMemberId = useMemberViewStore((state) => state.setViewingMemberId);
  const setActiveAgentId = useAppStore((state) => state.setActiveAgentId);
  const hasMessages = useSessionStore((state) => state.messages.length > 0);
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
  // /agent 面板的 typed-query（任务 15：面板顶部 query echo 行）
  const agentCommandQuery = useMemo(() => getAgentSlashCommandQuery(value), [value]);

  // 文字流内联 chip（WorkBuddy phrase chip 模型）：chip 是 store 的渲染，不是数据源。
  // 命令 → pendingCommand（teal）；当轮 skill → selectedSkillIds（sparkle）；
  // @ 文件 → attachments（文件类型图标）。视觉顺序由编辑器 DOM 里的挂载点位置决定。
  const inlineChips = useMemo<InlineChipView[]>(() => {
    const chips: InlineChipView[] = [];
    if (pendingCommand) {
      chips.push({ key: `command:${pendingCommand.id}`, kind: 'command', id: pendingCommand.id, label: pendingCommand.name });
    }
    for (const skillId of selectedSkillIds) {
      const item = capabilityRegistry.items.find((entry) => entry.kind === 'skill' && entry.id === skillId);
      chips.push({ key: `skill:${skillId}`, kind: 'skill', id: skillId, label: item?.label ?? skillId });
    }
    for (const attachment of attachments) {
      chips.push({
        key: `file:${attachment.id}`,
        kind: 'file',
        id: attachment.id,
        label: attachment.name,
        category: attachment.category,
      });
    }
    return chips;
  }, [pendingCommand, selectedSkillIds, attachments, capabilityRegistry.items]);

  // slash 面板选中后：光标前的触发词（/goal、/sk…）原位替换成 chip 挂载点。
  // 无触发词（+ 菜单等无光标来源）时 no-op——store 更新后编辑器对账会把 chip 补到末尾。
  const insertInlineChip = useCallback((chip: InlineChipRef) => {
    const editor = inputAreaRef.current;
    if (!editor) return;
    const caret = editor.getCaretOffset();
    const token = getTrailingSlashToken(latestValueRef.current.slice(0, caret));
    if (!token) return;
    editor.replaceRangeWithChip(token.start, token.end, chip);
  }, []);

  // 内联 chip 删除（× / chip 聚焦 Delete / Backspace 紧贴删除）：从对应 store 移除，
  // DOM 挂载点由编辑器的对账 effect 摘除（Backspace 路径已在键处理里先摘了）。
  const handleRemoveInlineChip = useCallback((chip: InlineChipView) => {
    if (chip.kind === 'command') {
      const store = useComposerStore.getState();
      if (store.pendingCommand?.id === chip.id) store.setPendingCommand(null);
      return;
    }
    if (chip.kind === 'skill') {
      const store = useComposerStore.getState();
      store.setTurnCapabilityScopeMode('manual');
      store.setSelectedSkillIds(store.selectedSkillIds.filter((id) => id !== chip.id));
      return;
    }
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== chip.id));
  }, []);

  // 浏览器侧删了 chip（框选删除 / 剪切）：DOM 现存的 chip key 回传，缺席的 store 条目同步移除。
  const handleInlineChipsChanged = useCallback((presentKeys: string[]) => {
    const present = new Set(presentKeys);
    const store = useComposerStore.getState();
    if (store.pendingCommand && !present.has(`command:${store.pendingCommand.id}`)) {
      store.setPendingCommand(null);
    }
    const keptSkills = store.selectedSkillIds.filter((id) => present.has(`skill:${id}`));
    if (keptSkills.length !== store.selectedSkillIds.length) {
      store.setTurnCapabilityScopeMode('manual');
      store.setSelectedSkillIds(keptSkills);
    }
    setAttachments((prev) => {
      const next = prev.filter((attachment) => present.has(`file:${attachment.id}`));
      return next.length === prev.length ? prev : next;
    });
  }, []);

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

  // 上报 composer 槽位给 Rust，作为 Appshot 飞入动画的落点。
  // 锚点渲染在 ComposerChipsRow 内（chip 缩略图位置），这里只负责测量上报：
  // 只报「窗口视口内坐标」（getBoundingClientRect），不加 window.screenX/screenY——
  // 它们在部分 macOS 环境是物理像素，与 CSS 逻辑像素混算会把落点打出屏幕；
  // 屏幕坐标由 Rust 侧用主窗口 outer_position 换算（单位一致）。
  useEffect(() => {
    if (!isNativeCommandRuntimeAvailable()) return;
    const report = () => {
      const el = appshotSlotRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      invokeNativeCommandAction('reportAppshotComposerSlot', {
          slot: { x: r.left, y: r.top, width: r.width, height: r.height },
        })
        .catch(() => {});
    };
    const timer = window.setTimeout(report, 300);
    window.addEventListener('resize', report);
    const composerEl = formRef.current;
    const observer = typeof ResizeObserver !== 'undefined' && composerEl
      ? new ResizeObserver(report)
      : null;
    if (observer && composerEl) observer.observe(composerEl);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', report);
      observer?.disconnect();
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
        void onSend(buildEnvelope(buildIactChipSendText(t, text.trim())));
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
  }, [buildEnvelope, onSend, t]);

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

  // @ 触发面板（任务 14：资料库 pin + 工作区文件分组；任务 15：query echo + 键盘导航）
  // 文件行选中 = 触发词原位变文件 chip + 构建附件（文本类内联内容，二进制只带路径）；
  // 目录行保留旧行为（@path 文本）；资料库行选中在 hook 内切换 pin。
  const handleAtFileSelect = useCallback((row: AtMentionFileRow) => {
    const editor = inputAreaRef.current;
    const caret = editor?.getCaretOffset() ?? latestValueRef.current.length;
    const beforeCaret = latestValueRef.current.slice(0, caret);
    const triggerMatch = beforeCaret.match(/@([^\s@]*)$/);
    const triggerStart = triggerMatch ? caret - triggerMatch[0].length : caret;

    if (row.isDirectory || !editor) {
      editor?.replaceRangeWithText(triggerStart, caret, `@${row.path} `);
      editor?.focus();
      return;
    }

    const workingDirectory = useAppStore.getState().workingDirectory
      ?? useSessionStore.getState().sessions.find((session) => session.id === currentSessionId)?.workingDirectory
      ?? null;
    void (async () => {
      const attachment = await buildMentionAttachment({ path: row.path, name: row.name, workingDirectory });
      // 读盘期间用户可能继续输入：以最新文本重定位触发词，找不到就交给对账把 chip 补到末尾
      const freshCaret = editor.getCaretOffset();
      const freshBefore = latestValueRef.current.slice(0, freshCaret);
      const freshMatch = freshBefore.match(/@([^\s@]*)$/);
      if (freshMatch) {
        editor.replaceRangeWithChip(freshCaret - freshMatch[0].length, freshCaret, {
          key: `file:${attachment.id}`,
          kind: 'file',
          id: attachment.id,
        });
      }
      setAttachments((prev) => [...prev, attachment].slice(0, UI.MAX_ATTACHMENTS_DROP));
    })();
    editor.focus();
  }, [currentSessionId]);
  const atMention = useAtMentionPanel({
    sessionId: currentSessionId ?? null,
    projectId: currentSessionProjectId,
    onFileSelect: handleAtFileSelect,
  });
  const { search: searchAtMention, dismiss: dismissAtMention } = atMention;

  // Track input changes for @ autocomplete and / command palette
  const handleValueChange = useCallback((newValue: string) => {
    setValue(newValue);
    if (pendingPromptCommand && !newValue.trimStart().startsWith(`/${pendingPromptCommand.name}`)) {
      setPendingPromptCommand(null);
    }
    if (newValue.toLowerCase().startsWith('/agent ')) {
      setShowSlashPopover(false);
      dismissAtMention();
      return;
    }
    // 触发词识别是光标位置感知的：只看光标前的纯文本算尾 token
    const caret = inputAreaRef.current?.getCaretOffset() ?? newValue.length;
    const beforeCaret = newValue.slice(0, caret);
    const slashToken = getTrailingSlashToken(beforeCaret);
    // Composer-native slash picker: supports leading "/" and tail tokens like "帮我整理 /sum".
    if (slashToken) {
      setShowSlashPopover(true);
      setSlashFilter(slashToken.query);
      dismissAtMention();
      return;
    }
    setShowSlashPopover(false);
    if (isLeadingAgentMentionInput(newValue, swarmAgents)) {
      dismissAtMention();
      return;
    }
    // Check for @ pattern at cursor position
    searchAtMention(newValue, caret);
  }, [dismissAtMention, pendingPromptCommand, searchAtMention, swarmAgents]);

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => inputAreaRef.current?.focus());
  }, []);

  useComposerFocusRequest(focusComposer);

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
    setPendingAgentSelection,
    setActiveAgentId,
  });

  // 斜杠命令 / 能力选择单元：slash popover 选择分发 + skill/connector/mcp 当轮挂载
  const {
    handleSlashCommandSelect,
    selectWorkbenchCapabilityForCurrentTurn,
  } = useChatInputSlashCommands({
    value,
    currentSessionId,
    skillRecommendations,
    mountRecommendedSkill,
    installRecommendedSkill,
    capabilityItems: capabilityRegistry.items,
    openAgentCommand,
    focusComposer,
    insertInlineChip,
    setValue,
    setShowSlashPopover,
    setSlashFilter,
    setPendingPromptCommand,
    setPendingAgentSelection,
    setActiveAgentId,
    openSeedComposer: (kind) => setSeedComposer({ kind, initialText: '' }),
  });

  // 历史命令功能
  const {
    addToInputHistory,
    getPreviousInput,
    getNextInput,
    resetInputHistoryIndex,
  } = useSessionUIStore();

  // 键盘导航分发：@ 面板与 agent 自动补全互斥打开，先问 @ 面板再交 agent 链路
  const handleComposerAutocompleteKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => (
    atMention.handleKeyDown(e) || handleAutocompleteKeyDown(e)
  ), [atMention.handleKeyDown, handleAutocompleteKeyDown]);

  const resolvedPlaceholder = useMemo(() => {
    if (inputPlaceholder) return inputPlaceholder;
    if (!isProcessing) return undefined;
    return t.chatInput.queuedGuidePlaceholder;
  }, [inputPlaceholder, isProcessing, t]);

  // 提交发送管线（schedule/loop/goal/agent 命令分支 + appshot 注入 + ! shell 快捷 + 失败回滚）
  const { handleSubmit, runScheduleCreation, startGoalRun, submitSeedComposer } = useChatInputSubmit({
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
    openSeedComposer: (kind) => setSeedComposer({ kind, initialText: '' }),
    setActiveAgentId,
  });

  // 附件 / 语音动作单元
  const {
    handleFileSelect,
    handleImagePaste,
    handleVoiceTranscript,
  } = useChatInputComposerActions({
    processFile,
    inputAreaRef,
    setIsUploading,
    setAttachments,
    setValue,
    setVoiceInputContext,
  });

  const modelConfig = useAppStore((s) => s.modelConfig);

  // G4 Dictation 录音态：hook 提到 ChatInput 层，录音条（波形铺满输入行）与
  // 语音按钮共享同一路采集状态。录音条的发送按钮 = 停止录音 + 转写完成后
  // 自动提交（send-after-transcript）；停止按钮 = 转写后文本落回输入框可编辑。
  const handleVoiceTranscriptRef = useRef(handleVoiceTranscript);
  handleVoiceTranscriptRef.current = handleVoiceTranscript;
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;
  const valueRef = useRef(value);
  valueRef.current = value;
  const dictationSendAfterTranscriptRef = useRef(false);
  const dictationAnchorRef = useRef<DictationComposerAnchor | null>(null);
  const writeDictationValue = useCallback((next: string) => {
    valueRef.current = next;
    setValue(next);
  }, [setValue]);
  const voice = useVoiceInput({
    onStreamStart: () => {
      dictationAnchorRef.current = beginDictationAnchor(valueRef.current);
    },
    onPartialTranscript: (text) => {
      const anchor = dictationAnchorRef.current;
      if (!anchor) return;
      const applied = applyDictationPartial(anchor, text);
      dictationAnchorRef.current = applied.state;
      if (applied.value !== null) writeDictationValue(applied.value);
    },
    onTranscript: (text, result) => {
      const anchor = dictationAnchorRef.current;
      if (anchor) {
        const settled = settleDictationFinal(anchor, valueRef.current, text);
        dictationAnchorRef.current = settled.state;
        writeDictationValue(settled.value);
        setVoiceInputContext({
          anchor: text.slice(0, 64),
          metadata: {
            inputSource: 'voice',
            transcriptionMode: 'cloud',
            transcriptChars: text.length,
            rawTranscriptChars: result?.rawText?.length,
            postProcessed: false,
          },
        });
        return;
      }

      const sendAfter = dictationSendAfterTranscriptRef.current;
      dictationSendAfterTranscriptRef.current = false;
      handleVoiceTranscriptRef.current(text, result);
      const transcript = text.trim();
      if (sendAfter && transcript) {
        const current = valueRef.current.trimEnd();
        const merged = current ? `${current}\n\n${transcript}` : transcript;
        void handleSubmitRef.current(undefined, { content: merged });
      }
    },
  });
  const handleDictationAwareValueChange = useCallback((newValue: string) => {
    if (dictationAnchorRef.current) {
      dictationAnchorRef.current = markDictationUserEdit(
        dictationAnchorRef.current,
        newValue,
      );
    }
    valueRef.current = newValue;
    handleValueChange(newValue);
  }, [handleValueChange]);
  const isDictationActive = voice.status === 'recording' || voice.status === 'transcribing';
  // 录音失败（如太短）不会触发 onTranscript——滞留的 send-after 旗标必须在
  // 出错时清掉，否则下一次成功转写会被意外自动发送。
  useEffect(() => {
    if (voice.status === 'error') {
      const anchor = dictationAnchorRef.current;
      if (anchor) {
        writeDictationValue(cancelDictationAnchor(anchor, valueRef.current));
        dictationAnchorRef.current = null;
      }
      dictationSendAfterTranscriptRef.current = false;
      return;
    }
    if (voice.status === 'idle' && dictationAnchorRef.current) {
      dictationAnchorRef.current = null;
      if (dictationSendAfterTranscriptRef.current) {
        dictationSendAfterTranscriptRef.current = false;
        const content = valueRef.current.trim();
        if (content) void handleSubmitRef.current(undefined, { content });
      }
    }
  }, [voice.status, writeDictationValue]);
  // 累计费用已收进 ContextUsagePill 的 hover 面板（底栏收敛拍板 2026-07-26）：
  // 圆环 hover 展开时与上下文用量同面板展示，底栏不再常驻成本数字。
  // useBudgetStatus 不是定时轮询：仅在成本前进 / 流式结束时各拉一次，挂在 pill 侧。

  const hasContent = value.trim().length > 0 || attachments.length > 0 || Boolean(pendingCommand);
  // 右侧主按钮的归属：只有「空输入框 + 没在跑 + 语音入口真能用」时才让给开通话，
  // 其余情况发送键都有事可做（发送 / 停止），不能被换掉。
  //
  // 不看 `configured`（2026-07-30 缺 key 降级）：没配 key 时主位照让，
  // LiveVoiceButton 自己渲染成「点我配 key」的引导态——能力不可用要降级提示，
  // 不是消失，否则新用户永远发现不了这儿有实时语音。
  //
  // 刻意不看 `disabled`（2026-07-27 真机：切到新会话时底栏按钮闪变）：
  // `disabled = isProcessing || isCreatingSession`，而 `!isProcessing` 上面已经拦了，
  // 它多出来的只有「正在建会话」那一小段。建会话跟「有没有通话入口」无关——
  // 拿它决定按钮存不存在，就是让底栏在每次开新会话时换一次构成。
  // 这段窗口按钮照常在位，只是 disabled 置灰（两个按钮都真的会灰，见各自实现）。
  //
  // X5.5 返工批 R4c：挂断后派出去的活还在跑（isProcessing）时，主位是停止键，
  // 通话入口退次位（见 resolveLiveVoiceSlot）——挂断即回到可拨状态，
  // 不再「按钮短暂消失、活跑完才回来」。
  const liveVoiceAvailability = useVoiceLiveAvailability();
  const liveVoiceCallPhase = useVoiceCallStore((state) => state.phase);
  const liveVoiceSlot = resolveLiveVoiceSlot({
    hasContent,
    isProcessing: Boolean(isProcessing),
    sessionId: currentSessionId ?? null,
    enabled: liveVoiceAvailability.enabled,
    phase: liveVoiceCallPhase,
  });

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
        {seedComposer && (
          <SeedComposerCard
            kind={seedComposer.kind}
            title={seedComposer.kind === 'team' ? t.seedComposer.teamTitle : t.seedComposer.roleTitle}
            placeholder={seedComposer.kind === 'team' ? t.seedComposer.teamPlaceholder : t.seedComposer.rolePlaceholder}
            initialText={seedComposer.initialText}
            submitting={submittingSeedComposer}
            onSubmit={async (text) => {
              setSubmittingSeedComposer(true);
              await submitSeedComposer(seedComposer.kind, text);
              setSubmittingSeedComposer(false);
              setSeedComposer(null);
            }}
            onDismiss={() => setSeedComposer(null)}
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
        <ComposerUploadStatus active={isUploading} />

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
        <TeamRecipeDraftNotifications />
        <SessionMemberBar sessionId={currentSessionId ?? null} />

        {/* Suggestion Bar - show when input is empty */}
        {value.trim().length === 0 && suggestions.length > 0 && (
          <SuggestionBar suggestions={suggestions} onSelect={handleSuggestionSelect} />
        )}

        <SurfaceExecutionComposerStatus conversationId={currentSessionId} />
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

        {/* 排队（引导）消息：输入框上方的独立卡片，不进输入框容器——进去会撑高输入区 */}
        <QueuedRuntimeInputCard
          items={queuedRuntimeInputs}
          isProcessing={Boolean(isProcessing)}
          onSend={onSendQueuedRuntimeInput}
          onCancel={async (id) => {
            // 取消 = 这条没发出去，内容退回输入框，别让人重打一遍（真机反馈）。
            const pending = queuedRuntimeInputs.find((item) => item.id === id);
            const retracted = await onCancelQueuedRuntimeInput?.(id);
            if (retracted && pending?.content) {
              setValue((current) => (current.trim() ? `${current} ${pending.content}` : pending.content));
            }
          }}
        />

        {/* 实时通话 chrome：live 时底栏扩展（打字/附件入口保留在下方原处，§7.2） */}
        <VoiceChrome sessionId={currentSessionId ?? null} />

        {/* composer 浮起（2026-07-28 品质感打磨）：L1 底 + 投影 + 聚焦描边微亮，
            与聊天内容拉开亮度层级，样式真源在 global.css .composer-elevated */}
        <div className="relative composer-elevated rounded-2xl">
          {/* 看某位成员时输入框整块封住：人只跟团长说话，不跟成员说话 */}
          {viewingMemberId && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-zinc-900/80 backdrop-blur-sm">
              <button /* ds-allow:button: 覆盖层里唯一的返回动作，需盖住整个输入区 */
                type="button"
                data-testid="member-return-main"
                onClick={() => setViewingMemberId(null)}
                className="rounded-full border border-zinc-600 bg-zinc-800 px-4 py-1.5 text-xs text-zinc-100 hover:border-zinc-400"
              >
                ↩ {t.expert.memberBar.returnToMain}
              </button>
            </div>
          )}
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
            <div className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-[240px] overflow-y-auto rounded-lg elevation-l2 popover-enter">
              <div className="border-b border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
                /agent
              </div>
              {/* 任务 15：query echo —— 输入过滤词可见，空 query 给搜索提示 */}
              <div className="border-b border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500">
                {agentCommandQuery?.trim()
                  ? t.mentionPanel.searchEcho.replace('{query}', agentCommandQuery).replace('{count}', String(agentCommandOptions.length))
                  : t.mentionPanel.emptyHintAgent}
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
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 shrink-0">
                      <RoleInitialAvatar roleId={option.id ?? 'default'} name={option.name} className="h-6 w-6 text-[11px]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{option.name}</span>
                        {option.profession ? (
                          <span className="shrink-0 truncate text-[10px] text-zinc-500">{option.profession}</span>
                        ) : null}
                        <span className="ml-auto rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
                          {option.token}
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">
                        {option.description}
                      </div>
                    </div>
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
            <div className="absolute bottom-full left-0 right-0 mb-1 elevation-l2 popover-enter rounded-lg z-20 max-h-[240px] overflow-y-auto">
              {agentMentionAutocomplete.matches.map((agent, index) => {
                const agentRole = (agent as { role?: string }).role;
                // Neo 合成候选（工作卡 / 续接 topic）自带 role：主文案直接用 name
                // （「Neo 工作卡」/「Neo · {标题}」），@token 降为次要信息，两行一眼可辨。
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
                      <span className="text-sm text-zinc-200 truncate">
                        {agentRole ? agent.name : `@${getPreferredAgentMentionToken(agent)}`}
                      </span>
                      <span className="text-xs text-zinc-500 truncate">
                        {agentRole ? `@${getPreferredAgentMentionToken(agent)}` : agent.name}
                      </span>
                      {agentRole ? (
                        <span className="ml-auto text-[11px] text-zinc-600 truncate">{agentRole}</span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {(!isAgentMentionAutocompleteOpen && atMention.isOpen) && (
            <AtMentionPopover
              query={atMention.query}
              libraryRows={atMention.libraryRows}
              fileRows={atMention.fileRows}
              selectedIndex={atMention.selectedIndex}
              onSelect={atMention.selectRow}
              onHover={atMention.setSelectedIndex}
            />
          )}
          {/* @neo 交互已从 composer 移除（2026-07-29 拍板）：工作卡/续接改从 Neo 协同页发起 */}
          <InputArea
            ref={inputAreaRef}
            value={value}
            onChange={handleDictationAwareValueChange}
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
            onAutocompleteKeyDown={handleComposerAutocompleteKeyDown}
            chips={(
              <ComposerChipsRow
                pendingAppshot={pendingAppshot}
                clearAppshot={clearAppshot}
                appshotSlotRef={appshotSlotRef}
              />
            )}
            inlineChips={inlineChips}
            onRemoveInlineChip={handleRemoveInlineChip}
            onInlineChipsChanged={handleInlineChipsChanged}
          />
          {/* 底部工具栏。录音中这一行**原地变成波形条**（`+` 留在最左，波形铺中间，
              右侧 时长 + 停止 + 发送）——不在输入框上方另悬浮一条，也就不会出现
              两个发送键（产品负责人 2026-07-27 真机反馈，形态对齐 Codex composer）。
              输入框本体全程可见可编辑。 */}
          <div className="flex items-center gap-1 px-4 pb-3">
            {/* "+" 二级菜单（Codex 风格 B+）— 收纳上传附件 + 能力入口 + 交互模式 */}
            <InputAddMenu
              onFileSelect={handleFileSelect}
              onSelectCapability={selectWorkbenchCapabilityForCurrentTurn}
            />

            {isDictationActive ? (
              <DictationRecordingBar
                status={voice.status}
                duration={voice.duration}
                inputLevel={voice.inputLevel}
                silenceWarning={voice.silenceWarning}
                onStop={voice.stop}
                onSend={() => {
                  dictationSendAfterTranscriptRef.current = true;
                  voice.stop();
                }}
              />
            ) : (
            <>
            {/* 专家有专门位置：底栏最左（头像+花名）。它不跟着单轮 chip 走，
                是这场对话「在跟谁协作」的常驻身份。 */}
            <AgentChip onOpenAgentCommand={openAgentCommand} />

            {/* 当前会话挂载的连接器 / MCP 小图标（无挂载不渲染），点击即取消挂载 */}
            <MountedConnectorIcons />

            {/* 运行权限模式 chip（高频，保留独立位置） */}
            <PermissionToggle disabled={disabled && !isProcessing} />

            {/* B+ 移除: AbilityMenu (Routing/Browser/Live Preview) — 挪到 Settings；
                Live Preview 后续挪到 SessionWorkspaceBar 顶栏 */}

            {/* 弹性空白 */}
            <div className="flex-1" />

            {/* 累计费用：底栏不再常驻，收进 ContextUsagePill hover 面板（2026-07-26 底栏收敛） */}

            {/* B+ 移除: InteractionModeIndicator — 已收进 InputAddMenu 二级菜单 */}

            {/* 上下文使用 pill — 模型选择器左边，Codex 风格 */}
            <ContextUsagePill />

            {/* 模型选择器（已合并 Agent Engine 选择到下拉框顶部 chip 行） */}
            <div className="text-xs">
              <ModelSwitcher currentModel={modelConfig.model} />
            </div>

            {/* 口述输入按钮：常驻不卸载。禁用时置灰留在原位——卸载会让底栏少一格、
                旁边所有东西横向平移，「切会话时按钮闪一下」就是这么来的。 */}
            <VoiceInputButton
              voice={voice}
              disabled={disabled}
            />
            {/*
              右侧主按钮一个位置两种职能（2026-07-27 产品负责人拍板）：
              输入框空着时是「开通话」，打了字才变「发送」——空输入框上摆一个
              点了也没用的发送键，是这三个图标里最没用的那个。
              正在跑 / 有内容 / 语音入口不可用时回退成发送键（那些状态下它有事可做）。
              R4c 次位：正在跑（停止键占主位）时通话入口退到停止键左边的 ghost 次位，
              挂在原地照常可拨——挂断后按钮立刻在，不随活跑完才回来。
            */}
            {liveVoiceSlot === 'secondary' && (
              <LiveVoiceButton
                sessionId={currentSessionId ?? null}
                hasMessages={hasMessages}
                disabled={disabled && !isProcessing}
                variant="ghost"
                availability={{
                  enabled: liveVoiceAvailability.enabled,
                  configured: liveVoiceAvailability.configured,
                }}
              />
            )}
            {liveVoiceSlot === 'primary' ? (
              <LiveVoiceButton
                sessionId={currentSessionId ?? null}
                hasMessages={hasMessages}
                disabled={disabled}
                variant="primary"
                availability={{
                  enabled: liveVoiceAvailability.enabled,
                  configured: liveVoiceAvailability.configured,
                }}
              />
            ) : (
              <SendButton
                disabled={disabled && !isProcessing}
                isProcessing={isProcessing}
                isInterrupting={isInterrupting}
                hasContent={hasContent}
                type="submit"
                onStop={onStop}
              />
            )}
            </>
            )}
          </div>
        </div>
      </form>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';

export default ChatInput;
