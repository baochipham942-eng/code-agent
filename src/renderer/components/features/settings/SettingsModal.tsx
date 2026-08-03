// ============================================================================
// SettingsModal - Main Settings Modal Entry Point
// Layout + Tab Switching
//
// 未保存拦截契约（2026-07 设置页 P0）：
// - staged-dirty 的唯一来源是 ModelSettings 的 Provider 表单（契约见 ModelSettings
//   文件头注释），通过 onDirtyChange 上报到本组件的 modelFormDirty。
// - 拦截层在本组件（tab 条件渲染会 unmount 内容组件，子组件自己拦不住）：
//   侧栏 tab 点击 / 设置搜索跳转 / 关闭设置页（返回键 + X）统一走
//   guardWhileModelDirty，dirty 时弹 ConfirmDialog（丢弃修改 / 继续编辑）。
// - dirty 期间侧栏「通用模型」tab 显示「未保存」徽标；其他即存页不参与。
// - 已知边界：全局 Escape 快捷键（useKeyboardShortcuts）直接 setShowSettings(false)，
//   走 store 不经过本组件，暂不拦截（拦截需把 dirty 提升到全局 store，留给后续批次）。
// ============================================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  X,
  AudioLines,
  Image as ImageIcon,
  Palette,
  Fingerprint,
  Info,
  Database,
  Download,
  Brain,
  BrainCircuit,
  Eye,
  FoldVertical,
  Shield,
  MessageSquare,
  Webhook,
  FolderOpen,
  Camera,
  Keyboard,
  ShieldCheck,
  Stethoscope,
  Terminal,
  Mic,
  Phone,
  Search,
} from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { useI18n } from '../../../hooks/useI18n';
import { IconButton } from '../../primitives';
import { ConfirmDialog } from '../../composites/ConfirmDialog';
import { UpdateNotification } from '../../UpdateNotification';
import { IPC_DOMAINS } from '@shared/ipc';
import type { UpdateInfo } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { isDesktopShellMode, isTauriMode } from '../../../utils/platform';
import { createAccessSubject, type AccessSubject } from '../../../utils/accessControl';
import { SettingsSearch } from './SettingsSearch';
import { FullScreenPage } from '../shared/FullScreenPage';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TAB_GROUP_BY_TAB,
  SETTINGS_TAB_GROUP_ORDER,
  COLLAPSED_SETTINGS_TAB_GROUPS,
  resolveSettingsDeepLink,
  canAccessSettingsTab,
  type SettingsTab,
  type SettingsTabGroupId,
} from '../../../utils/settingsTabs';
import { tauriCheckForUpdate } from '../../../utils/tauriUpdater';

const logger = createLogger('SettingsModal');

// 宽版内容区（max-w-6xl）tab：内容本身有宽表格 / 多栏布局，窄版会恒横向滚动
export const WIDE_SETTINGS_TABS = new Set<SettingsTab>([
  'cache',
  'general',
  'keybindings',
  'model',
  'visualModels',
  'channels',
  'hooks',
  'memory',
  'openchronicle',
  'workspace',
]);

