// ============================================================================
// SettingsModal - Main Settings Modal Entry Point
// Layout + Tab Switching (~100 lines)
// ============================================================================

import React, { useState, useEffect } from 'react';
import { X, Cpu, Palette, Info, Layers, Database, Download, Cloud, Plug, Settings, Brain, Sparkles, Radio, Bot } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { IconButton } from '../../primitives';
import { UpdateNotification } from '../../UpdateNotification';
import { IPC_CHANNELS } from '@shared/ipc';
import type { UpdateInfo } from '@shared/types';
import { createLogger } from '../../../utils/logger';

const logger = createLogger('SettingsModal');

// Tab Components
import { GeneralSettings } from './tabs/GeneralSettings';
import { ModelSettings } from './tabs/ModelSettings';
import { DisclosureSettings } from './tabs/DisclosureSettings';
import { AppearanceSettings } from './tabs/AppearanceSettings';
import { DataSettings } from './tabs/DataSettings';
import { CloudSettings } from './tabs/CloudSettings';
import { UpdateSettings } from './tabs/UpdateSettings';
import { MCPSettings } from './tabs/MCPSettings';
import { MemoryTab } from './tabs/MemoryTab';
import { SkillsSettings } from './tabs/SkillsSettings';
import { ChannelsSettings } from './tabs/ChannelsSettings';
import { AgentsSettings } from './tabs/AgentsSettings';
import { AboutSettings } from './tabs/AboutSettings';

// ============================================================================
// Types
// ============================================================================

type SettingsTab = 'general' | 'model' | 'disclosure' | 'appearance' | 'cache' | 'cloud' | 'mcp' | 'skills' | 'channels' | 'agents' | 'memory' | 'update' | 'about';

// ============================================================================
// Component
// ============================================================================

export const SettingsModal: React.FC = () => {
  const { setShowSettings, modelConfig, setModelConfig, disclosureLevel, setDisclosureLevel } = useAppStore();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  // Optional update state
  const [optionalUpdateInfo, setOptionalUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  // Check for updates on mount (for badge display)
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const info = await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_CHECK);
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

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode; badge?: boolean }[] = [
    { id: 'general', label: t.settings.tabs.general || '通用', icon: <Settings className="w-4 h-4" /> },
    { id: 'model', label: t.settings.tabs.model, icon: <Cpu className="w-4 h-4" /> },
    { id: 'disclosure', label: t.settings.tabs.disclosure, icon: <Layers className="w-4 h-4" /> },
    { id: 'appearance', label: t.settings.tabs.appearance, icon: <Palette className="w-4 h-4" /> },
    { id: 'cache', label: t.settings.tabs.data || '数据', icon: <Database className="w-4 h-4" /> },
    { id: 'cloud', label: t.settings.tabs.cloud || '云端', icon: <Cloud className="w-4 h-4" /> },
    { id: 'mcp', label: 'MCP', icon: <Plug className="w-4 h-4" /> },
    { id: 'skills', label: 'Skills', icon: <Sparkles className="w-4 h-4" /> },
    { id: 'channels', label: '通道', icon: <Radio className="w-4 h-4" /> },
    { id: 'agents', label: 'Agents', icon: <Bot className="w-4 h-4" /> },
    { id: 'memory', label: t.settings?.tabs?.memory || '记忆', icon: <Brain className="w-4 h-4" /> },
    { id: 'update', label: t.settings.tabs.update || '更新', icon: <Download className="w-4 h-4" />, badge: optionalUpdateInfo?.hasUpdate },
    { id: 'about', label: t.settings.tabs.about, icon: <Info className="w-4 h-4" /> },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setShowSettings(false)}
      />

      {/* Modal */}
      <div className="relative w-full max-w-2xl max-h-[80vh] bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl overflow-hidden animate-fadeIn">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-100">{t.settings.title}</h2>
          <IconButton
            icon={<X className="w-5 h-5" />}
            aria-label="Close settings"
            onClick={() => setShowSettings(false)}
            variant="default"
            size="md"
          />
        </div>

        <div className="flex h-[500px]">
          {/* Sidebar */}
          <div className="w-48 border-r border-zinc-800 p-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                  activeTab === tab.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`}
              >
                {tab.icon}
                <span className="text-sm flex-1">{tab.label}</span>
                {/* Update badge */}
                {tab.badge && (
                  <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 p-6 overflow-y-auto">
            {activeTab === 'general' && <GeneralSettings />}
            {activeTab === 'model' && (
              <ModelSettings config={modelConfig} onChange={setModelConfig} />
            )}
            {activeTab === 'disclosure' && (
              <DisclosureSettings level={disclosureLevel} onChange={setDisclosureLevel} />
            )}
            {activeTab === 'appearance' && <AppearanceSettings />}
            {activeTab === 'cache' && <DataSettings />}
            {activeTab === 'cloud' && <CloudSettings />}
            {activeTab === 'mcp' && <MCPSettings />}
            {activeTab === 'skills' && <SkillsSettings />}
            {activeTab === 'channels' && <ChannelsSettings />}
            {activeTab === 'agents' && <AgentsSettings />}
            {activeTab === 'memory' && <MemoryTab />}
            {activeTab === 'update' && (
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
      {showUpdateModal && optionalUpdateInfo && (
        <UpdateNotification
          updateInfo={optionalUpdateInfo}
          onClose={() => setShowUpdateModal(false)}
        />
      )}
    </div>
  );
};
