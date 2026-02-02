// ============================================================================
// AppearanceSettings - Theme, Font & Language Settings Tab
// 支持深色/浅色/自动主题切换
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Moon, Sun, Monitor, Check } from 'lucide-react';
import { useI18n, type Language } from '../../../../hooks/useI18n';
import { useTheme, type Theme } from '../../../../hooks/useTheme';
import { IPC_CHANNELS } from '@shared/ipc';
import { Select } from '../../../primitives';
import { createLogger } from '../../../../utils/logger';

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

// ============================================================================
// Component
// ============================================================================

export const AppearanceSettings: React.FC = () => {
  const { t, language, setLanguage, availableLanguages } = useI18n();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [fontSize, setFontSize] = useState<'small' | 'medium' | 'large'>('medium');

  // 主题选项
  const themeOptions: ThemeOption[] = [
    {
      id: 'dark',
      label: t.appearance.themes.dark,
      icon: <Moon className="w-4 h-4" />,
      description: '深色背景，适合夜间使用',
      preview: (
        <div className="w-full h-16 rounded bg-zinc-900 border border-zinc-700 flex items-center justify-center">
          <div className="w-8 h-3 bg-zinc-700 rounded" />
        </div>
      ),
    },
    {
      id: 'light',
      label: t.appearance.themes.light,
      icon: <Sun className="w-4 h-4" />,
      description: '浅色背景，适合日间使用',
      preview: (
        <div className="w-full h-16 rounded bg-white border border-zinc-300 flex items-center justify-center">
          <div className="w-8 h-3 bg-zinc-200 rounded" />
        </div>
      ),
    },
    {
      id: 'system',
      label: t.appearance.themes.auto,
      icon: <Monitor className="w-4 h-4" />,
      description: '跟随系统设置自动切换',
      preview: (
        <div className="w-full h-16 rounded bg-gradient-to-r from-white to-zinc-900 border border-zinc-500 flex items-center justify-center">
          <div className="w-8 h-3 bg-zinc-500 rounded" />
        </div>
      ),
    },
  ];

  // 处理主题切换
  const handleThemeChange = async (newTheme: Theme) => {
    setTheme(newTheme);
    // 保存到后端
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        ui: { theme: newTheme },
      } as Partial<import('@shared/types').AppSettings>);
      logger.info('Theme saved', { theme: newTheme });
    } catch (error) {
      logger.error('Failed to save theme', error);
    }
  };

  // 处理语言切换
  const handleLanguageChange = async (lang: Language) => {
    setLanguage(lang);
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        ui: { language: lang },
      } as Partial<import('@shared/types').AppSettings>);
      logger.info('Language saved', { lang });
    } catch (error) {
      logger.error('Failed to save language', error);
    }
  };

  // 处理字体大小切换
  const handleFontSizeChange = async (size: 'small' | 'medium' | 'large') => {
    setFontSize(size);
    // 应用字体大小
    const sizeMap = { small: 13, medium: 14, large: 16 };
    document.documentElement.style.setProperty('--font-size-base', `${sizeMap[size]}px`);

    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        ui: { fontSize: sizeMap[size] },
      } as Partial<import('@shared/types').AppSettings>);
      logger.info('Font size saved', { size });
    } catch (error) {
      logger.error('Failed to save font size', error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Theme Selection */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">{t.appearance.theme}</h3>
        <p className="text-xs text-zinc-500 mb-4">
          选择你偏好的界面主题
        </p>
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map((option) => {
            const isActive = theme === option.id;

            return (
              <button
                key={option.id}
                onClick={() => handleThemeChange(option.id)}
                className={`relative p-3 rounded-lg border text-left transition-all ${
                  isActive
                    ? 'border-primary-500 bg-primary-500/10 ring-1 ring-primary-500/50'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/50'
                }`}
              >
                {/* Preview */}
                <div className="mb-2">{option.preview}</div>

                {/* Label */}
                <div className="flex items-center gap-2">
                  <span className={isActive ? 'text-primary-400' : 'text-zinc-400'}>
                    {option.icon}
                  </span>
                  <span className={`text-sm ${isActive ? 'text-zinc-100' : 'text-zinc-300'}`}>
                    {option.label}
                  </span>
                </div>

                {/* Checkmark */}
                {isActive && (
                  <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Current theme indicator */}
        {theme === 'system' && (
          <p className="mt-2 text-xs text-zinc-500">
            当前系统主题：{resolvedTheme === 'dark' ? '深色' : '浅色'}
          </p>
        )}
      </div>

      {/* Font Size */}
      <div className="pt-4 border-t border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-100 mb-2">{t.appearance.fontSize}</h3>
        <p className="text-xs text-zinc-500 mb-4">
          调整界面文字大小
        </p>
        <div className="grid grid-cols-3 gap-2">
          {([
            { id: 'small', label: t.appearance.fontSizes.small, size: '13px' },
            { id: 'medium', label: t.appearance.fontSizes.medium, size: '14px' },
            { id: 'large', label: t.appearance.fontSizes.large, size: '16px' },
          ] as const).map((option) => {
            const isActive = fontSize === option.id;

            return (
              <button
                key={option.id}
                onClick={() => handleFontSizeChange(option.id)}
                className={`p-3 rounded-lg border text-center transition-all ${
                  isActive
                    ? 'border-primary-500/50 bg-primary-500/10'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/50'
                }`}
              >
                <span
                  className={`block ${isActive ? 'text-zinc-100' : 'text-zinc-300'}`}
                  style={{ fontSize: option.size }}
                >
                  Aa
                </span>
                <span className={`text-xs mt-1 ${isActive ? 'text-primary-400' : 'text-zinc-500'}`}>
                  {option.label}
                </span>
              </button>
            );
          })}
        </div>
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
                  ? 'border-primary-500 bg-primary-500/10 ring-1 ring-primary-500/50'
                  : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-medium ${
                      language === lang.code
                        ? 'bg-primary-500/20 text-primary-400'
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
                  <span className="px-2 py-0.5 text-xs rounded-full bg-primary-500/20 text-primary-400">
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
