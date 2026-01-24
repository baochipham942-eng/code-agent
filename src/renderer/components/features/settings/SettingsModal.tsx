// ============================================================================
// SettingsModal - 设置模态框 (重构版)
// 5 分组手风琴布局，去除侧边栏 Tab 切换
// ============================================================================

import React, { useState, useEffect } from 'react';
import { X, ChevronDown, Settings, Cpu, Server, Database, Info } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
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
// Accordion Section Component
// ============================================================================

interface AccordionSectionProps {
  section: Section;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const AccordionSection: React.FC<AccordionSectionProps> = ({
  section,
  isOpen,
  onToggle,
  children,
}) => {
  return (
    <div className="border-b border-zinc-800/50 last:border-b-0">
      {/* Header */}
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-6 py-4 text-left transition-colors hover:bg-zinc-800/30 ${
          isOpen ? 'bg-zinc-800/20' : ''
        }`}
      >
        <div className="flex items-center gap-3">
          <span className={`transition-colors ${isOpen ? 'text-teal-400' : 'text-zinc-400'}`}>
            {section.icon}
          </span>
          <span className={`text-sm font-medium ${isOpen ? 'text-zinc-100' : 'text-zinc-300'}`}>
            {section.label}
          </span>
          {section.badge && (
            <span className="w-2 h-2 rounded-full bg-teal-500 animate-pulse" />
          )}
        </div>
        <ChevronDown
          className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Content */}
      <div
        className={`overflow-hidden transition-all duration-200 ease-out ${
          isOpen ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="px-6 py-4 bg-zinc-900/30">
          {children}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const SettingsModal: React.FC = () => {
  const { setShowSettings, modelConfig, setModelConfig, disclosureLevel, setDisclosureLevel } = useAppStore();
  const { t } = useI18n();
  const [openSection, setOpenSection] = useState<SectionId>('general');

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

  const handleToggle = (sectionId: SectionId) => {
    setOpenSection(openSection === sectionId ? sectionId : sectionId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setShowSettings(false)}
      />

      {/* Modal */}
      <div className="relative w-full max-w-xl max-h-[85vh] bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl overflow-hidden animate-fadeIn flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
          <h2 className="text-lg font-semibold text-zinc-100">{t.settings?.title || '设置'}</h2>
          <IconButton
            icon={<X className="w-5 h-5" />}
            aria-label="Close settings"
            onClick={() => setShowSettings(false)}
            variant="default"
            size="md"
          />
        </div>

        {/* Accordion Content */}
        <div className="flex-1 overflow-y-auto">
          {sections.map((section) => (
            <AccordionSection
              key={section.id}
              section={section}
              isOpen={openSection === section.id}
              onToggle={() => handleToggle(section.id)}
            >
              {section.id === 'general' && (
                <GeneralSection />
              )}
              {section.id === 'model' && (
                <ModelSection config={modelConfig} onChange={setModelConfig} />
              )}
              {section.id === 'service' && (
                <ServiceSection />
              )}
              {section.id === 'data' && (
                <DataSection />
              )}
              {section.id === 'about' && (
                <AboutSection
                  updateInfo={optionalUpdateInfo}
                  onUpdateInfoChange={setOptionalUpdateInfo}
                  onShowUpdateModal={() => setShowUpdateModal(true)}
                />
              )}
            </AccordionSection>
          ))}
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
