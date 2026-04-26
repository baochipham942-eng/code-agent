// ============================================================================
// SettingsModal - Main Settings Modal Entry Point
// Layout + Tab Switching
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { X, Cpu, Palette, Info, Database, Download, Plug, Settings, Brain, Sparkles, Eye, GitBranch } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { IconButton } from '../../primitives';
import { UpdateNotification } from '../../UpdateNotification';
import { IPC_DOMAINS } from '@shared/ipc';
import type { UpdateInfo } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { isDesktopShellMode, isTauriMode } from '../../../utils/platform';
import { SettingsSearch } from './SettingsSearch';
import type { SettingsTab as SearchSettingsTab } from '../../../utils/settingsIndex';
import { tauriCheckForUpdate } from '../../../utils/tauriUpdater';

const logger = createLogger('SettingsModal');

// Tab Components
import { GeneralSettings } from './tabs/GeneralSettings';
import { ConversationSettings } from './tabs/ConversationSettings';
import { ModelSettings } from './tabs/ModelSettings';
import { AppearanceSettings } from './tabs/AppearanceSettings';
import { DataSettings } from './tabs/DataSettings';
import { UpdateSettings } from './tabs/UpdateSettings';
import { MCPSettings } from './tabs/MCPSettings';
import { MemoryTab } from './tabs/MemoryTab';
import { SkillsSettings } from './tabs/SkillsSettings';
import { ChannelsSettings } from './tabs/ChannelsSettings';
import { AboutSettings } from './tabs/AboutSettings';
import { ScreenMemorySettings } from './tabs/ScreenMemorySettings';
import ipcService from '../../../services/ipcService';

// ============================================================================
// Types
// ============================================================================

type SettingsTab = 'general' | 'conversation' | 'model' | 'appearance' | 'cache' | 'mcp' | 'skills' | 'channels' | 'memory' | 'openchronicle' | 'update' | 'about';

interface SettingsTabConfig {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
  badge?: boolean;
}

interface BuildSettingsTabsOptions {
  t: ReturnType<typeof useI18n>['t'];
  showScreenMemoryTab: boolean;
  showUpdateTab: boolean;
  hasOptionalUpdate: boolean;
}

export function buildSettingsTabs({
  t,
  showScreenMemoryTab,
  showUpdateTab,
  hasOptionalUpdate,
}: BuildSettingsTabsOptions): SettingsTabConfig[] {
  return [
    { id: 'general', label: t.settings.tabs.general || '通用', icon: <Settings className="w-4 h-4" /> },
    { id: 'conversation', label: '对话', icon: <GitBranch className="w-4 h-4" /> },
    { id: 'model', label: t.settings.tabs.model, icon: <Cpu className="w-4 h-4" /> },
    { id: 'appearance', label: t.settings.tabs.appearance, icon: <Palette className="w-4 h-4" /> },
    { id: 'cache', label: t.settings.tabs.data || '数据', icon: <Database className="w-4 h-4" /> },
    { id: 'mcp', label: 'MCP', icon: <Plug className="w-4 h-4" /> },
    { id: 'skills', label: 'Skills', icon: <Sparkles className="w-4 h-4" /> },
    { id: 'channels', label: '通道', icon: <Settings className="w-4 h-4" /> },
    { id: 'memory', label: t.settings?.tabs?.memory || '记忆', icon: <Brain className="w-4 h-4" /> },
    ...(showScreenMemoryTab ? [{ id: 'openchronicle' as const, label: '屏幕记忆', icon: <Eye className="w-4 h-4" /> }] : []),
    ...(showUpdateTab ? [{ id: 'update' as const, label: t.settings.tabs.update || '更新', icon: <Download className="w-4 h-4" />, badge: hasOptionalUpdate }] : []),
    { id: 'about', label: t.settings.tabs.about, icon: <Info className="w-4 h-4" /> },
  ];
}

