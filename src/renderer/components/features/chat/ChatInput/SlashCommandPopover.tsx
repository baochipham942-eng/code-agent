// ============================================================================
// SlashCommandPopover - Inline command suggestions when typing "/"
// Replaces full-screen CommandPalette for "/" trigger in ChatInput
// ============================================================================

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Plus, Trash2, Archive, FileText, FolderOpen,
  BarChart2, Settings, Keyboard, HelpCircle,
  Terminal, Cpu, Plug, Zap, ClipboardList,
  MessageCircleQuestion, ZapOff, Flame,
  Lock, LockOpen, Bot, Sparkles, Server, Target, GitBranch, UserPlus, Clock3, Repeat,
} from 'lucide-react';
import { buildCostText, buildStatusText, fmtTokens } from './chatDiagnostics';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useSkillStore } from '../../../../stores/skillStore';
import { useComposerStore } from '../../../../stores/composerStore';
import { useModeStore } from '../../../../stores/modeStore';
import { useStatusStore } from '../../../../stores/statusStore';
import { initializeCommands, getCommandRegistry } from '@shared/commands';
import type { CommandDefinition } from '@shared/commands';
import { generateMessageId } from '@shared/utils/id';
import { IPC_CHANNELS, IPC_DOMAINS, COMMAND_CHANNELS } from '@shared/ipc';
import {
  formatShortcutForDisplay,
  getKeybindingAccelerator,
  type KeybindingActionId,
} from '@shared/keybindings';
import type { ExtensionValidationResult } from '@shared/contract/extension';
import type { AgentListEntry } from '@shared/contract/agentRegistry';
import { AGENT_NEO_HELP_URL } from '@shared/constants/network';
import { invoke, invokeDomain, unsafeInvoke } from '../../../../services/ipcService';
import type { WorkbenchCapabilityRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';
import type { SkillRecommendationView } from './CapabilitySuggestionStrip';
import {
  createAgentCandidates,
  createCommandCandidate,
  createPromptCandidate,
  createSkillCandidates,
  createWorkbenchCapabilityCandidates,
  filterAndRankSlashCandidates,
  groupSlashCandidates,
  type PromptCommandCandidateInput,
  type SlashCandidateAction,
  type SlashPickerCandidate,
  type SlashPickerLabels,
} from './slashPickerModel';
import { useKeybindingsSettings } from '../../../../hooks/useKeybindingsSettings';
import { useI18n } from '../../../../hooks/useI18n';
import { RoleInitialAvatar } from '../../expert/RoleInitialAvatar';

type ExtensionMutationResult = { success: boolean; error?: string };

function ensureExtensionMutation(result: ExtensionMutationResult | undefined): void {
  if (!result?.success) {
    throw new Error(result?.error || 'Extension operation failed');
  }
}

// 把诊断命令的文本输出写进聊天流（assistant 消息）。运行时取 store，不增加 useMemo 依赖。
// 用代码块包裹：诊断输出是等宽对齐文本，且含 $ 金额（会被 markdown 当 LaTeX 渲染）、
// 路径等特殊字符——代码块既保证等宽对齐，又屏蔽 markdown/KaTeX 干扰。
function writeAssistant(content: string): void {
  useSessionStore.getState().addMessage({
    id: generateMessageId(),
    role: 'assistant',
    content: '```\n' + content + '\n```',
    timestamp: Date.now(),
  });
}

export type SlashCommand = SlashPickerCandidate & {
  icon: React.ReactNode;
  action: () => void;
  sourceLabel?: string;
};

interface SlashCommandSeed {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  sourceLabel?: string;
  shortcut?: string;
  actionKind?: SlashCandidateAction;
  emptyQueryVisible?: boolean;
  emptyQueryRank?: number;
  effectLabel?: string;
  action: () => void;
}

function makeCommand(seed: SlashCommandSeed, labels?: SlashPickerLabels): SlashCommand {
  return {
    ...createCommandCandidate(seed, labels),
    icon: seed.icon,
    action: seed.action,
    ...(seed.sourceLabel ? { sourceLabel: seed.sourceLabel } : {}),
  };
}

function getPromptCommandSourceLabel(command: PromptCommandCandidateInput): string {
  if (command.source === 'mcp') {
    return command.serverName ? `MCP · ${command.serverName}` : 'MCP prompt';
  }
  if (command.source === 'builtin') {
    return 'Builtin command';
  }
  if (command.scope === 'project') {
    return 'Project command';
  }
  if (command.scope === 'user') {
    return 'User command';
  }
  return 'File command';
}

interface SlashCommandPopoverProps {
  isOpen: boolean;
  filter: string;
  agents: AgentListEntry[];
  skillRecommendations: SkillRecommendationView[];
  capabilityItems: WorkbenchCapabilityRegistryItem[];
  capabilitySuggestions: WorkbenchCapabilityRegistryItem[];
  onClose: () => void;
  onSelect: (command: SlashCommand) => void;
}

export const SlashCommandPopover: React.FC<SlashCommandPopoverProps> = ({
  isOpen,
  filter,
  agents,
  skillRecommendations,
  capabilityItems,
  capabilitySuggestions,
  onClose,
  onSelect,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const { keybindings, platform } = useKeybindingsSettings();
  const getShortcutLabel = useMemo(() => (actionId: KeybindingActionId): string | undefined => {
    const accelerator = getKeybindingAccelerator(keybindings, actionId, platform);
    return accelerator ? formatShortcutForDisplay(accelerator, platform) : undefined;
  }, [keybindings, platform]);

  // Prompt commands（/命令协议层，roadmap 2.2）：文件式自定义 + MCP prompts，
  // 由 main 侧注册表提供；选中后父级预填 "/name "，发送时 main 展开模板
  const [promptCommands, setPromptCommands] = useState<PromptCommandCandidateInput[]>([]);
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // command:* 通道未进 IpcInvokeHandlers 联合类型，走具名逃生入口（同 skillStore 的处理）
    void Promise.resolve(unsafeInvoke(COMMAND_CHANNELS.PROMPT_LIST, {}))
      .then((commands: unknown) => {
        if (!cancelled && Array.isArray(commands)) {
          setPromptCommands(commands as PromptCommandCandidateInput[]);
        }
      })
      .catch(() => {
        /* 列表获取失败时静默：popover 仍展示内置命令 */
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const {
    setShowSettings,
    openSettingsTab,
    setShowDAGPanel,
    showDAGPanel,
    setShowWorkspace,
    showWorkspace,
    setSidebarCollapsed,
    sidebarCollapsed,
  } = useAppStore();

  const {
    createSession,
    clearCurrentSession,
    archiveSession,
    currentSessionId,
  } = useSessionStore();

  const setInteractionMode = useModeStore((s) => s.setInteractionMode);
  const setEffortLevel = useModeStore((s) => s.setEffortLevel);
  // 会话权限档：真源在 host PermissionModeManager，通过 domain:agent 读写（无本地档位 state）
  const setSessionPermissionTier = (mode: 'default' | 'bypassPermissions') => {
    invokeDomain(IPC_DOMAINS.AGENT, 'setSessionPermissionMode', {
      sessionId: useSessionStore.getState().currentSessionId,
      mode,
      approved: mode === 'bypassPermissions',
    }).catch(() => { /* agent 未初始化时忽略 */ });
  };
  const availableSkills = useSkillStore((s) => s.availableSkills);
  const mountedSkills = useSkillStore((s) => s.mountedSkills);
  const fetchAvailableSkills = useSkillStore((s) => s.fetchAvailableSkills);
  const fetchMountedSkills = useSkillStore((s) => s.fetchMountedSkills);
  const setSkillCurrentSession = useSkillStore((s) => s.setCurrentSession);
  const selectedSkillIds = useComposerStore((s) => s.selectedSkillIds);

  useEffect(() => {
    if (!isOpen) return;
    void fetchAvailableSkills();
    if (currentSessionId) {
      setSkillCurrentSession(currentSessionId);
      void fetchMountedSkills();
    }
  }, [currentSessionId, fetchAvailableSkills, fetchMountedSkills, isOpen, setSkillCurrentSession]);
  // Icon mapping for registry commands
  const registryIconMap: Record<string, React.ReactNode> = useMemo(() => ({
    clear: <Trash2 className="w-4 h-4" />,
    help: <HelpCircle className="w-4 h-4" />,
    config: <Settings className="w-4 h-4" />,
    model: <Cpu className="w-4 h-4" />,
    cost: <BarChart2 className="w-4 h-4" />,
    compact: <Zap className="w-4 h-4" />,
    agents: <Terminal className="w-4 h-4" />,
    status: <BarChart2 className="w-4 h-4" />,
    plugins: <Plug className="w-4 h-4" />,
    skills: <Sparkles className="w-4 h-4" />,
    mcp: <Server className="w-4 h-4" />,
    connectors: <Plug className="w-4 h-4" />,
  }), []);

  const extensionOps = useMemo(() => ({
    list: async () => invoke(IPC_CHANNELS.EXTENSION_LIST),
    install: async (spec: string) => {
      ensureExtensionMutation(await invoke(IPC_CHANNELS.EXTENSION_INSTALL, spec));
    },
    uninstall: async (id: string) => {
      ensureExtensionMutation(await invoke(IPC_CHANNELS.EXTENSION_UNINSTALL, id));
    },
    enable: async (id: string) => {
      ensureExtensionMutation(await invoke(IPC_CHANNELS.EXTENSION_ENABLE, id));
    },
    disable: async (id: string) => {
      ensureExtensionMutation(await invoke(IPC_CHANNELS.EXTENSION_DISABLE, id));
    },
    reload: async (id?: string) => {
      ensureExtensionMutation(await invoke(IPC_CHANNELS.EXTENSION_RELOAD, id));
    },
    validate: async (id: string): Promise<ExtensionValidationResult> => (
      invoke(IPC_CHANNELS.EXTENSION_VALIDATE, id)
    ),
  }), []);

  const skillOps = useMemo(() => ({
    listAvailable: async () => {
      const store = useSkillStore.getState();
      if (store.availableSkills.length === 0) {
        await store.fetchAvailableSkills();
      }
      return useSkillStore.getState().availableSkills;
    },
    listMounted: async () => {
      if (currentSessionId) {
        useSkillStore.getState().setCurrentSession(currentSessionId);
        await useSkillStore.getState().fetchMountedSkills({ force: true });
      }
      return useSkillStore.getState().mountedSkills;
    },
    listSelected: () => useComposerStore.getState().selectedSkillIds,
  }), [currentSessionId]);

  const mcpOps = useMemo(() => ({
    getStatus: async () => invokeDomain(IPC_DOMAINS.MCP, 'getStatus'),
    listServerStates: async () => invokeDomain(IPC_DOMAINS.MCP, 'getServerStates'),
    listTools: async () => invokeDomain(IPC_DOMAINS.MCP, 'listTools'),
  }), []);

  const connectorOps = useMemo(() => ({
    listStatuses: async () => invokeDomain(IPC_DOMAINS.CONNECTOR, 'listStatuses'),
    listSelected: () => useComposerStore.getState().selectedConnectorIds,
  }), []);

  // GUI-only commands (operate on store/UI directly, not in registry)
  const sc = t.slashCommands;
  const guiOnlyCommands: SlashCommand[] = useMemo(() => ([
    {
      id: 'new',
      label: sc.new.label,
      description: sc.new.description,
      icon: <Plus className="w-4 h-4" />,
      shortcut: getShortcutLabel('session.new'),
      emptyQueryVisible: true,
      emptyQueryRank: 10,
      action: () => createSession(),
    },
    {
      id: 'clear',
      label: sc.clear.label,
      description: sc.clear.description,
      icon: <Trash2 className="w-4 h-4" />,
      shortcut: getShortcutLabel('session.clear'),
      action: () => clearCurrentSession(),
    },
    {
      id: 'help',
      label: sc.help.label,
      description: sc.help.description,
      icon: <HelpCircle className="w-4 h-4" />,
      action: () => window.open(AGENT_NEO_HELP_URL, '_blank'),
    },
    {
      id: 'archive',
      label: sc.archive.label,
      description: sc.archive.description,
      icon: <Archive className="w-4 h-4" />,
      action: async () => {
        if (currentSessionId) await archiveSession(currentSessionId);
      },
    },
    {
      id: 'sidebar',
      label: sidebarCollapsed ? sc.sidebar.labelShow : sc.sidebar.labelHide,
      description: sc.sidebar.description,
      icon: <FileText className="w-4 h-4" />,
      shortcut: getShortcutLabel('sidebar.toggle'),
      action: () => setSidebarCollapsed(!sidebarCollapsed),
    },
    {
      id: 'dag',
      label: showDAGPanel ? sc.dag.labelHide : sc.dag.labelShow,
      description: sc.dag.description,
      icon: <BarChart2 className="w-4 h-4" />,
      action: () => setShowDAGPanel(!showDAGPanel),
    },
    {
      id: 'workspace',
      label: showWorkspace ? sc.workspace.labelHide : sc.workspace.labelShow,
      description: sc.workspace.description,
      icon: <FolderOpen className="w-4 h-4" />,
      action: () => setShowWorkspace(!showWorkspace),
    },
    {
      id: 'settings',
      label: sc.settings.label,
      description: sc.settings.description,
      icon: <Settings className="w-4 h-4" />,
      shortcut: getShortcutLabel('settings.open'),
      action: () => setShowSettings(true),
    },
    {
      id: 'shortcuts',
      label: sc.shortcuts.label,
      description: sc.shortcuts.description,
      icon: <Keyboard className="w-4 h-4" />,
      action: () => openSettingsTab('keybindings'),
    },
    // --- 模式 / 强度 / 权限命令 ---
    {
      id: 'agent',
      label: sc.agent.label,
      description: sc.agent.description,
      icon: <Bot className="w-4 h-4" />,
      actionKind: 'open-agent-command',
      emptyQueryVisible: true,
      emptyQueryRank: 20,
      effectLabel: sc.agent.effectLabel,
      action: () => {},
    },
    {
      id: 'create-role',
      label: sc['create-role'].label,
      description: sc['create-role'].description,
      icon: <UserPlus className="w-4 h-4" />,
      actionKind: 'create-role',
      emptyQueryVisible: true,
      emptyQueryRank: 25,
      effectLabel: sc['create-role'].effectLabel,
      action: () => {},
    },
    {
      id: 'goal',
      label: sc.goal.label,
      description: sc.goal.description,
      icon: <Target className="w-4 h-4" />,
      actionKind: 'prefill-leading-command',
      commandId: 'goal',
      emptyQueryVisible: true,
      emptyQueryRank: 30,
      action: () => {},
    },
    {
      id: 'schedule',
      label: sc.schedule.label,
      description: sc.schedule.description,
      icon: <Clock3 className="w-4 h-4" />,
      actionKind: 'prefill-leading-command',
      commandId: 'schedule',
      emptyQueryVisible: true,
      emptyQueryRank: 35,
      action: () => {},
    },
    {
      id: 'loop',
      label: sc.loop.label,
      description: sc.loop.description,
      commandId: 'loop',
      icon: <Repeat className="w-4 h-4" />,
      actionKind: 'prefill-leading-command',
      emptyQueryVisible: true,
      emptyQueryRank: 40,
      action: () => {},
    },
    {
      id: 'workflow',
      label: sc.workflow.label,
      description: sc.workflow.description,
      icon: <GitBranch className="w-4 h-4" />,
      actionKind: 'prefill-leading-command',
      emptyQueryVisible: true,
      emptyQueryRank: 45,
      action: () => {},
    },
    {
      id: 'code',
      label: sc.code.label,
      description: sc.code.description,
      icon: <Terminal className="w-4 h-4" />,
      action: () => setInteractionMode('code'),
    },
    {
      id: 'plan',
      label: sc.plan.label,
      description: sc.plan.description,
      icon: <ClipboardList className="w-4 h-4" />,
      action: () => setInteractionMode('plan'),
    },
    {
      id: 'ask',
      label: sc.ask.label,
      description: sc.ask.description,
      icon: <MessageCircleQuestion className="w-4 h-4" />,
      action: () => setInteractionMode('ask'),
    },
    {
      id: 'low',
      label: sc.low.label,
      description: sc.low.description,
      icon: <ZapOff className="w-4 h-4" />,
      action: () => setEffortLevel('low'),
    },
    {
      id: 'med',
      label: sc.med.label,
      description: sc.med.description,
      icon: <Zap className="w-4 h-4" />,
      action: () => setEffortLevel('medium'),
    },
    {
      id: 'high',
      label: sc.high.label,
      description: sc.high.description,
      icon: <Flame className="w-4 h-4" />,
      action: () => setEffortLevel('high'),
    },
    {
      id: 'default',
      label: sc.default.label,
      description: sc.default.description,
      icon: <Lock className="w-4 h-4" />,
      action: () => setSessionPermissionTier('default'),
    },
    {
      id: 'fullaccess',
      label: sc.fullaccess.label,
      description: sc.fullaccess.description,
      icon: <LockOpen className="w-4 h-4" />,
      action: () => setSessionPermissionTier('bypassPermissions'),
    },
    // --- 诊断命令（GUI 实现）---
    // 这些命令的 CLI handler 依赖 main 进程模块/agent 实例，在 renderer 跑会报错或吐兜底。
    // 这里用 renderer store + 现成 IPC + diagnostics domain 取真实数据重新实现。
    {
      id: 'context',
      label: sc.context.label,
      description: sc.context.description,
      icon: <BarChart2 className="w-4 h-4" />,
      action: async () => {
        const health = useAppStore.getState().contextHealth;
        if (!health || health.currentTokens === 0) {
          writeAssistant('Context data not yet available (send a message first)');
          return;
        }
        const pct = (n: number) => health.currentTokens > 0 ? ((n / health.currentTokens) * 100).toFixed(1) : '0';
        const lines = [
          'Context',
          `  Usage:    ${health.currentTokens.toLocaleString('en-US')} / ${health.maxTokens.toLocaleString('en-US')} tokens (${health.usagePercent.toFixed(1)}%)`,
          `  System:   ${health.breakdown.systemPrompt.toLocaleString('en-US')} tokens (${pct(health.breakdown.systemPrompt)}%)`,
          `  Messages: ${health.breakdown.messages.toLocaleString('en-US')} tokens (${pct(health.breakdown.messages)}%)`,
          `  Tools:    ${health.breakdown.toolResults.toLocaleString('en-US')} tokens (${pct(health.breakdown.toolResults)}%)`,
          `  Turns:    ~${health.estimatedTurnsRemaining} remaining`,
        ];
        try {
          const c = await invokeDomain<{ compressionCount: number; totalSavedTokens: number }>(IPC_DOMAINS.DIAGNOSTICS, 'compression');
          if (c.compressionCount > 0) {
            lines.push(`  Compressed: ${c.compressionCount} times, saved ${c.totalSavedTokens.toLocaleString('en-US')} tokens`);
          }
        } catch { /* compression stats optional */ }
        writeAssistant(lines.join('\n'));
      },
    },
    {
      id: 'status',
      label: sc.status.label,
      description: sc.status.description,
      icon: <BarChart2 className="w-4 h-4" />,
      action: async () => {
        writeAssistant(await buildStatusText());
      },
    },
    {
      id: 'cost',
      label: sc.cost.label,
      description: sc.cost.description,
      icon: <BarChart2 className="w-4 h-4" />,
      action: async () => {
        writeAssistant(await buildCostText());
      },
    },
    {
      id: 'agents',
      label: sc.agents.label,
      description: sc.agents.description,
      icon: <Terminal className="w-4 h-4" />,
      action: async () => {
        const lines: string[] = [t.slashDiagnostics.agentsRecentHeader];
        try {
          const history = await invoke(IPC_CHANNELS.SWARM_GET_AGENT_HISTORY, { limit: 10 });
          if (!history || history.length === 0) {
            lines.push(t.slashDiagnostics.agentsNoHistory);
          } else {
            for (const run of history) {
              const icon = run.status === 'completed' ? '✓' : run.status === 'failed' ? '✗' : '○';
              const duration = run.durationMs < 1000 ? `${run.durationMs}ms` : `${(run.durationMs / 1000).toFixed(1)}s`;
              const tokens = run.tokenUsage.input + run.tokenUsage.output;
              const tokenStr = tokens > 0 ? `  ${fmtTokens(tokens)} tok` : '';
              lines.push(`  ${icon} ${run.name} (${run.role})  ${run.status}  ${duration}${tokenStr}`);
            }
          }
        } catch (err) {
          lines.push(`${t.slashDiagnostics.agentsFetchFailedPrefix}${err instanceof Error ? err.message : String(err)}${t.slashDiagnostics.agentsFetchFailedSuffix}`);
        }
        lines.push('', t.slashDiagnostics.agentsFooterLine);
        writeAssistant(lines.join('\n'));
      },
    },
    {
      id: 'hooks',
      label: sc.hooks.label,
      description: sc.hooks.description,
      icon: <Zap className="w-4 h-4" />,
      action: async () => {
        try {
          const summary = await invokeDomain<{
            enabled: Array<{ event: string; sources: string[] }>;
            unused: Array<{ event: string }>;
          }>(IPC_DOMAINS.HOOK, 'list');
          const lines: string[] = ['Hook Configurations:'];
          if (!summary.enabled || summary.enabled.length === 0) {
            lines.push('  (no hooks configured)');
          } else {
            for (const item of summary.enabled) {
              lines.push(`  ${item.event}: ${item.sources.join(', ')}`);
            }
          }
          writeAssistant(lines.join('\n'));
        } catch (err) {
          writeAssistant(`${t.slashDiagnostics.hooksFailedPrefix}${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      id: 'permissions',
      label: sc.permissions.label,
      description: sc.permissions.description,
      icon: <Lock className="w-4 h-4" />,
      action: async () => {
        const mode = await invokeDomain<{ mode?: string }>(IPC_DOMAINS.AGENT, 'getSessionPermissionMode', {
          sessionId: useSessionStore.getState().currentSessionId,
        }).then((d) => d?.mode ?? 'default').catch(() => 'default');
        const lines: string[] = ['Permissions', `  Mode:     ${mode}`, ''];
        try {
          const ep = await invokeDomain<{ rules: Array<{ pattern: string[]; decision: string; source: string }> }>(IPC_DOMAINS.DIAGNOSTICS, 'execPolicy');
          lines.push(`  Exec Policy (${ep.rules.length} rules):`);
          if (ep.rules.length === 0) {
            lines.push('    (no rules learned yet)');
          } else {
            for (const rule of ep.rules.slice(0, 15)) {
              lines.push(`    ${(rule.pattern.join(' ') + ' *').padEnd(24)} → ${rule.decision}  (${rule.source})`);
            }
            if (ep.rules.length > 15) lines.push(`    ... and ${ep.rules.length - 15} more`);
          }
        } catch {
          lines.push('  Exec Policy: (not available)');
        }
        lines.push('');
        try {
          const dh = await invokeDomain<{ total: number; recent: Array<{ toolName: string; summary: string; outcome: string; reason: string; durationMs: number }> }>(IPC_DOMAINS.DIAGNOSTICS, 'decisions');
          lines.push(`  Recent Decisions (${dh.total} total, showing last ${dh.recent.length}):`);
          if (dh.recent.length === 0) {
            lines.push('    (no decisions yet)');
          } else {
            for (const e of dh.recent) {
              lines.push(`    ${e.toolName}(${e.summary.substring(0, 40)}) → ${e.outcome}  (${e.reason}, ${e.durationMs}ms)`);
            }
          }
        } catch {
          lines.push('  Recent Decisions: (not available)');
        }
        writeAssistant(lines.join('\n'));
      },
    },
    // --- 老 registry 命令的 GUI 实现（原 handler 依赖未注入的 ctx.agent，GUI 会报 "Agent not available"）---
    {
      id: 'model',
      label: sc.model.label,
      description: sc.model.description,
      icon: <Cpu className="w-4 h-4" />,
      action: () => {
        const mc = useAppStore.getState().modelConfig;
        writeAssistant(t.slashDiagnostics.modelSwitchHint.replace('{provider}', mc.provider).replace('{model}', mc.model));
      },
    },
    {
      id: 'compact',
      label: sc.compact.label,
      description: sc.compact.description,
      icon: <Zap className="w-4 h-4" />,
      action: async () => {
        try {
          const result = await invoke(IPC_CHANNELS.CONTEXT_COMPACT_CURRENT, currentSessionId ?? undefined);
          if (result?.success) {
            writeAssistant(t.slashDiagnostics.compactedSuccess.replace('{n}', result.savedTokens.toLocaleString('en-US')));
          } else {
            writeAssistant(t.slashDiagnostics.compactNotExecuted + (result?.reason ? t.slashDiagnostics.compactNotExecutedReasonWrap.replace('{reason}', result.reason) : ''));
          }
        } catch (err) {
          writeAssistant(`${t.slashDiagnostics.compactFailedPrefix}${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      id: 'config',
      label: sc.config.label,
      description: sc.config.description,
      icon: <Settings className="w-4 h-4" />,
      action: () => {
        const mc = useAppStore.getState().modelConfig;
        const wd = useStatusStore.getState().workingDirectory ?? 'N/A';
        const sid = useSessionStore.getState().currentSessionId ?? t.slashDiagnostics.configNoSession;
        writeAssistant(
          t.slashDiagnostics.configHeader +
          t.slashDiagnostics.configWorkingDir.replace('{wd}', wd) +
          t.slashDiagnostics.configModel.replace('{model}', mc.model) +
          t.slashDiagnostics.configProvider.replace('{provider}', mc.provider) +
          t.slashDiagnostics.configSessionId.replace('{sid}', sid)
        );
      },
    },
  ] as SlashCommandSeed[]).map((seed) => makeCommand(seed, sc.picker)), [
    createSession, clearCurrentSession, archiveSession, currentSessionId,
    getShortcutLabel, sc,
    setShowSettings, openSettingsTab, setShowDAGPanel, showDAGPanel,
    setShowWorkspace, showWorkspace, setSidebarCollapsed, sidebarCollapsed,
    setInteractionMode, setEffortLevel,
  ]);

  // Merge registry commands (gui surface) with GUI-only commands
  const allCommands: SlashCommand[] = useMemo(() => {
    initializeCommands();
    const registry = getCommandRegistry();
    const registryDefs = registry.list('gui');
    const guiOnlyIds = new Set(guiOnlyCommands.map(c => c.id));

    // Convert registry commands to SlashCommand format (skip those already in GUI-only)
    const fromRegistry: SlashCommand[] = registryDefs
      .filter((def: CommandDefinition) => !guiOnlyIds.has(def.id))
      .map((def: CommandDefinition) => makeCommand({
        id: def.id,
        label: def.name,
        description: def.description,
        icon: registryIconMap[def.id] || <Terminal className="w-4 h-4" />,
        sourceLabel: 'Command',
        action: () => {
          // 调真实 handler，output 路由到 sessionStore.addMessage 写进 chat 流
          // (#139 follow-up: 之前是 console.log placeholder，导致 /doctor 等 registry
          //  command 触发后被 fallback 当 chat message 发给 agent loop，模型 hallucinate
          //  出假报告)
          const addMessage = useSessionStore.getState().addMessage;
          const writeAssistant = (prefix: string) => (msg: string) => {
            addMessage({
              id: generateMessageId(),
              role: 'assistant',
              content: prefix ? `${prefix}${msg}` : msg,
              timestamp: Date.now(),
            });
          };
          void def
            .handler(
              {
                surface: 'gui',
                extensionOps,
                skillOps,
                mcpOps,
                connectorOps,
                output: {
                  info: writeAssistant(''),
                  success: writeAssistant('✅ '),
                  warn: writeAssistant('⚠️ '),
                  error: writeAssistant('❌ '),
                },
              },
              [],
            )
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              writeAssistant('❌ ')(`/${def.id}${t.slashDiagnostics.registryCommandFailedPrefix}${message}`);
            });
        },
      }, sc.picker));

    // Prompt commands（文件式 + MCP），同名让位于 GUI/registry 命令
    const takenIds = new Set([...guiOnlyIds, ...fromRegistry.map((c) => c.id)]);
    const fromPrompts: SlashCommand[] = promptCommands
      .filter((pc) => !takenIds.has(pc.name))
      .map((pc) => ({
        ...createPromptCandidate(pc, sc.picker),
        icon: <Terminal className="w-4 h-4" />,
        sourceLabel: getPromptCommandSourceLabel(pc),
        action: () => {},
      }));

    const fromAgents: SlashCommand[] = createAgentCandidates(agents, sc.picker).map((candidate) => ({
      ...candidate,
      icon: <Bot className="w-4 h-4" />,
      action: () => {},
    }));
    const fromSkills: SlashCommand[] = createSkillCandidates({
      availableSkills,
      mountedSkills,
      selectedSkillIds,
      recommendations: skillRecommendations,
    }, sc.picker).map((candidate) => ({
      ...candidate,
      icon: <Sparkles className="w-4 h-4" />,
      action: () => {},
    }));
    const suggestedCapabilityKeys = capabilitySuggestions.map((capability) => capability.key);
    const fromWorkbenchCapabilities: SlashCommand[] = createWorkbenchCapabilityCandidates(
      capabilityItems,
      suggestedCapabilityKeys,
      sc.picker,
    ).map((candidate) => ({
      ...candidate,
      icon: candidate.kind === 'connector' ? <Plug className="w-4 h-4" /> : <Server className="w-4 h-4" />,
      action: () => {},
    }));

    return [...guiOnlyCommands, ...fromRegistry, ...fromPrompts, ...fromAgents, ...fromSkills, ...fromWorkbenchCapabilities];
  }, [
    agents,
    availableSkills,
    capabilityItems,
    capabilitySuggestions,
    connectorOps,
    extensionOps,
    guiOnlyCommands,
    mcpOps,
    mountedSkills,
    promptCommands,
    registryIconMap,
    sc,
    selectedSkillIds,
    skillRecommendations,
    skillOps,
  ]);

  const filtered = useMemo(
    () => filterAndRankSlashCandidates(allCommands, filter),
    [filter, allCommands],
  );
  const grouped = useMemo(() => groupSlashCandidates(filtered), [filtered]);

  // Reset selection on filter change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid catching the opening click itself
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  // Keyboard navigation via global handler
  useEffect(() => {
    if (!isOpen) return;

    // 捕获阶段注册：抢在 textarea 的 React onKeyDown（委托到 root，冒泡阶段）之前
    // 处理导航键，并 stopPropagation 阻止事件继续向下到达 textarea 的提交逻辑。
    // 否则 Enter 会先被 handleSubmit 当普通消息发出（命令打字+回车失效，只能鼠标点）。
    // 仅在命中导航键时拦截：无匹配命令（filtered[selectedIndex] 不存在）时 Enter 放行，
    // 让 textarea 正常发送以 "/" 开头但非命令的消息。
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(prev => (prev < filtered.length - 1 ? prev + 1 : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : filtered.length - 1));
      } else if (e.key === 'Enter' && filtered[selectedIndex]) {
        const selected = filtered[selectedIndex];
        const normalizedFilter = filter.trim().replace(/^\//, '').toLowerCase();
        const shouldSubmitExactCommand =
          selected.actionKind === 'prefill-leading-command' &&
          ['goal', 'schedule', 'loop'].includes(selected.commandId ?? selected.id) &&
          normalizedFilter === (selected.commandId ?? selected.id).toLowerCase();
        if (shouldSubmitExactCommand) {
          onClose();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onSelect(selected);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, filtered, selectedIndex, onSelect, onClose]);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!isOpen || filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      data-slash-command-popover
      className="absolute bottom-full left-0 right-0 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl z-20 max-h-[280px] overflow-y-auto animate-fade-in"
    >
      <div className="py-1">
        {grouped.map((group) => (
          <div key={group.group}>
            <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-zinc-600 first:pt-1">
              {group.label}
            </div>
            {group.items.map((cmd) => {
              const i = filtered.indexOf(cmd);
              const skillStatus = cmd.kind === 'skill'
                ? cmd.skillSelected ? sc.badges.skillSelected : cmd.skillMounted ? sc.badges.skillMounted : sc.badges.skillMountable
                : null;
              const connectorStatus = cmd.kind === 'connector'
                ? cmd.connectorConnected ? sc.badges.connectorConnected : sc.badges.connectorDisconnected
                : null;
              const mcpStatus = cmd.kind === 'mcp'
                ? cmd.mcpConnected ? sc.badges.mcpAvailable : sc.badges.mcpDisconnected
                : null;
              const usesInitialAvatar = cmd.kind === 'skill' || cmd.kind === 'agent' || cmd.kind === 'connector' || cmd.kind === 'mcp';
              return (
                <button
                  key={cmd.id}
                  type="button"
                  data-slash-command-id={cmd.id}
                  data-selected={i === selectedIndex}
                  onClick={() => onSelect(cmd)}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                    i === selectedIndex
                      ? 'bg-zinc-800 text-zinc-200'
                      : 'text-zinc-400 hover:bg-zinc-800/50'
                  }`}
                >
                  <span className={i === selectedIndex ? 'text-primary-400' : 'text-zinc-500'}>
                    {usesInitialAvatar ? (
                      <RoleInitialAvatar roleId={cmd.id} name={cmd.label} className="h-4 w-4 text-[10px]" />
                    ) : cmd.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm">{cmd.label}</span>
                      {cmd.sublabel ? (
                        <span className="shrink-0 text-[10px] text-zinc-500">{cmd.sublabel}</span>
                      ) : null}
                      <span className="shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
                        {cmd.slashText}
                      </span>
                      {skillStatus ? (
                        <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                          {skillStatus}
                        </span>
                      ) : null}
                      {connectorStatus || mcpStatus ? (
                        <span className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                          {connectorStatus || mcpStatus}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-zinc-500">
                      <span className="truncate">{cmd.description}</span>
                      {i === selectedIndex && cmd.effectLabel ? (
                        <span className="shrink-0 text-zinc-600">{cmd.effectLabel}</span>
                      ) : null}
                    </div>
                  </div>
                  {cmd.shortcut && (
                    <kbd className="px-1.5 py-0.5 text-[10px] bg-zinc-800 rounded text-zinc-500 border border-zinc-700">
                      {cmd.shortcut}
                    </kbd>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
