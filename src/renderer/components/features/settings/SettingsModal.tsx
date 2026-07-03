// ============================================================================
// SettingsModal - Main Settings Modal Entry Point
// Layout + Tab Switching
// ============================================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  X,
  Image as ImageIcon,
  Palette,
  Fingerprint,
  Info,
  Database,
  Download,
  Plug,
  Brain,
  BrainCircuit,
  Sparkles,
  Eye,
  FoldVertical,
  Shield,
  MessageSquare,
  Webhook,
  Boxes,
  FolderOpen,
  Clock,
  Ticket,
  Users,
  Cloud,
  PackagePlus,
  Camera,
  Keyboard,
  ShieldCheck,
  Terminal,
  UserCircle,
  Mic,
  Search,
} from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { useI18n } from '../../../hooks/useI18n';
import { IconButton } from '../../primitives';
import { UpdateNotification } from '../../UpdateNotification';
import { IPC_DOMAINS } from '@shared/ipc';
import type { UpdateInfo } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { isDesktopShellMode, isTauriMode } from '../../../utils/platform';
import { canAccessFeature, createAccessSubject, type AccessSubject } from '../../../utils/accessControl';
import { SettingsSearch } from './SettingsSearch';
import { FullScreenPage } from '../shared/FullScreenPage';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TAB_GROUP_BY_TAB,
  SETTINGS_TAB_GROUP_ORDER,
  COLLAPSED_SETTINGS_TAB_GROUPS,
  canAccessSettingsTab,
  type SettingsTab,
  type SettingsTabGroupId,
} from '../../../utils/settingsTabs';
import { tauriCheckForUpdate } from '../../../utils/tauriUpdater';

const logger = createLogger('SettingsModal');

const WIDE_SETTINGS_TABS = new Set<SettingsTab>([
  'cache',
  'keybindings',
  'capabilities',
  'plugins',
  'model',
  'visualModels',
  'mcp',
  'skills',
  'roles',
  'channels',
  'hooks',
  'memory',
  'openchronicle',
  'workspace',
  'automation',
  'users',
  'invites',
  'controlPlane',
]);

// Tab Components
import { GeneralSettings } from './tabs/GeneralSettings';
import { ConversationSettings } from './tabs/ConversationSettings';
import { VoiceInputSettings } from './tabs/VoiceInputSettings';
import { KeybindingsSettings } from './tabs/KeybindingsSettings';
import { WorkspaceSettings } from './tabs/WorkspaceSettings';
import { AutomationSettings } from './tabs/AutomationSettings';
import { AppshotsSettings } from './tabs/AppshotsSettings';
import { ModelSettings } from './tabs/ModelSettings';
import { VisualModelsSettings } from './tabs/VisualModelsSettings';
import { SearchSettings } from './tabs/SearchSettings';
import { AgentEngineSettings } from './tabs/AgentEngineSettings';
import { AppearanceSettings } from './tabs/AppearanceSettings';
import { SoulSettings } from './tabs/SoulSettings';
import { DataSettings } from './tabs/DataSettings';
import { UpdateSettings } from './tabs/UpdateSettings';
// 重型 tab（拉 mcpCatalog / almaPluginRegistry / almaRecommendationPolicy 等大注册表）
// 改懒加载：首屏不再随 SettingsModal chunk 一起加载，按需打开对应 tab 才拉。
const MCPSettings = React.lazy(() =>
  import('./tabs/MCPSettings').then((m) => ({ default: m.MCPSettings })),
);
import { MemoryTab } from './tabs/MemoryTab';
import { RolesTab } from './tabs/RolesTab';
const SkillsSettings = React.lazy(() =>
  import('./tabs/SkillsSettings').then((m) => ({ default: m.SkillsSettings })),
);
const PluginsSettings = React.lazy(() =>
  import('./tabs/PluginsSettings').then((m) => ({ default: m.PluginsSettings })),
);
import { CapabilityCenterSettings } from './tabs/CapabilityCenterSettings';
import { ChannelsSettings } from './tabs/ChannelsSettings';
import { HooksSettings } from './tabs/HooksSettings';
import { AboutSettings } from './tabs/AboutSettings';
import { ScreenMemorySettings } from './tabs/ScreenMemorySettings';
import PrivacySettings from './tabs/PrivacySettings';
import { UserDashboardSettings } from './tabs/UserDashboardSettings';
import { InviteCodesSettings } from './tabs/InviteCodesSettings';
import { ControlPlaneSettings } from './tabs/ControlPlaneSettings';
import ipcService from '../../../services/ipcService';

