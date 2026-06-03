// ============================================================================
// SettingsModal - Main Settings Modal Entry Point
// Layout + Tab Switching
// ============================================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ChevronLeft,
  X,
  Cpu,
  Palette,
  Fingerprint,
  Info,
  Database,
  Download,
  Plug,
  Brain,
  Sparkles,
  Eye,
  GitBranch,
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
  ShieldCheck,
  Terminal,
  UserCircle,
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
  SETTINGS_TAB_GROUP_LABELS,
  SETTINGS_TAB_GROUP_ORDER,
  canAccessSettingsTab,
  type SettingsTab,
  type SettingsTabGroupId,
} from '../../../utils/settingsTabs';
import { tauriCheckForUpdate } from '../../../utils/tauriUpdater';

const logger = createLogger('SettingsModal');

const WIDE_SETTINGS_TABS = new Set<SettingsTab>([
  'cache',
  'capabilities',
  'plugins',
  'model',
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
import { WorkspaceSettings } from './tabs/WorkspaceSettings';
import { AutomationSettings } from './tabs/AutomationSettings';
import { AppshotsSettings } from './tabs/AppshotsSettings';
import { ModelSettings } from './tabs/ModelSettings';
import { AgentEngineSettings } from './tabs/AgentEngineSettings';
import { AppearanceSettings } from './tabs/AppearanceSettings';
import { SoulSettings } from './tabs/SoulSettings';
import { DataSettings } from './tabs/DataSettings';
import { UpdateSettings } from './tabs/UpdateSettings';
import { MCPSettings } from './tabs/MCPSettings';
import { MemoryTab } from './tabs/MemoryTab';
import { RolesTab } from './tabs/RolesTab';
import { SkillsSettings } from './tabs/SkillsSettings';
import { PluginsSettings } from './tabs/PluginsSettings';
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
  const tabs: SettingsTabConfig[] = [
    { id: 'general', label: '权限与安全', icon: <Shield className="w-4 h-4" /> },
    { id: 'conversation', label: '对话', icon: <GitBranch className="w-4 h-4" /> },
    { id: 'model', label: t.settings.tabs.model, icon: <Cpu className="w-4 h-4" /> },
    { id: 'agentEngine', label: 'Agent 引擎', icon: <Terminal className="w-4 h-4" /> },
    { id: 'appearance', label: t.settings.tabs.appearance, icon: <Palette className="w-4 h-4" /> },
    { id: 'soul', label: '人格', icon: <Fingerprint className="w-4 h-4" /> },
    { id: 'workspace', label: '工作区', icon: <FolderOpen className="w-4 h-4" /> },
    { id: 'automation', label: '自动化', icon: <Clock className="w-4 h-4" /> },
    { id: 'appshots', label: '应用截图', icon: <Camera className="w-4 h-4" /> },
    { id: 'users', label: '用户管理', icon: <Users className="w-4 h-4" /> },
    { id: 'invites', label: '邀请码管理', icon: <Ticket className="w-4 h-4" /> },
    { id: 'controlPlane', label: '控制平面', icon: <Cloud className="w-4 h-4" /> },
    { id: 'cache', label: '数据与存储', icon: <Database className="w-4 h-4" /> },
    { id: 'capabilities', label: '能力中心', icon: <Boxes className="w-4 h-4" /> },
    { id: 'plugins', label: '插件管理', icon: <PackagePlus className="w-4 h-4" /> },
    { id: 'mcp', label: 'MCP', icon: <Plug className="w-4 h-4" /> },
    { id: 'skills', label: 'Skills', icon: <Sparkles className="w-4 h-4" /> },
    { id: 'roles', label: '角色', icon: <UserCircle className="w-4 h-4" /> },
    { id: 'channels', label: '通道', icon: <MessageSquare className="w-4 h-4" /> },
    { id: 'hooks', label: 'Hook', icon: <Webhook className="w-4 h-4" /> },
    { id: 'memory', label: t.settings?.tabs?.memory || '记忆', icon: <Brain className="w-4 h-4" /> },
    ...(showScreenMemoryTab ? [{ id: 'openchronicle' as const, label: '屏幕记忆', icon: <Eye className="w-4 h-4" /> }] : []),
    { id: 'privacy', label: '隐私防线', icon: <ShieldCheck className="w-4 h-4" /> },
    ...(showUpdateTab ? [{ id: 'update' as const, label: t.settings.tabs.update || '更新', icon: <Download className="w-4 h-4" />, badge: hasOptionalUpdate }] : []),
    { id: 'about', label: t.settings.tabs.about, icon: <Info className="w-4 h-4" /> },
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
      label: SETTINGS_TAB_GROUP_LABELS[groupId],
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
              <span>返回应用</span>
            </button>
            <SettingsSearch onNavigate={handleSearchNavigate} access={accessSubject} />
          </div>

          <nav className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-5">
            {tabGroups.map((group) => {
              return (
                <div key={group.id} className="space-y-1">
                  <div className="px-3 pb-1 pt-2 text-[11px] font-medium tracking-wide text-zinc-500">
                    {group.label}
                  </div>
                  {group.tabs.map((tab) => (
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
            {activeTab === 'workspace' && <WorkspaceSettings />}
            {activeTab === 'automation' && <AutomationSettings />}
            {activeTab === 'appshots' && <AppshotsSettings />}
            {canViewUsers && activeTab === 'users' && <UserDashboardSettings />}
            {canViewInvites && activeTab === 'invites' && <InviteCodesSettings />}
            {canViewControlPlane && activeTab === 'controlPlane' && <ControlPlaneSettings />}
            {activeTab === 'model' && (
              <ModelSettings config={modelConfig} onChange={setModelConfig} />
            )}
            {activeTab === 'agentEngine' && <AgentEngineSettings />}
            {activeTab === 'appearance' && <AppearanceSettings />}
            {activeTab === 'soul' && <SoulSettings />}
            {activeTab === 'cache' && <DataSettings />}
            {activeTab === 'capabilities' && (
              <CapabilityCenterSettings onNavigateSettings={handleSearchNavigate} />
            )}
            {canViewPlugins && activeTab === 'plugins' && <PluginsSettings />}
            {activeTab === 'mcp' && <MCPSettings />}
            {activeTab === 'skills' && <SkillsSettings />}
            {activeTab === 'roles' && <RolesTab />}
            {activeTab === 'channels' && <ChannelsSettings />}
            {activeTab === 'hooks' && <HooksSettings />}
            {activeTab === 'memory' && <MemoryTab />}
            {activeTab === 'openchronicle' && <ScreenMemorySettings />}
            {activeTab === 'privacy' && <PrivacySettings />}
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
