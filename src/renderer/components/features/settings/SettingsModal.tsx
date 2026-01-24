// ============================================================================
// SettingsModal - 设置模态框 (侧边栏 Tab 切换布局)
// ============================================================================

import React, { useState, useEffect } from 'react';
import { X, Settings, Cpu, Server, Database, Info } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { useI18n } from '../../../hooks/useI18n';
import { IconButton } from '../../primitives';
import { UpdateNotification } from '../../UpdateNotification';
import { IPC_CHANNELS } from '@shared/ipc';
import type { UpdateInfo } from '@shared/types';
import { createLogger } from '../../../utils/logger';

// Section Components
import { GeneralSection } from './sections/GeneralSection';
import { ModelSection } from './sections/ModelSection';
import { ServiceSection } from './sections/ServiceSection';
import { DataSection } from './sections/DataSection';
import { AboutSection } from './sections/AboutSection';

const logger = createLogger('SettingsModal');

// ============================================================================
// Types
// ============================================================================

type SectionId = 'general' | 'model' | 'service' | 'data' | 'about';

interface Section {
  id: SectionId;
  label: string;
  icon: React.ReactNode;
  badge?: boolean;
}

// ============================================================================
// Main Component
// ============================================================================

export const SettingsModal: React.FC = () => {
  const { setShowSettings, modelConfig, setModelConfig } = useAppStore();
  const { signOut, isAuthenticated } = useAuthStore();
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<SectionId>('general');

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

  const sections: Section[] = [
    {
      id: 'general',
      label: t.settings?.tabs?.general || '通用',
      icon: <Settings className="w-4 h-4" />
    },
    {
      id: 'model',
      label: t.settings?.tabs?.model || '模型',
      icon: <Cpu className="w-4 h-4" />
    },
    {
      id: 'service',
      label: '服务',
      icon: <Server className="w-4 h-4" />
    },
    {
      id: 'data',
      label: t.settings?.tabs?.data || '数据',
      icon: <Database className="w-4 h-4" />
    },
    {
      id: 'about',
      label: t.settings?.tabs?.about || '关于',
      icon: <Info className="w-4 h-4" />,
      badge: optionalUpdateInfo?.hasUpdate,
    },
  ];

  const renderContent = () => {
    switch (activeSection) {
      case 'general':
        return <GeneralSection />;
      case 'model':
        return <ModelSection config={modelConfig} onChange={setModelConfig} />;
      case 'service':
        return <ServiceSection />;
      case 'data':
        return <DataSection />;
      case 'about':
        return (
          <AboutSection
            updateInfo={optionalUpdateInfo}
            onUpdateInfoChange={setOptionalUpdateInfo}
            onShowUpdateModal={() => setShowUpdateModal(true)}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setShowSettings(false)}
      />

      {/* Modal */}
      <div className="relative w-full max-w-2xl max-h-[85vh] bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl overflow-hidden animate-fadeIn flex">
        {/* Sidebar */}
        <div className="w-44 border-r border-zinc-800 bg-zinc-900/50 flex flex-col shrink-0">
          {/* Header */}
          <div className="px-4 py-4 border-b border-zinc-800">
            <h2 className="text-base font-semibold text-zinc-100">{t.settings?.title || '设置'}</h2>
          </div>

          {/* Tab List */}
          <div className="flex-1 py-2 px-2 space-y-1">
            {sections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeSection === section.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                }`}
              >
                <span className={activeSection === section.id ? 'text-primary-400' : ''}>
                  {section.icon}
                </span>
                <span className="flex-1 text-left">{section.label}</span>
                {section.badge && (
                  <span className="w-2 h-2 rounded-full bg-primary-500 animate-pulse" />
                )}
              </button>
            ))}
          </div>

          {/* Bottom: Logout */}
          {isAuthenticated && (
            <div className="px-2 py-3 border-t border-zinc-800">
              <button
                onClick={() => {
                  signOut();
                  setShowSettings(false);
                }}
                className="w-full px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 rounded-lg transition-colors text-left"
              >
                退出登录
              </button>
            </div>
          )}
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Content Header with Close Button */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
            <h3 className="text-sm font-medium text-zinc-300">
              {sections.find(s => s.id === activeSection)?.label}
            </h3>
            <IconButton
              icon={<X className="w-5 h-5" />}
              aria-label="Close settings"
              onClick={() => setShowSettings(false)}
              variant="default"
              size="md"
            />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {renderContent()}
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
