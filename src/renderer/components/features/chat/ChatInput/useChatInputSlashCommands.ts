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
import { type SkillRecommendationView } from './CapabilitySuggestionStrip';
import type { SlashCommand } from './SlashCommandPopover';
import {
  buildInlineSkillTokenValue,
  buildLeadingSlashCommandValue,
  removeTrailingSlashToken,
} from './slashPickerModel';

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
  setValue: React.Dispatch<React.SetStateAction<string>>;
  setShowSlashPopover: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashFilter: React.Dispatch<React.SetStateAction<string>>;
  setPendingPromptCommand: React.Dispatch<React.SetStateAction<ComposerPromptCommandSelection | null>>;
  setPendingAgentSelection: React.Dispatch<React.SetStateAction<ComposerAgentSelection | null>>;
  setActiveAgentId: (id: string | null) => void;
}

/**
 * ChatInput 的斜杠命令 / 能力选择单元：slash popover 选择分发
 * （handleSlashCommandSelect）+ skill / connector / mcp 当轮挂载选择。
 * 纯结构性抽取自 index.tsx，零行为改动。C3 专用的 store action 在 hook 内订阅，
 * 共享项（setActiveAgentId / 各 composer 卡片开关等）经 params 注入。
 */
export function useChatInputSlashCommands(params: UseChatInputSlashCommandsParams) {
  const {
    value,
    currentSessionId,
    skillRecommendations,
    mountRecommendedSkill,
    installRecommendedSkill,
    capabilityItems,
    openAgentCommand,
    focusComposer,
    setValue,
    setShowSlashPopover,
    setSlashFilter,
    setPendingPromptCommand,
    setPendingAgentSelection,
    setActiveAgentId,
  } = params;

  const setSelectedSkillIds = useComposerStore((state) => state.setSelectedSkillIds);
  const setSelectedConnectorIds = useComposerStore((state) => state.setSelectedConnectorIds);
  const setSelectedMcpServerIds = useComposerStore((state) => state.setSelectedMcpServerIds);
  const setTurnCapabilityScopeMode = useComposerStore((state) => state.setTurnCapabilityScopeMode);
  const openCapabilitySettingsTarget = useAppStore((state) => state.openCapabilitySettingsTarget);
  const mountSkill = useSkillStore((state) => state.mountSkill);
  const setSkillCurrentSession = useSkillStore((state) => state.setCurrentSession);
  const createSession = useSessionStore((state) => state.createSession);

  const markSkillSelected = useCallback((skillName: string) => {
    const currentSelectedSkillIds = useComposerStore.getState().selectedSkillIds;
    setSelectedSkillIds([...new Set([...currentSelectedSkillIds, skillName])]);
    setValue((prev) => buildInlineSkillTokenValue(prev, skillName));
    focusComposer();
  }, [focusComposer, setSelectedSkillIds, setValue]);

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
    setValue,
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
    openAgentCommand,
    selectSkillForCurrentTurn,
    selectWorkbenchCapabilityForCurrentTurn,
    setActiveAgentId,
    setPendingAgentSelection,
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
