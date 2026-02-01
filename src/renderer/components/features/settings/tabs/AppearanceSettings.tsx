// ============================================================================
// AppearanceSettings - Theme, Font & Language Settings Tab
// ============================================================================

import React from 'react';
import { useI18n, type Language } from '../../../../hooks/useI18n';
import { IPC_CHANNELS } from '@shared/ipc';
import { Select } from '../../../primitives';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('AppearanceSettings');

// ============================================================================
// Component
// ============================================================================

export const AppearanceSettings: React.FC = () => {
  const { t, language, setLanguage, availableLanguages } = useI18n();

  const handleLanguageChange = async (lang: Language) => {
    setLanguage(lang);
    // Persist to backend
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        ui: { language: lang },
      } as Partial<import('@shared/types').AppSettings>);
      logger.info('Language saved', { lang });
    } catch (error) {
      logger.error('Failed to save language', error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Theme Selection */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-4">{t.appearance.theme}</h3>
        <div className="grid grid-cols-3 gap-3">
          {/* Dark Theme - Active */}
          <button className="p-3 rounded-lg border border-blue-500 bg-blue-500/10">
            <div className="w-full h-16 rounded bg-zinc-900 border border-zinc-700 mb-2" />
            <div className="text-sm text-zinc-100">{t.appearance.themes.dark}</div>
          </button>

          {/* Light Theme - Coming Soon */}
          <button className="p-3 rounded-lg border border-zinc-700 opacity-50 cursor-not-allowed">
            <div className="w-full h-16 rounded bg-white border border-zinc-300 mb-2" />
            <div className="text-sm text-zinc-400">{t.appearance.themes.light} ({t.common.coming})</div>
          </button>

          {/* Auto Theme - Coming Soon */}
          <button className="p-3 rounded-lg border border-zinc-700 opacity-50 cursor-not-allowed">
            <div className="w-full h-16 rounded bg-gradient-to-b from-white to-zinc-900 border border-zinc-500 mb-2" />
            <div className="text-sm text-zinc-400">{t.appearance.themes.auto} ({t.common.coming})</div>
          </button>
        </div>
      </div>

      {/* Font Size */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-4">{t.appearance.fontSize}</h3>
        <Select>
          <option value="small">{t.appearance.fontSizes.small}</option>
          <option value="medium">{t.appearance.fontSizes.medium}</option>
          <option value="large">{t.appearance.fontSizes.large}</option>
        </Select>
      </div>

      {/* Language Selection */}
      <div className="pt-4 border-t border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-100 mb-2">{t.language.title}</h3>
        <p className="text-xs text-zinc-400 mb-4">
          {t.language.description}
        </p>
        <div className="space-y-2">
          {availableLanguages.map((lang) => (
            <button
              key={lang.code}
              onClick={() => handleLanguageChange(lang.code as Language)}
              className={`w-full p-3 rounded-lg border text-left transition-all ${
                language === lang.code
                  ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/50'
                  : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-medium ${
                      language === lang.code
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >
                    {lang.code === 'zh' ? '中' : 'En'}
                  </div>
                  <div>
                    <div className="font-medium text-zinc-100 text-sm">{lang.native}</div>
                    <div className="text-xs text-zinc-400">{lang.name}</div>
                  </div>
                </div>
                {language === lang.code && (
                  <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400">
                    {t.common.active}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
