// ============================================================================
// AppearanceSettings - Theme, Font & Language Settings Tab
// 支持深色/浅色/自动主题切换
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Moon, Sun, Monitor, Check } from 'lucide-react';
import { useI18n, type Language } from '../../../../hooks/useI18n';
import { useTheme, type Theme } from '../../../../hooks/useTheme';
import { toast } from '../../../../hooks/useToast';
import { useAppStore } from '../../../../stores/appStore';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { createLogger } from '../../../../utils/logger';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';

const logger = createLogger('AppearanceSettings');

// ============================================================================
// Types
// ============================================================================

interface ThemeOption {
  id: Theme;
  label: string;
  icon: React.ReactNode;
  description: string;
  preview: React.ReactNode;
}

function getFontSizeName(fontSize: number): 'small' | 'medium' | 'large' | null {
  switch (fontSize) {
    case 13:
      return 'small';
    case 14:
      return 'medium';
    case 16:
      return 'large';
    default:
      return null;
  }
}

// ============================================================================
// Component
// ============================================================================

export const AppearanceSettings: React.FC = () => {
  const { t, language, setLanguage, availableLanguages } = useI18n();
  const appearanceText = t.settings.appearance;
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [fontSize, setFontSize] = useState<'small' | 'medium' | 'large'>('medium');
  const developerMode = useAppStore((state) => state.developerMode);
  const setDeveloperMode = useAppStore((state) => state.setDeveloperMode);

  // 加载已保存的字体大小
  useEffect(() => {
    const loadFontSize = async () => {
      try {
        const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
        if (settings?.ui?.fontSize) {
          const size = getFontSizeName(settings.ui.fontSize);
          if (size) setFontSize(size);
        }
      } catch (error) {
        logger.error('Failed to load font size', error);
      }
    };
    loadFontSize();
  }, []);

  // 主题选项
  const themeOptions: ThemeOption[] = [
    {
      id: 'dark',
      label: appearanceText.themes.dark,
      icon: <Moon className="w-4 h-4" />,
      description: appearanceText.themeDescriptions.dark,
      preview: (
        <div className="w-full h-16 rounded bg-zinc-900 border border-zinc-700 flex items-center justify-center">
          <div className="w-8 h-3 bg-zinc-600 rounded" />
        </div>
      ),
    },
    {
      id: 'light',
      label: appearanceText.themes.light,
      icon: <Sun className="w-4 h-4" />,
      description: appearanceText.themeDescriptions.light,
      preview: (
        <div className="w-full h-16 rounded bg-white border border-zinc-700 flex items-center justify-center">
          <div className="w-8 h-3 bg-zinc-700 rounded" />
        </div>
      ),
    },
    {
      id: 'system',
      label: appearanceText.themes.auto,
      icon: <Monitor className="w-4 h-4" />,
      description: appearanceText.themeDescriptions.system,
      preview: (
        <div className="w-full h-16 rounded bg-gradient-to-r from-white to-zinc-900 border border-zinc-600 flex items-center justify-center">
          <div className="w-8 h-3 bg-zinc-600 rounded" />
        </div>
      ),
    },
  ];

  // 处理主题切换
  const handleThemeChange = async (newTheme: Theme) => {
    const previousTheme = theme;
    setTheme(newTheme);
    // 保存到后端
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        ui: { theme: newTheme },
      } as Partial<import('@shared/contract').AppSettings>);
      logger.info('Theme saved', { theme: newTheme });
    } catch (error) {
      logger.error('Failed to save theme', error);
      setTheme(previousTheme);
      toast.error('主题保存失败，已恢复原设置');
    }
  };

  // 处理语言切换
  const handleLanguageChange = async (lang: Language) => {
    const previousLanguage = language;
    setLanguage(lang);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        ui: { language: lang },
      } as Partial<import('@shared/contract').AppSettings>);
      logger.info('Language saved', { lang });
    } catch (error) {
      logger.error('Failed to save language', error);
      setLanguage(previousLanguage);
      toast.error('语言保存失败，已恢复原设置');
    }
  };

  // 处理开发者模式开关
  const handleDeveloperModeChange = async (enabled: boolean) => {
    const previousDeveloperMode = developerMode;
    setDeveloperMode(enabled);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        ui: { developerMode: enabled },
      } as Partial<AppSettings>);
      logger.info('Developer mode saved', { enabled });
    } catch (error) {
      logger.error('Failed to save developer mode', error);
      setDeveloperMode(previousDeveloperMode);
      toast.error('开发者模式保存失败，已恢复原设置');
    }
  };

  // 处理字体大小切换
  const handleFontSizeChange = async (size: 'small' | 'medium' | 'large') => {
    const previousFontSize = fontSize;
    const previousCssFontSize = document.documentElement.style.getPropertyValue('--font-size-base');
    setFontSize(size);
    // 应用字体大小
    const sizeMap = { small: 13, medium: 14, large: 16 };
    document.documentElement.style.setProperty('--font-size-base', `${sizeMap[size]}px`);

    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        ui: { fontSize: sizeMap[size] },
      } as Partial<AppSettings>);
      logger.info('Font size saved', { size });
    } catch (error) {
      logger.error('Failed to save font size', error);
      setFontSize(previousFontSize);
      if (previousCssFontSize) {
        document.documentElement.style.setProperty('--font-size-base', previousCssFontSize);
      } else {
        document.documentElement.style.removeProperty('--font-size-base');
      }
      toast.error('字体大小保存失败，已恢复原设置');
    }
  };

  return (
    <div className="space-y-6">
      <WebModeBanner />
      {/* Theme Selection */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-2">{appearanceText.theme}</h3>
        <p className="text-xs text-zinc-500 mb-4">
          {appearanceText.themeDescription}
        </p>
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map((option) => {
            const isActive = theme === option.id;

            return (
              <button
                key={option.id}
                disabled={isWebMode()}
                onClick={() => handleThemeChange(option.id)}
                className={`relative p-3 rounded-lg border text-left transition-all ${
                  isActive
                    ? 'border-zinc-500 bg-zinc-800/60 ring-1 ring-white/10'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                {/* Preview */}
                <div className="mb-2">{option.preview}</div>

                {/* Label */}
                <div className="flex items-center gap-2">
                  <span className={isActive ? 'text-zinc-200' : 'text-zinc-400'}>
                    {option.icon}
                  </span>
                  <span className={`text-sm ${isActive ? 'text-zinc-200' : 'text-zinc-400'}`}>
                    {option.label}
                  </span>
                </div>

                {/* Checkmark */}
                {isActive && (
                  <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-zinc-200 flex items-center justify-center">
                    <Check className="w-3 h-3 text-zinc-950" />
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Current theme indicator */}
        {theme === 'system' && (
          <p className="mt-2 text-xs text-zinc-500">
            {appearanceText.currentSystemThemePrefix}
            {resolvedTheme === 'dark' ? appearanceText.themes.dark : appearanceText.themes.light}
          </p>
        )}
      </div>

      {/* Font Size */}
      <div className="pt-4 border-t border-zinc-700">
        <h3 className="text-sm font-medium text-zinc-200 mb-2">{appearanceText.fontSize}</h3>
        <p className="text-xs text-zinc-500 mb-4">
          {appearanceText.fontSizeDescription}
        </p>
        <div className="grid grid-cols-3 gap-2">
          {([
            { id: 'small', label: appearanceText.fontSizes.small, size: '13px' },
            { id: 'medium', label: appearanceText.fontSizes.medium, size: '14px' },
            { id: 'large', label: appearanceText.fontSizes.large, size: '16px' },
          ] as const).map((option) => {
            const isActive = fontSize === option.id;

            return (
              <button
                key={option.id}
                disabled={isWebMode()}
                onClick={() => handleFontSizeChange(option.id)}
                className={`p-3 rounded-lg border text-center transition-all ${
                  isActive
                    ? 'border-zinc-500 bg-zinc-800/60'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                <span
                  className={`block ${isActive ? 'text-zinc-200' : 'text-zinc-400'}`}
                  style={{ fontSize: option.size }}
                >
                  Aa
                </span>
                <span className={`text-xs mt-1 ${isActive ? 'text-zinc-200' : 'text-zinc-500'}`}>
                  {option.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Language Selection */}
      <div className="pt-4 border-t border-zinc-700">
        <h3 className="text-sm font-medium text-zinc-200 mb-2">{appearanceText.languageTitle}</h3>
        <p className="text-xs text-zinc-400 mb-4">
          {appearanceText.languageDescription}
        </p>
        <div className="space-y-2">
          {availableLanguages.map((lang) => (
            <button
              key={lang.code}
              disabled={isWebMode()}
              onClick={() => handleLanguageChange(lang.code as Language)}
              className={`w-full p-3 rounded-lg border text-left transition-all ${
                language === lang.code
                  ? 'border-zinc-500 bg-zinc-800/60 ring-1 ring-white/10'
                  : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-medium ${
                      language === lang.code
                        ? 'bg-zinc-700 text-zinc-100'
                        : 'bg-zinc-700 text-zinc-400'
                    }`}
                  >
                    {lang.code === 'zh' ? appearanceText.languageBadges.zh : appearanceText.languageBadges.en}
                  </div>
                  <div>
                    <div className="font-medium text-zinc-200 text-sm">{lang.native}</div>
                    <div className="text-xs text-zinc-400">{lang.name}</div>
                  </div>
                </div>
                {language === lang.code && (
                  <span className="px-2 py-0.5 text-xs rounded-full bg-primary-500/20 text-primary-400">
                    {t.common.active}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Developer Mode */}
      <div className="pt-4 border-t border-zinc-700">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-1">{appearanceText.developerMode}</h3>
            <p className="text-xs text-zinc-500">{appearanceText.developerModeDesc}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={developerMode ? 'true' : 'false'}
            aria-label={appearanceText.developerMode}
            onClick={() => handleDeveloperModeChange(!developerMode)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
              developerMode ? 'bg-primary-500' : 'bg-zinc-700'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                developerMode ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
};
