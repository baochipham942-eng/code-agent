// ============================================================================
// DisclosureSettings - Progressive Disclosure Settings Tab
// ============================================================================

import React from 'react';
import { Eye, EyeOff, Sparkles, Zap } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { IPC_CHANNELS } from '@shared/ipc';
import type { DisclosureLevel } from '../../../../stores/appStore';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('DisclosureSettings');

// ============================================================================
// Types
// ============================================================================

export interface DisclosureSettingsProps {
  level: DisclosureLevel;
  onChange: (level: DisclosureLevel) => void;
}

// ============================================================================
// Component
// ============================================================================

export const DisclosureSettings: React.FC<DisclosureSettingsProps> = ({ level, onChange }) => {
  const { t } = useI18n();

  // Handle disclosure level change and persist to backend
  const handleLevelChange = async (newLevel: DisclosureLevel) => {
    onChange(newLevel);
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        ui: { disclosureLevel: newLevel },
      } as Partial<import('@shared/types').AppSettings>);
      logger.info('Disclosure level saved', { level: newLevel });
    } catch (error) {
      logger.error('Failed to save disclosure level', error);
    }
  };

  const levels: {
    id: DisclosureLevel;
    name: string;
    description: string;
    icon: React.ReactNode;
    features: string[];
  }[] = [
    {
      id: 'simple',
      name: t.disclosure.levels.simple.name,
      description: t.disclosure.levels.simple.description,
      icon: <EyeOff className="w-5 h-5" />,
      features: t.disclosure.levels.simple.features,
    },
    {
      id: 'standard',
      name: t.disclosure.levels.standard.name,
      description: t.disclosure.levels.standard.description,
      icon: <Eye className="w-5 h-5" />,
      features: t.disclosure.levels.standard.features,
    },
    {
      id: 'advanced',
      name: t.disclosure.levels.advanced.name,
      description: t.disclosure.levels.advanced.description,
      icon: <Sparkles className="w-5 h-5" />,
      features: t.disclosure.levels.advanced.features,
    },
    {
      id: 'expert',
      name: t.disclosure.levels.expert.name,
      description: t.disclosure.levels.expert.description,
      icon: <Zap className="w-5 h-5" />,
      features: t.disclosure.levels.expert.features,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">{t.disclosure.title}</h3>
        <p className="text-xs text-zinc-400 mb-4">
          {t.disclosure.description}
        </p>
      </div>

      {/* Disclosure Level Selection */}
      <div className="space-y-3">
        {levels.map((item) => (
          <button
            key={item.id}
            onClick={() => handleLevelChange(item.id)}
            className={`w-full p-4 rounded-lg border text-left transition-all ${
              level === item.id
                ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/50'
                : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/50'
            }`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`p-2 rounded-lg ${
                  level === item.id ? 'bg-blue-500/20 text-blue-400' : 'bg-zinc-800 text-zinc-400'
                }`}
              >
                {item.icon}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-100">{item.name}</span>
                  {level === item.id && (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400">
                      {t.common.active}
                    </span>
                  )}
                </div>
                <p className="text-sm text-zinc-400 mt-0.5">{item.description}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {item.features.map((feature) => (
                    <span
                      key={feature}
                      className={`px-2 py-0.5 text-xs rounded ${
                        level === item.id
                          ? 'bg-zinc-800 text-zinc-300'
                          : 'bg-zinc-800/50 text-zinc-500'
                      }`}
                    >
                      {feature}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Why This Matters */}
      <div className="bg-zinc-800/50 rounded-lg p-4 mt-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">{t.disclosure.whyTitle}</h4>
        <p className="text-xs text-zinc-400 leading-relaxed">
          {t.disclosure.whyDescription}
        </p>
      </div>
    </div>
  );
};