interface SettingsTabConfig {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
  badge?: boolean;
}

interface SettingsTabGroupConfig {
  id: SettingsTabGroupId;
  label: string;
  tabs: SettingsTabConfig[];
}

interface BuildSettingsTabsOptions {
  t: ReturnType<typeof useI18n>['t'];
  showScreenMemoryTab: boolean;
  showUpdateTab: boolean;
  hasOptionalUpdate: boolean;
  access?: AccessSubject | null;
}

export function buildSettingsTabGroups({
  t,
  showScreenMemoryTab,
  showUpdateTab,
  hasOptionalUpdate,
  access,
}: BuildSettingsTabsOptions): SettingsTabGroupConfig[] {
  const accessSubject = createAccessSubject(access);
  // 顺序即侧栏顺序（Settings IA v2 拍板 2026-07-03：默认 5 组 + 高级折叠组 + admin 管理组）
  const tabs: SettingsTabConfig[] = [
    // 模型与能力
    { id: 'model', label: t.settings.tabs.model, icon: <Brain className="w-4 h-4" /> },
    { id: 'visualModels', label: t.settings.tabs.visualModels, icon: <ImageIcon className="w-4 h-4" /> },
    { id: 'search', label: t.settings.tabs.search, icon: <Search className="w-4 h-4" /> },
    { id: 'soul', label: t.settings.tabs.soul, icon: <Fingerprint className="w-4 h-4" /> },
    { id: 'skills', label: t.settings.tabs.skills, icon: <Sparkles className="w-4 h-4" /> },
    // 基础偏好
    { id: 'appearance', label: t.settings.tabs.appearance, icon: <Palette className="w-4 h-4" /> },
    { id: 'general', label: t.settings.tabs.general, icon: <Shield className="w-4 h-4" /> },
    { id: 'conversation', label: t.settings.tabs.conversation, icon: <FoldVertical className="w-4 h-4" /> },
    { id: 'keybindings', label: t.settings.tabs.keybindings, icon: <Keyboard className="w-4 h-4" /> },
    { id: 'voiceInput', label: t.settings.tabs.voiceInput, icon: <Mic className="w-4 h-4" /> },
    // 工作与协作
    { id: 'workspace', label: t.settings.tabs.workspace, icon: <FolderOpen className="w-4 h-4" /> },
    { id: 'automation', label: t.settings.tabs.automation, icon: <Clock className="w-4 h-4" /> },
    { id: 'channels', label: t.settings.tabs.channels, icon: <MessageSquare className="w-4 h-4" /> },
    { id: 'roles', label: t.settings.tabs.roles, icon: <UserCircle className="w-4 h-4" /> },
    // 记忆与隐私
    { id: 'memory', label: t.settings?.tabs?.memory || '记忆', icon: <BrainCircuit className="w-4 h-4" /> },
    ...(showScreenMemoryTab ? [{ id: 'openchronicle' as const, label: t.settings.tabs.openchronicle, icon: <Eye className="w-4 h-4" /> }] : []),
    { id: 'privacy', label: t.settings.tabs.privacy, icon: <ShieldCheck className="w-4 h-4" /> },
    // 系统
    ...(showUpdateTab ? [{ id: 'update' as const, label: t.settings.tabs.update || '更新', icon: <Download className="w-4 h-4" />, badge: hasOptionalUpdate }] : []),
    { id: 'about', label: t.settings.tabs.about, icon: <Info className="w-4 h-4" /> },
    // 高级（默认折叠，普通用户可自行配置）
    { id: 'agentEngine', label: t.engineCompat.engineSection.title, icon: <Terminal className="w-4 h-4" /> },
    { id: 'mcp', label: t.settings.tabs.mcp, icon: <Plug className="w-4 h-4" /> },
    { id: 'plugins', label: t.settings.tabs.plugins, icon: <PackagePlus className="w-4 h-4" /> },
    { id: 'hooks', label: t.settings.tabs.hooks, icon: <Webhook className="w-4 h-4" /> },
    { id: 'appshots', label: t.settings.tabs.appshots, icon: <Camera className="w-4 h-4" /> },
    { id: 'cache', label: t.settings.tabs.cache, icon: <Database className="w-4 h-4" /> },
    // 管理（仅 admin）
    { id: 'users', label: t.settings.tabs.users, icon: <Users className="w-4 h-4" /> },
    { id: 'invites', label: t.settings.tabs.invites, icon: <Ticket className="w-4 h-4" /> },
    { id: 'controlPlane', label: t.settings.tabs.controlPlane, icon: <Cloud className="w-4 h-4" /> },
    { id: 'capabilities', label: t.settings.tabs.capabilities, icon: <Boxes className="w-4 h-4" /> },
  ];

  const groups = new Map<SettingsTabGroupId, SettingsTabConfig[]>();
  for (const groupId of SETTINGS_TAB_GROUP_ORDER) {
    groups.set(groupId, []);
  }
  for (const tab of tabs.filter((tab) => canAccessSettingsTab(tab.id, accessSubject))) {
    groups.get(SETTINGS_TAB_GROUP_BY_TAB[tab.id])?.push(tab);
  }

  return SETTINGS_TAB_GROUP_ORDER
    .map((groupId) => ({
      id: groupId,
      label: t.settings.tabGroups[groupId],
      tabs: groups.get(groupId) || [],
    }))
    .filter((group) => group.tabs.length > 0);
}

