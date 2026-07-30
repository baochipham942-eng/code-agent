import { useCallback } from 'react';
import type React from 'react';
import type {
  ComposerAgentSelection,
  ComposerPromptCommandSelection,
} from '@shared/contract/conversationEnvelope';
import { toast } from '../../../../hooks/useToast';
import { useAppStore } from '../../../../stores/appStore';
import { useComposerStore } from '../../../../stores/composerStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useSkillStore } from '../../../../stores/skillStore';
import { startCreateRoleChat } from '../../../../utils/startCreateRoleChat';
import type { WorkbenchCapabilityRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';
import { useI18n } from '../../../../hooks/useI18n';
import type { SeedComposerKind } from './SeedComposerCard';
import { type SkillRecommendationView } from './CapabilitySuggestionStrip';
import type { SlashCommand } from './SlashCommandPopover';
import {
  buildLeadingSlashCommandValue,
  removeTrailingSlashToken,
} from './slashPickerModel';
import type { InlineChipRef } from './composerRichTextModel';

export interface UseChatInputSlashCommandsParams {
  value: string;
  currentSessionId: string | null;
  /** Agent-side or explicit recommendations. Composer typing passes an empty list. */
  skillRecommendations: SkillRecommendationView[];
  mountRecommendedSkill: (recommendation: SkillRecommendationView, sessionId: string) => Promise<boolean>;
  installRecommendedSkill: (recommendation: SkillRecommendationView, sessionId: string) => Promise<boolean>;
  /** 工作台能力注册表条目（connector / mcp / skill）。 */
  capabilityItems: WorkbenchCapabilityRegistryItem[];
  /** 打开 /agent 命令（来自 useChatInputAgentCommand）。 */
  openAgentCommand: () => void;
  focusComposer: () => void;
  /** 触发词原位替换为内联 chip（无触发词时 no-op，由编辑器对账把 chip 补到末尾）。 */
  insertInlineChip: (chip: InlineChipRef) => void;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  setShowSlashPopover: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashFilter: React.Dispatch<React.SetStateAction<string>>;
  setPendingPromptCommand: React.Dispatch<React.SetStateAction<ComposerPromptCommandSelection | null>>;
  setPendingAgentSelection: React.Dispatch<React.SetStateAction<ComposerAgentSelection | null>>;
  setActiveAgentId: (id: string | null) => void;
  /** 打开「建团队 / 建角色」就地确认卡（这两个 skill 是对话流程，不是本轮能力）。 */
  openSeedComposer: (kind: SeedComposerKind) => void;
}

/**
 * ChatInput 的斜杠命令 / 能力选择单元：slash popover 选择分发
 * （handleSlashCommandSelect）+ skill / connector / mcp 当轮挂载选择。
 * 纯结构性抽取自 index.tsx，零行为改动。C3 专用的 store action 在 hook 内订阅，
 * 共享项（setActiveAgentId / 各 composer 卡片开关等）经 params 注入。
 */
export function useChatInputSlashCommands(params: UseChatInputSlashCommandsParams) {
  const { t } = useI18n();
  const {
    value,
    currentSessionId,
    skillRecommendations,
    mountRecommendedSkill,
    installRecommendedSkill,
    capabilityItems,
    openAgentCommand,
    focusComposer,
    insertInlineChip,
    setValue,
    setShowSlashPopover,
    setSlashFilter,
    setPendingPromptCommand,
    setPendingAgentSelection,
    setActiveAgentId,
    openSeedComposer,
  } = params;

  const setSelectedSkillIds = useComposerStore((state) => state.setSelectedSkillIds);
  const setSelectedConnectorIds = useComposerStore((state) => state.setSelectedConnectorIds);
  const setSelectedMcpServerIds = useComposerStore((state) => state.setSelectedMcpServerIds);
  const setTurnCapabilityScopeMode = useComposerStore((state) => state.setTurnCapabilityScopeMode);
  const setPendingCommand = useComposerStore((state) => state.setPendingCommand);
  const openCapabilitySettingsTarget = useAppStore((state) => state.openCapabilitySettingsTarget);
  const mountSkill = useSkillStore((state) => state.mountSkill);
  const setSkillCurrentSession = useSkillStore((state) => state.setCurrentSession);
  const createSession = useSessionStore((state) => state.createSession);

  const markSkillSelected = useCallback((skillName: string) => {
    const currentSelectedSkillIds = useComposerStore.getState().selectedSkillIds;
    // 触发词原位变 skill chip（内联进文字流）；store 更新后编辑器对账渲染
    insertInlineChip({ key: `skill:${skillName}`, kind: 'skill', id: skillName });
    setSelectedSkillIds([...new Set([...currentSelectedSkillIds, skillName])]);
    focusComposer();
  }, [focusComposer, insertInlineChip, setSelectedSkillIds]);

  const ensureSessionForSkill = useCallback(async (): Promise<string | null> => {
    if (currentSessionId) return currentSessionId;
    const session = await createSession(t.sidebar.newSessionTitle);
    return session?.id ?? null;
  }, [createSession, currentSessionId, t]);

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
        toast.error(t.slashSelect.mountSkillNoSession);
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
        toast.error(t.slashSelect.mountSkillFailedPrefix + input.skillName);
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
    t,
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
        toast.warning(capability.blockedReason?.detail || t.slashSelect.connectFirstPrefix + capability.label);
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
      toast.warning(capability.blockedReason?.detail || t.slashSelect.connectMcpFirstPrefix + capability.label);
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
    setValue,
    t,
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
      // 面板已无 Default 项（2026-07-29 起）；恢复默认路由 = 删掉底栏专家 chip
      if (!cmd.agentId) return;
      setActiveAgentId(cmd.agentId);
      setPendingAgentSelection({
        id: cmd.agentId,
        name: cmd.label,
        token: cmd.agentToken,
        via: 'slash_picker',
      });
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

    if (cmd.actionKind === 'prefill-leading-command' && cmd.commandId) {
      // 任务 17：带参特色命令（/goal /schedule /loop /workflow）chip 化——
      // 触发词原位变命令 chip（内联进文字流），命令挂 composerStore.pendingCommand，
      // 用户随后输入的就是参数；发送时 useChatInputSubmit 拼回 `/${id} ` 走原解析链路。
      insertInlineChip({ key: `command:${cmd.commandId}`, kind: 'command', id: cmd.commandId });
      setPendingCommand({ id: cmd.commandId, name: cmd.label });
      focusComposer();
      return;
    }

    // create-team / create-role 也是内置 skill，因此会出现在技能候选里。但它们是**对话流程**，
    // 不是"本轮挂个能力"：按技能选中只会加一枚芯片、把输入框清空，用户永远碰不到确认卡
    // （2026-07-23 客户端 dogfood 实测）。这里改成直接开卡，和命令候选、手打裸指令三条路一致。
    if (cmd.actionKind === 'select-skill' && (cmd.skillName === 'create-team' || cmd.skillName === 'create-role')) {
      setValue('');
      openSeedComposer(cmd.skillName === 'create-team' ? 'team' : 'role');
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
      const capability = capabilityItems.find((item) => item.kind === 'connector' && item.id === cmd.connectorId);
      if (capability) selectWorkbenchCapabilityForCurrentTurn(capability);
      return;
    }

    if (cmd.actionKind === 'select-mcp' && cmd.mcpServerId) {
      const capability = capabilityItems.find((item) => item.kind === 'mcp' && item.id === cmd.mcpServerId);
      if (capability) selectWorkbenchCapabilityForCurrentTurn(capability);
      return;
    }

    setValue(removeTrailingSlashToken(value));
    cmd.action();
    focusComposer();
  }, [
    capabilityItems,
    focusComposer,
    insertInlineChip,
    openAgentCommand,
    openSeedComposer,
    selectSkillForCurrentTurn,
    selectWorkbenchCapabilityForCurrentTurn,
    setActiveAgentId,
    setPendingAgentSelection,
    setPendingCommand,
    setPendingPromptCommand,
    setShowSlashPopover,
    setSlashFilter,
    setValue,
    skillRecommendations,
    value,
  ]);

  return {
    selectSkillForCurrentTurn,
    selectWorkbenchCapabilityForCurrentTurn,
    handleSlashCommandSelect,
  };
}