// Tab Components: the settings shell loads only the active tab. Keep the shell
// itself eager so opening settings does not add another lazy boundary.
const GeneralSettings = React.lazy(() => import('./tabs/GeneralSettings').then(({ GeneralSettings: component }) => ({
  default: component,
})));
const ConversationSettings = React.lazy(() => import('./tabs/ConversationSettings').then(({ ConversationSettings: component }) => ({
  default: component,
})));
const VoiceInputSettings = React.lazy(() => import('./tabs/VoiceInputSettings'));
const VoiceLiveSettings = React.lazy(() => import('./tabs/VoiceLiveSettings'));
const VoiceModelSettings = React.lazy(() => import('./tabs/VoiceModelSettings'));
const KeybindingsSettings = React.lazy(() => import('./tabs/KeybindingsSettings').then(({ KeybindingsSettings: component }) => ({
  default: component,
})));
const WorkspaceSettings = React.lazy(() => import('./tabs/WorkspaceSettings').then(({ WorkspaceSettings: component }) => ({
  default: component,
})));
const AppshotsSettings = React.lazy(() => import('./tabs/AppshotsSettings'));
const ModelSettings = React.lazy(() => import('./tabs/ModelSettings').then(({ ModelSettings: component }) => ({
  default: component,
})));
const VisualModelsSettings = React.lazy(() => import('./tabs/VisualModelsSettings'));
const SearchSettings = React.lazy(() => import('./tabs/SearchSettings').then(({ SearchSettings: component }) => ({
  default: component,
})));
const AgentEngineSettings = React.lazy(() => import('./tabs/AgentEngineSettings').then(({ AgentEngineSettings: component }) => ({
  default: component,
})));
const AppearanceSettings = React.lazy(() => import('./tabs/AppearanceSettings').then(({ AppearanceSettings: component }) => ({
  default: component,
})));
const SoulSettings = React.lazy(() => import('./tabs/SoulSettings').then(({ SoulSettings: component }) => ({
  default: component,
})));
const DataSettings = React.lazy(() => import('./tabs/DataSettings').then(({ DataSettings: component }) => ({
  default: component,
})));
const UpdateSettings = React.lazy(() => import('./tabs/UpdateSettings').then(({ UpdateSettings: component }) => ({
  default: component,
})));
const MemoryTab = React.lazy(() => import('./tabs/MemoryTab').then(({ MemoryTab: component }) => ({
  default: component,
})));
const ChannelsSettings = React.lazy(() => import('./tabs/ChannelsSettings').then(({ ChannelsSettings: component }) => ({
  default: component,
})));
const HooksSettings = React.lazy(() => import('./tabs/HooksSettings').then(({ HooksSettings: component }) => ({
  default: component,
})));
const AboutSettings = React.lazy(() => import('./tabs/AboutSettings').then(({ AboutSettings: component }) => ({
  default: component,
})));
const ScreenMemorySettings = React.lazy(() => import('./tabs/ScreenMemorySettings').then(({ ScreenMemorySettings: component }) => ({
  default: component,
})));
const PrivacySettings = React.lazy(() => import('./tabs/PrivacySettings'));
const DoctorSettings = React.lazy(() => import('./tabs/DoctorSettings').then(({ DoctorSettings: component }) => ({
  default: component,
})));

