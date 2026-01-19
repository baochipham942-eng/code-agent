// ============================================================================
// LanguageSettings - Language Selection Tab
// ============================================================================

import React from 'react';
import { useI18n, type Language } from '../../../../hooks/useI18n';
import { IPC_CHANNELS } from '@shared/ipc';

// ============================================================================
// Component
// ============================================================================

export const LanguageSettings: React.FC = () => {
  const { t, language, setLanguage, availableLanguages } = useI18n();

  const handleLanguageChange = async (lang: Language) => {
    setLanguage(lang);
    // Persist to backend
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        ui: { language: lang },
      } as any);
      console.log('[LanguageSettings] Language saved:', lang);
    } catch (error) {
      console.error('[LanguageSettings] Failed to save language:', error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">{t.language.title}</h3>
        <p className="text-xs text-zinc-400 mb-4">
          {t.language.description}
        </p>
      </div>

      {/* Language Selection */}
      <div className="space-y-3">
        {availableLanguages.map((lang) => (
          <button
            key={lang.code}
            onClick={() => handleLanguageChange(lang.code as Language)}
            className={`w-full p-4 rounded-lg border text-left transition-all ${
              language === lang.code
                ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/50'
                : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/50'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center text-lg font-medium ${
                    language === lang.code
                      ? 'bg-blue-500/20 text-blue-400'
                      : 'bg-zinc-800 text-zinc-400'
                  }`}
                >
                  {lang.code === 'zh' ? '中' : 'En'}
                </div>
                <div>
                  <div className="font-medium text-zinc-100">{lang.native}</div>
                  <div className="text-sm text-zinc-400">{lang.name}</div>
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
  );
};