export function buildSettingsTabs(options: BuildSettingsTabsOptions): SettingsTabConfig[] {
  return buildSettingsTabGroups(options).flatMap((group) => group.tabs);
}

export async function resolveOptionalUpdateInfo(
  checkForUpdate: () => Promise<UpdateInfo>,
  onCheckFailed?: (error: unknown) => void,
): Promise<UpdateInfo | null> {
  try {
    const info = await checkForUpdate();
    if (info?.hasUpdate && !info?.forceUpdate) {
      return info;
    }
  } catch (error) {
    onCheckFailed?.(error);
  }
  return null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// Component
// ============================================================================

export const SettingsModal: React.FC = () => {
  const {
    setShowSettings,
    modelConfig,
    setModelConfig,
    settingsInitialTab,
    clearSettingsInitialTab,
    optionalUpdateInfo,
    setOptionalUpdateInfo,
  } = useAppStore();
  const currentUser = useAuthStore((state) => state.user);
  const accessSubject = useMemo(() => createAccessSubject(currentUser), [currentUser]);
  const canViewUsers = canAccessSettingsTab('users', accessSubject);
  const canViewInvites = canAccessSettingsTab('invites', accessSubject);
  const canViewControlPlane = canAccessSettingsTab('controlPlane', accessSubject);
  const canViewPlugins = canAccessSettingsTab('plugins', accessSubject);
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    settingsInitialTab ?? DEFAULT_SETTINGS_TAB
  );
  // 「高级」等默认折叠组的展开状态（无权限语义，纯侧栏收纳）
  const [expandedCollapsedGroups, setExpandedCollapsedGroups] = useState<Set<SettingsTabGroupId>>(
    () => new Set()
  );

  // active tab 落在折叠组内（如搜索直达 MCP）时自动展开该组
  useEffect(() => {
    const group = SETTINGS_TAB_GROUP_BY_TAB[activeTab];
    if (!COLLAPSED_SETTINGS_TAB_GROUPS.has(group)) return;
    setExpandedCollapsedGroups((prev) => {
      if (prev.has(group)) return prev;
      const next = new Set(prev);
      next.add(group);
      return next;
    });
  }, [activeTab]);

  const toggleCollapsedGroup = useCallback((groupId: SettingsTabGroupId) => {
    setExpandedCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const handleSearchNavigate = useCallback((tab: SettingsTab) => {
    setActiveTab(tab);
  }, [setOptionalUpdateInfo]);

  const handleClose = useCallback(() => {
    setShowSettings(false);
  }, [setShowSettings]);

  const [showUpdateModal, setShowUpdateModal] = useState(false);

  // Check for updates on mount (for badge display)
  useEffect(() => {
    if (!isDesktopShellMode()) return;
    let cancelled = false;

    const checkUpdate = async () => {
      const info = await resolveOptionalUpdateInfo(
        () => (
          isTauriMode()
            ? tauriCheckForUpdate()
            : ipcService.invokeDomain<UpdateInfo>(IPC_DOMAINS.UPDATE, 'check')
        ),
        (error) => {
          logger.debug('Optional update badge check skipped', {
            errorMessage: getErrorMessage(error),
          });
        },
      );
      if (!cancelled && info) {
        setOptionalUpdateInfo(info);
      }
    };
    void checkUpdate();
    return () => {
      cancelled = true;
    };
  }, []);

  const showUpdateTab = isDesktopShellMode();
  const tabGroups = useMemo(
    () => buildSettingsTabGroups({
      t,
      showScreenMemoryTab: isDesktopShellMode(),
      showUpdateTab,
      hasOptionalUpdate: !!optionalUpdateInfo?.hasUpdate,
      access: accessSubject,
    }),
    [t, showUpdateTab, optionalUpdateInfo?.hasUpdate, accessSubject]
  );
  const tabs = useMemo(
    () => tabGroups.flatMap((group) => group.tabs),
    [tabGroups]
  );
  const activeTabConfig = useMemo(
    () => tabs.find((tab) => tab.id === activeTab),
    [activeTab, tabs]
  );
  const activeGroupConfig = useMemo(
    () => tabGroups.find((group) => group.tabs.some((tab) => tab.id === activeTab)),
    [activeTab, tabGroups]
  );
  const contentWidthClass = WIDE_SETTINGS_TABS.has(activeTab) ? 'max-w-6xl' : 'max-w-4xl';

  useEffect(() => {
    if (!settingsInitialTab) return;
    setActiveTab(settingsInitialTab);
    clearSettingsInitialTab();
  }, [settingsInitialTab, clearSettingsInitialTab]);

  useEffect(() => {
    if (tabs.some((tab) => tab.id === activeTab)) return;
    setActiveTab(DEFAULT_SETTINGS_TAB);
  }, [activeTab, tabs]);

  return (
    <FullScreenPage
      role="dialog"
      aria-modal="true"
      aria-label={t.settings.title}
      testId="settings-panel"
      className="h-screen overflow-hidden animate-fadeIn"
    >
      <div className="flex h-full min-h-0">
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/95">
          <div className="px-4 pb-3 pt-5">
            <button
              type="button"
              onClick={handleClose}
              className="mb-5 inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 focus:outline-hidden"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>{t.settings.backToApp}</span>
            </button>
            <SettingsSearch onNavigate={handleSearchNavigate} access={accessSubject} />
          </div>

          <nav className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-5">
            {tabGroups.map((group) => {
              const isCollapsible = COLLAPSED_SETTINGS_TAB_GROUPS.has(group.id);
              const isCollapsed = isCollapsible && !expandedCollapsedGroups.has(group.id);
              return (
                <div key={group.id} className="space-y-1">
                  {isCollapsible ? (
                    <button /* ds-allow:button: 设置分组折叠头，11px 微字号纯文本行头样式，primitive 无对应变体（同款豁免见 SidebarProjectDrawer） */
                      type="button"
                      onClick={() => toggleCollapsedGroup(group.id)}
                      aria-expanded={!isCollapsed}
                      className="flex w-full items-center gap-1 rounded-lg px-3 pb-1 pt-2 text-left text-[11px] font-medium tracking-wide text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                      {isCollapsed
                        ? <ChevronRight className="h-3 w-3 shrink-0" />
                        : <ChevronDown className="h-3 w-3 shrink-0" />}
                      <span>{group.label}</span>
                    </button>
                  ) : (
                    <div className="px-3 pb-1 pt-2 text-[11px] font-medium tracking-wide text-zinc-500">
                      {group.label}
                    </div>
                  )}
                  {!isCollapsed && group.tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                        activeTab === tab.id
                          ? 'bg-zinc-800 text-zinc-100'
                          : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
                      }`}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        {tab.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {tab.label}
                      </span>
                      {tab.badge && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-indigo-500 animate-pulse" />
                      )}
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
          <div className={`mx-auto min-h-full px-8 pb-16 pt-16 ${contentWidthClass}`}>
            <div className="mb-10 flex items-start justify-between gap-6">
              <div>
                <h2 id="settings-page-title" className="text-2xl font-semibold text-zinc-100">
                  {activeTabConfig?.label || t.settings.title}
                </h2>
                {activeGroupConfig && (
                  <p className="mt-2 text-sm text-zinc-500">
                    {activeGroupConfig.label}
                  </p>
                )}
              </div>
              <IconButton
                icon={<X className="h-5 w-5" />}
                aria-label="Close settings"
                onClick={handleClose}
                variant="ghost"
                size="lg"
              />
            </div>

            {activeTab === 'general' && <GeneralSettings />}
            {activeTab === 'conversation' && <ConversationSettings />}
            {activeTab === 'search' && <SearchSettings />}
            {activeTab === 'voiceInput' && <VoiceInputSettings />}
            {activeTab === 'keybindings' && <KeybindingsSettings />}
            {activeTab === 'workspace' && <WorkspaceSettings />}
            {activeTab === 'automation' && <AutomationSettings />}
            {activeTab === 'appshots' && <AppshotsSettings />}
            {canViewUsers && activeTab === 'users' && <UserDashboardSettings />}
            {canViewInvites && activeTab === 'invites' && <InviteCodesSettings />}
            {canViewControlPlane && activeTab === 'controlPlane' && <ControlPlaneSettings />}
            {activeTab === 'model' && (
              <ModelSettings config={modelConfig} onChange={setModelConfig} />
            )}
            {activeTab === 'visualModels' && <VisualModelsSettings />}
            {activeTab === 'agentEngine' && <AgentEngineSettings />}
            {activeTab === 'appearance' && <AppearanceSettings />}
            {activeTab === 'soul' && <SoulSettings />}
            {activeTab === 'cache' && <DataSettings />}
            {activeTab === 'capabilities' && (
              <CapabilityCenterSettings onNavigateSettings={handleSearchNavigate} />
            )}
            {(activeTab === 'mcp' || activeTab === 'skills' || (canViewPlugins && activeTab === 'plugins')) && (
              <React.Suspense fallback={<div className="p-4 text-sm text-zinc-500">加载中…</div>}>
                {canViewPlugins && activeTab === 'plugins' && <PluginsSettings />}
                {activeTab === 'mcp' && <MCPSettings />}
                {activeTab === 'skills' && <SkillsSettings />}
              </React.Suspense>
            )}
            {activeTab === 'roles' && <RolesTab />}
            {activeTab === 'channels' && <ChannelsSettings />}
            {activeTab === 'hooks' && <HooksSettings />}
            {activeTab === 'memory' && <MemoryTab />}
            {activeTab === 'openchronicle' && <ScreenMemorySettings />}
            {activeTab === 'privacy' && <PrivacySettings onNavigateSettings={handleSearchNavigate} />}
            {showUpdateTab && activeTab === 'update' && (
              <UpdateSettings
                updateInfo={optionalUpdateInfo}
                onUpdateInfoChange={setOptionalUpdateInfo}
                onShowUpdateModal={() => setShowUpdateModal(true)}
              />
            )}
            {activeTab === 'about' && <AboutSettings />}
          </div>
        </main>
      </div>

      {/* Optional Update Modal */}
      {isDesktopShellMode() && !isTauriMode() && showUpdateModal && optionalUpdateInfo && (
        <UpdateNotification
          updateInfo={optionalUpdateInfo}
          onClose={() => setShowUpdateModal(false)}
        />
      )}
    </FullScreenPage>
  );
};
