// ============================================================================
// GeneralSection - 通用设置（主题、语言、字体大小）
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Sun, Moon, Monitor, Type } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Select } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('GeneralSection');

// ============================================================================
// Types
// ============================================================================

type ThemeMode = 'dark' | 'light' | 'system';
type FontSize = 'small' | 'medium' | 'large';

// ============================================================================
// Component
// ============================================================================

export const GeneralSection: React.FC = () => {
  const { t, language, setLanguage } = useI18n();
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [fontSize, setFontSize] = useState<FontSize>('medium');

  // Font size mapping
  const fontSizeMap: Record<FontSize, number> = {
    small: 12,
    medium: 14,
    large: 16,
  };

  const reverseFontSizeMap: Record<number, FontSize> = {
    12: 'small',
    14: 'medium',
    16: 'large',
  };

  // Load settings
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_GET);
        if (settings?.ui) {
          setTheme(settings.ui.theme || 'dark');
          setFontSize(reverseFontSizeMap[settings.ui.fontSize] || 'medium');
        }
      } catch (error) {
        logger.error('Failed to load settings', error);
      }
    };
    loadSettings();
  }, []);

  // Save theme (use type assertion for partial update)
  const handleThemeChange = async (newTheme: ThemeMode) => {
    setTheme(newTheme);
    try {
      // Backend merges partial updates
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        ui: { theme: newTheme }
      } as Record<string, unknown>);
    } catch (error) {
      logger.error('Failed to save theme', error);
    }
  };

  // Save font size (use type assertion for partial update)
  const handleFontSizeChange = async (size: FontSize) => {
    setFontSize(size);
    try {
      // Backend merges partial updates
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        ui: { fontSize: fontSizeMap[size] }
      } as Record<string, unknown>);
    } catch (error) {
      logger.error('Failed to save font size', error);
    }
  };

  // Save language
  const handleLanguageChange = (lang: string) => {
    setLanguage(lang as 'zh' | 'en');
  };

  const themes: { id: ThemeMode; label: string; icon: React.ReactNode; available: boolean }[] = [
    { id: 'dark', label: t.appearance?.themes?.dark || '深色', icon: <Moon className="w-4 h-4" />, available: true },
    { id: 'light', label: t.appearance?.themes?.light || '浅色', icon: <Sun className="w-4 h-4" />, available: false },
    { id: 'system', label: t.appearance?.themes?.auto || '跟随系统', icon: <Monitor className="w-4 h-4" />, available: false },
  ];

  return (
    <div className="space-y-6">
      {/* Theme Selection */}
      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-3">
          {t.appearance?.theme || '主题'}
        </label>
        <div className="flex gap-2">
          {themes.map((item) => (
            <button
              key={item.id}
              onClick={() => item.available && handleThemeChange(item.id)}
              disabled={!item.available}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border transition-all ${
                theme === item.id
                  ? 'border-teal-500/50 bg-teal-500/10 text-teal-400'
                  : item.available
                    ? 'border-zinc-700 hover:border-zinc-600 text-zinc-400 hover:text-zinc-300'
                    : 'border-zinc-800 text-zinc-600 cursor-not-allowed'
              }`}
            >
              {item.icon}
              <span className="text-sm">{item.label}</span>
              {!item.available && (
                <span className="text-xs text-zinc-600">Soon</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Language Selection */}
      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-3">
          {t.settings?.tabs?.language || '语言'}
        </label>
        <Select
          value={language}
          onChange={(e) => handleLanguageChange(e.target.value)}
        >
          <option value="zh">简体中文</option>
          <option value="en">English</option>
        </Select>
      </div>

      {/* Font Size */}
      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-3">
          <div className="flex items-center gap-2">
            <Type className="w-4 h-4 text-zinc-400" />
            {t.appearance?.fontSize || '字体大小'}
          </div>
        </label>
        <div className="flex gap-2">
          {(['small', 'medium', 'large'] as FontSize[]).map((size) => (
            <button
              key={size}
              onClick={() => handleFontSizeChange(size)}
              className={`flex-1 px-3 py-2 rounded-lg border text-sm transition-colors ${
                fontSize === size
                  ? 'border-teal-500/50 bg-teal-500/10 text-teal-400'
                  : 'border-zinc-700 hover:border-zinc-600 text-zinc-400 hover:text-zinc-300'
              }`}
            >
              {size === 'small' && (t.appearance?.fontSizes?.small || '小')}
              {size === 'medium' && (t.appearance?.fontSizes?.medium || '中')}
              {size === 'large' && (t.appearance?.fontSizes?.large || '大')}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