// 沿用仓库既有的固定尺寸 pulse/shimmer 占位范式；固定最小高度避免切 tab 时内容区塌陷。
function SettingsTabSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-testid="settings-tab-skeleton"
      className="min-h-[540px] space-y-5"
    >
      <div className="h-7 w-1/3 animate-pulse rounded-lg bg-zinc-800/40" />
      <div className="h-24 animate-pulse rounded-lg border border-zinc-800 bg-zinc-950/60" />
      <div className="h-36 animate-pulse rounded-lg border border-zinc-800 bg-zinc-950/60" />
      <div className="h-20 w-4/5 animate-pulse rounded-lg border border-zinc-800 bg-zinc-950/60" />
    </div>
  );
}
// 用户管理 / 邀请码 / 控制平面 / 能力治理四个 tab 已迁 admin-console（2026-07 方案 9C），
// 组件文件保留在 ./tabs 下待清死代码，但设置页不再 import、不提供任何入口。
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
  // 顺序即侧栏顺序（Settings IA v2 拍板 2026-07-03：默认 5 组 + 高级折叠组；
  // 2026-07 方案 9C：admin 管理组迁 admin-console，设置页不再出现）
  const tabs: SettingsTabConfig[] = [
    // 模型与能力
    { id: 'model', label: t.settings.tabs.model, icon: <Brain className="w-4 h-4" /> },
    { id: 'visualModels', label: t.settings.tabs.visualModels, icon: <ImageIcon className="w-4 h-4" /> },
    // T1（2026-07-28 拍板）：通话模型/音色/转写模型从 voiceLive/voiceInput 收拢到这里，
    // 两个旧 tab 只留使用偏好（一个能力只有一个家、消费路径只选不配）。
    { id: 'voiceModel', label: t.settings.tabs.voiceModel, icon: <AudioLines className="w-4 h-4" /> },
    { id: 'search', label: t.settings.tabs.search, icon: <Search className="w-4 h-4" /> },
    { id: 'soul', label: t.settings.tabs.soul, icon: <Fingerprint className="w-4 h-4" /> },
    // 基础偏好
    { id: 'appearance', label: t.settings.tabs.appearance, icon: <Palette className="w-4 h-4" /> },
    { id: 'general', label: t.settings.tabs.general, icon: <Shield className="w-4 h-4" /> },
    { id: 'doctor', label: t.settings.tabs.doctor, icon: <Stethoscope className="w-4 h-4" /> },
    { id: 'conversation', label: t.settings.tabs.conversation, icon: <FoldVertical className="w-4 h-4" /> },
    { id: 'keybindings', label: t.settings.tabs.keybindings, icon: <Keyboard className="w-4 h-4" /> },
    { id: 'voiceLive', label: t.settings.tabs.voiceLive, icon: <Phone className="w-4 h-4" /> },
    { id: 'voiceInput', label: t.settings.tabs.voiceInput, icon: <Mic className="w-4 h-4" /> },
    // 工作与协作
    { id: 'workspace', label: t.settings.tabs.workspace, icon: <FolderOpen className="w-4 h-4" /> },
    { id: 'channels', label: t.settings.tabs.channels, icon: <MessageSquare className="w-4 h-4" /> },
    // 记忆与隐私
    { id: 'memory', label: t.settings.tabs.memory, icon: <BrainCircuit className="w-4 h-4" /> },
    ...(showScreenMemoryTab ? [{ id: 'openchronicle' as const, label: t.settings.tabs.openchronicle, icon: <Eye className="w-4 h-4" /> }] : []),
    { id: 'privacy', label: t.settings.tabs.privacy, icon: <ShieldCheck className="w-4 h-4" /> },
    // 系统
    ...(showUpdateTab ? [{ id: 'update' as const, label: t.settings.tabs.update, icon: <Download className="w-4 h-4" />, badge: hasOptionalUpdate }] : []),
    { id: 'about', label: t.settings.tabs.about, icon: <Info className="w-4 h-4" /> },
    // 高级（默认折叠，普通用户可自行配置）
    { id: 'agentEngine', label: t.engineCompat.engineSection.title, icon: <Terminal className="w-4 h-4" /> },
    { id: 'hooks', label: t.settings.tabs.hooks, icon: <Webhook className="w-4 h-4" /> },
    { id: 'appshots', label: t.settings.tabs.appshots, icon: <Camera className="w-4 h-4" /> },
    { id: 'cache', label: t.settings.tabs.cache, icon: <Database className="w-4 h-4" /> },
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
    openSettingsTab,
    modelConfig,
    setModelConfig,
    settingsInitialTab,
    clearSettingsInitialTab,
    optionalUpdateInfo,
    setOptionalUpdateInfo,
  } = useAppStore();
  const currentUser = useAuthStore((state) => state.user);
  const accessSubject = useMemo(() => createAccessSubject(currentUser), [currentUser]);
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    settingsInitialTab ?? DEFAULT_SETTINGS_TAB
  );
  // 「高级」等默认折叠组的展开状态（无权限语义，纯侧栏收纳）
  const [expandedCollapsedGroups, setExpandedCollapsedGroups] = useState<Set<SettingsTabGroupId>>(
    () => new Set()
  );

  // ModelSettings Provider 表单的 staged-dirty 上报（契约见文件头注释）
  const [modelFormDirty, setModelFormDirty] = useState(false);
  // dirty 时被拦下的导航动作（切 tab / 关闭），确认「丢弃修改」后执行
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);

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

  // dirty 拦截统一入口：ModelSettings dirty 时先弹确认，否则直接执行。
  // 注意要包一层惰性函数，setPendingNavigation(() => action) 才能存函数而非调用结果。
  const guardWhileModelDirty = useCallback((action: () => void) => {
    if (modelFormDirty) {
      setPendingNavigation(() => action);
      return;
    }
    action();
  }, [modelFormDirty]);

  const handleDiscardChanges = useCallback(() => {
    const pending = pendingNavigation;
    setPendingNavigation(null);
    // ModelSettings 随 tab 切换 unmount，其 cleanup 会把 dirty 复位
    pending?.();
  }, [pendingNavigation]);

  // 搜到的条目落点未必还在设置页（自动化 / 能力中心那几项已搬走），交给同一个判定函数分流
  const handleSearchNavigate = useCallback((tab: SettingsTab) => {
    guardWhileModelDirty(() => {
      if (resolveSettingsDeepLink(tab).kind !== 'settings') {
        openSettingsTab(tab);
        return;
      }
      setActiveTab(tab);
    });
  }, [guardWhileModelDirty, openSettingsTab]);

  const handleClose = useCallback(() => {
    guardWhileModelDirty(() => setShowSettings(false));
  }, [guardWhileModelDirty, setShowSettings]);

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
      aria-label={t.settings.title}
      testId="settings-panel"
      variant="overlay"
      className="overflow-hidden animate-fadeIn"
    >
      <div className="flex h-full min-h-0">
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/95">
          {/* 整窗覆盖后侧栏/顶栏都被盖住，本行顶起拖拽区（控件逐个 no-drag，
              同 TitleBar 套路），不然设置打开期间窗口拖不动 */}
          <div
            data-tauri-drag-region
            className="px-4 pb-3 pt-5"
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <button
                type="button"
                onClick={handleClose}
                className="mb-5 inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 focus:outline-hidden"
              >
                <ChevronLeft className="h-4 w-4" />
                <span>{t.settings.backToApp}</span>
              </button>
              <SettingsSearch onNavigate={handleSearchNavigate} access={accessSubject} />
            </div>
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
                      onClick={() => {
                        if (tab.id === activeTab) return;
                        guardWhileModelDirty(() => setActiveTab(tab.id));
                      }}
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
                      {tab.id === 'model' && modelFormDirty && (
                        <span className="shrink-0 rounded border border-badge-warning/30 bg-amber-500/10 px-1 text-[10px] text-badge-warning">
                          {t.settings.unsavedChanges.badge}
                        </span>
                      )}
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
          <div className={`mx-auto min-h-full px-8 pb-16 pt-8 ${contentWidthClass}`}>
            {/* 页顶标题行即窗口拖拽区（二级页在位时右侧 TitleBar 不渲染）：
                ="deep" 让整行可拖、双击缩放；X 关闭钮是 button，Tauri 自动豁免 */}
            <div data-tauri-drag-region="deep" className="mb-6 flex items-start justify-between gap-6">
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
              <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <IconButton
                  icon={<X className="h-5 w-5" />}
                  aria-label={t.common.close}
                  onClick={handleClose}
                  variant="ghost"
                  size="lg"
                />
              </div>
            </div>

            <React.Suspense fallback={<SettingsTabSkeleton />}>
              {activeTab === 'general' && <GeneralSettings />}
              {activeTab === 'doctor' && <DoctorSettings />}
              {activeTab === 'conversation' && <ConversationSettings />}
              {activeTab === 'search' && <SearchSettings />}
              {activeTab === 'voiceLive' && <VoiceLiveSettings />}
              {activeTab === 'voiceInput' && <VoiceInputSettings />}
              {activeTab === 'voiceModel' && <VoiceModelSettings />}
              {activeTab === 'keybindings' && <KeybindingsSettings />}
              {activeTab === 'workspace' && <WorkspaceSettings />}
              {activeTab === 'appshots' && <AppshotsSettings />}
              {activeTab === 'model' && (
                <ModelSettings config={modelConfig} onChange={setModelConfig} onDirtyChange={setModelFormDirty} />
              )}
              {activeTab === 'visualModels' && <VisualModelsSettings />}
              {activeTab === 'agentEngine' && <AgentEngineSettings />}
              {activeTab === 'appearance' && <AppearanceSettings />}
              {activeTab === 'soul' && <SoulSettings />}
              {activeTab === 'cache' && <DataSettings />}
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
            </React.Suspense>
          </div>
        </main>
      </div>

      {/* 未保存修改拦截：丢弃 = 执行被拦下的导航，继续编辑 = 留在当前 tab */}
      <ConfirmDialog
        isOpen={pendingNavigation !== null}
        variant="warning"
        title={t.settings.unsavedChanges.title}
        message={t.settings.unsavedChanges.message}
        confirmText={t.settings.unsavedChanges.discard}
        cancelText={t.settings.unsavedChanges.stay}
        onConfirm={handleDiscardChanges}
        onCancel={() => setPendingNavigation(null)}
      />

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