// ============================================================================
// Component
// ============================================================================

export const SettingsModal: React.FC = () => {
  const { setShowSettings, modelConfig, setModelConfig } = useAppStore();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  const handleSearchNavigate = useCallback((tab: SearchSettingsTab) => {
    setActiveTab(tab as SettingsTab);
  }, []);

  // Optional update state
  const [optionalUpdateInfo, setOptionalUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  // Check for updates on mount (for badge display)
  useEffect(() => {
    if (!isDesktopShellMode()) return;

    const checkUpdate = async () => {
      try {
        const info = isTauriMode()
          ? await tauriCheckForUpdate()
          : await ipcService.invokeDomain<UpdateInfo>(IPC_DOMAINS.UPDATE, 'check');
        // Only handle non-force updates here
        if (info?.hasUpdate && !info?.forceUpdate) {
          setOptionalUpdateInfo(info);
        }
      } catch (error) {
        logger.error('Failed to check update', error);
      }
    };
    checkUpdate();
  }, []);

  const showUpdateTab = isDesktopShellMode();
  const tabs = buildSettingsTabs({
    t,
    showScreenMemoryTab: isDesktopShellMode(),
    showUpdateTab,
    hasOptionalUpdate: !!optionalUpdateInfo?.hasUpdate,
  });
  const isScreenMemoryTab = activeTab === 'openchronicle';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setShowSettings(false)}
      />

      {/* Modal */}
      <div className={`relative w-full max-h-[88vh] bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl overflow-hidden animate-fadeIn ${isScreenMemoryTab ? 'max-w-5xl' : 'max-w-2xl'}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700">
          <h2 className="text-lg font-semibold text-zinc-200">{t.settings.title}</h2>
          <IconButton
            icon={<X className="w-5 h-5" />}
            aria-label="Close settings"
            onClick={() => setShowSettings(false)}
            variant="default"
            size="md"
          />
        </div>

        <div className={isScreenMemoryTab ? 'flex h-[72vh] min-h-[560px]' : 'flex h-[500px]'}>
          {/* Sidebar */}
          <div className="w-48 border-r border-zinc-700 p-2 flex flex-col gap-2">
            <SettingsSearch onNavigate={handleSearchNavigate} />
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                  activeTab === tab.id
                    ? 'bg-zinc-700 text-zinc-200'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                {tab.icon}
                <span className="text-sm flex-1">{tab.label}</span>
                {tab.badge && (
                  <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className={`flex-1 overflow-y-auto ${isScreenMemoryTab ? 'p-5' : 'p-6'}`}>
            {activeTab === 'general' && <GeneralSettings />}
            {activeTab === 'conversation' && <ConversationSettings />}
            {activeTab === 'model' && (
              <ModelSettings config={modelConfig} onChange={setModelConfig} />
            )}
            {activeTab === 'appearance' && <AppearanceSettings />}
            {activeTab === 'cache' && <DataSettings />}
            {activeTab === 'mcp' && <MCPSettings />}
            {activeTab === 'skills' && <SkillsSettings />}
            {activeTab === 'channels' && <ChannelsSettings />}
            {activeTab === 'memory' && <MemoryTab />}
            {activeTab === 'openchronicle' && <ScreenMemorySettings />}
            {showUpdateTab && activeTab === 'update' && (
              <UpdateSettings
                updateInfo={optionalUpdateInfo}
                onUpdateInfoChange={setOptionalUpdateInfo}
                onShowUpdateModal={() => setShowUpdateModal(true)}
              />
            )}
            {activeTab === 'about' && <AboutSettings />}
          </div>
        </div>
      </div>

      {/* Optional Update Modal */}
      {isDesktopShellMode() && !isTauriMode() && showUpdateModal && optionalUpdateInfo && (
        <UpdateNotification
          updateInfo={optionalUpdateInfo}
          onClose={() => setShowUpdateModal(false)}
        />
      )}
    </div>
  );
};
