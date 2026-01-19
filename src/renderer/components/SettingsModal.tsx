// ============================================================================
// SettingsModal - Application Settings
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useAppStore, type DisclosureLevel } from '../stores/appStore';
import { useI18n, type Language } from '../hooks/useI18n';
import { X, Key, Cpu, Palette, Info, Layers, Eye, EyeOff, Sparkles, Zap, Globe, Database, Download, RefreshCw, CheckCircle, AlertCircle, Loader2, Cloud } from 'lucide-react';
import type { ModelProvider, UpdateInfo } from '@shared/types';
import { IPC_CHANNELS } from '@shared/ipc';
import { UpdateNotification } from './UpdateNotification';
import { DevModeConfirmModal } from './ConfirmModal';

type SettingsTab = 'model' | 'disclosure' | 'appearance' | 'language' | 'cache' | 'cloud' | 'update' | 'about';

export const SettingsModal: React.FC = () => {
  const { setShowSettings, modelConfig, setModelConfig, disclosureLevel, setDisclosureLevel } = useAppStore();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>('model');

  // 可选更新状态
  const [optionalUpdateInfo, setOptionalUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  // 启动时检查更新状态（用于显示徽章）
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const info = await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_CHECK);
        // 只有非强制更新才在这里处理
        if (info?.hasUpdate && !info?.forceUpdate) {
          setOptionalUpdateInfo(info);
        }
      } catch (error) {
        console.error('[SettingsModal] Failed to check update:', error);
      }
    };
    checkUpdate();
  }, []);

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode; badge?: boolean }[] = [
    { id: 'model', label: t.settings.tabs.model, icon: <Cpu className="w-4 h-4" /> },
    { id: 'disclosure', label: t.settings.tabs.disclosure, icon: <Layers className="w-4 h-4" /> },
    { id: 'appearance', label: t.settings.tabs.appearance, icon: <Palette className="w-4 h-4" /> },
    { id: 'language', label: t.settings.tabs.language, icon: <Globe className="w-4 h-4" /> },
    { id: 'cache', label: t.settings.tabs.data || '数据', icon: <Database className="w-4 h-4" /> },
    { id: 'cloud', label: t.settings.tabs.cloud || '云端', icon: <Cloud className="w-4 h-4" /> },
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
          <button
            onClick={() => setShowSettings(false)}
            className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
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
                {/* 更新徽章 */}
                {tab.badge && (
                  <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 p-6 overflow-y-auto">
            {activeTab === 'model' && (
              <ModelSettings config={modelConfig} onChange={setModelConfig} />
            )}
            {activeTab === 'disclosure' && (
              <DisclosureSettings level={disclosureLevel} onChange={setDisclosureLevel} />
            )}
            {activeTab === 'appearance' && <AppearanceSettings />}
            {activeTab === 'language' && <LanguageSettings />}
            {activeTab === 'cache' && <CacheSettings />}
            {activeTab === 'cloud' && <CloudConfigSettings />}
            {activeTab === 'update' && (
              <UpdateSettings
                updateInfo={optionalUpdateInfo}
                onUpdateInfoChange={setOptionalUpdateInfo}
                onShowUpdateModal={() => setShowUpdateModal(true)}
              />
            )}
            {activeTab === 'about' && <AboutSection />}
          </div>
        </div>
      </div>

      {/* 可选更新弹窗 */}
      {showUpdateModal && optionalUpdateInfo && (
        <UpdateNotification
          updateInfo={optionalUpdateInfo}
          onClose={() => setShowUpdateModal(false)}
        />
      )}
    </div>
  );
};

// Model Settings Tab
const ModelSettings: React.FC<{
  config: any;
  onChange: (config: any) => void;
}> = ({ config, onChange }) => {
  const { t } = useI18n();
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Save config to backend
  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus('idle');
    try {
      // Use type assertion for partial update - backend handles merging
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        models: {
          default: config.provider,
          defaultProvider: config.provider,
          providers: {
            [config.provider]: {
              apiKey: config.apiKey,
              model: config.model,
              temperature: config.temperature,
              enabled: true,
            },
          },
        },
      } as any);
      console.log('[ModelSettings] Config saved:', config.provider);
      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (error) {
      console.error('[ModelSettings] Failed to save config:', error);
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  const providers: { id: ModelProvider; name: string; description: string }[] = [
    { id: 'deepseek', name: t.model.providers.deepseek.name, description: t.model.providers.deepseek.description },
    { id: 'claude', name: t.model.providers.anthropic.name, description: t.model.providers.anthropic.description },
    { id: 'openai', name: t.model.providers.openai.name, description: t.model.providers.openai.description },
    { id: 'openrouter', name: t.model.providers.openrouter?.name || 'OpenRouter', description: t.model.providers.openrouter?.description || '中转服务 (Gemini/Claude/GPT)' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-4">{t.model.title}</h3>
        <div className="grid grid-cols-3 gap-3">
          {providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => onChange({ ...config, provider: provider.id })}
              className={`p-3 rounded-lg border text-left transition-colors ${
                config.provider === provider.id
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-zinc-700 hover:border-zinc-600'
              }`}
            >
              <div className="text-sm font-medium text-zinc-100">
                {provider.name}
              </div>
              <div className="text-xs text-zinc-500 mt-1">
                {provider.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-2">
          {t.model.apiKey}
        </label>
        <div className="relative">
          <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="password"
            value={config.apiKey || ''}
            onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
            placeholder={t.model.apiKeyPlaceholder}
            className="w-full pl-10 pr-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
          />
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          {t.model.apiKeyHint}
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-2">
          {t.model.modelSelect}
        </label>
        <select
          value={config.model}
          onChange={(e) => onChange({ ...config, model: e.target.value })}
          className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"
        >
          {config.provider === 'deepseek' && (
            <>
              <option value="deepseek-chat">DeepSeek Chat</option>
              <option value="deepseek-coder">DeepSeek Coder</option>
            </>
          )}
          {config.provider === 'claude' && (
            <>
              <option value="claude-sonnet-4-20250514">Claude 4 Sonnet</option>
              <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
              <option value="claude-3-opus-20240229">Claude 3 Opus</option>
            </>
          )}
          {config.provider === 'openai' && (
            <>
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4-turbo">GPT-4 Turbo</option>
              <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
            </>
          )}
          {config.provider === 'openrouter' && (
            <>
              <optgroup label="Google Gemini">
                <option value="google/gemini-2.0-flash-001">Gemini 2.0 Flash</option>
                <option value="google/gemini-2.0-flash-thinking-exp:free">Gemini 2.0 Flash Thinking (免费)</option>
                <option value="google/gemini-exp-1206:free">Gemini Exp 1206 (免费)</option>
              </optgroup>
              <optgroup label="Anthropic Claude">
                <option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</option>
                <option value="anthropic/claude-3.5-haiku">Claude 3.5 Haiku</option>
              </optgroup>
              <optgroup label="OpenAI">
                <option value="openai/gpt-4o">GPT-4o</option>
                <option value="openai/gpt-4o-mini">GPT-4o Mini</option>
              </optgroup>
              <optgroup label="DeepSeek">
                <option value="deepseek/deepseek-chat">DeepSeek Chat</option>
                <option value="deepseek/deepseek-r1">DeepSeek R1</option>
              </optgroup>
            </>
          )}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-100 mb-2">
          {t.model.temperature}: {config.temperature}
        </label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={config.temperature}
          onChange={(e) =>
            onChange({ ...config, temperature: parseFloat(e.target.value) })
          }
          className="w-full"
        />
        <div className="flex justify-between text-xs text-zinc-500">
          <span>{t.model.temperaturePrecise}</span>
          <span>{t.model.temperatureCreative}</span>
        </div>
      </div>

      {/* Save Button */}
      <div className="pt-4 border-t border-zinc-800">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className={`w-full py-2.5 px-4 rounded-lg font-medium transition-colors ${
            saveStatus === 'success'
              ? 'bg-green-600 text-white'
              : saveStatus === 'error'
              ? 'bg-red-600 text-white'
              : 'bg-blue-600 hover:bg-blue-500 text-white'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {isSaving ? t.common.saving || 'Saving...' : saveStatus === 'success' ? t.common.saved || 'Saved!' : saveStatus === 'error' ? t.common.error || 'Error' : t.common.save || 'Save'}
        </button>
      </div>
    </div>
  );
};

// Disclosure Settings Tab - 渐进披露设置
const DisclosureSettings: React.FC<{
  level: DisclosureLevel;
  onChange: (level: DisclosureLevel) => void;
}> = ({ level, onChange }) => {
  const { t } = useI18n();
  const [devModeAutoApprove, setDevModeAutoApprove] = useState(true);
  const [showDevModeConfirm, setShowDevModeConfirm] = useState(false);

  // Handle disclosure level change and persist to backend
  const handleLevelChange = async (newLevel: DisclosureLevel) => {
    onChange(newLevel);
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        ui: { disclosureLevel: newLevel },
      } as any);
      console.log('[DisclosureSettings] Disclosure level saved:', newLevel);
    } catch (error) {
      console.error('[DisclosureSettings] Failed to save disclosure level:', error);
    }
  };

  // Load dev mode setting on mount (from persistent storage)
  useEffect(() => {
    const loadSettings = async () => {
      try {
        // Use persistent storage that survives data clear
        const enabled = await window.electronAPI?.invoke(IPC_CHANNELS.PERSISTENT_GET_DEV_MODE);
        if (enabled !== undefined) {
          setDevModeAutoApprove(enabled);
        }
      } catch (error) {
        console.error('Failed to load dev mode setting:', error);
        // Fallback to config service
        try {
          const settings = await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_GET);
          if (settings?.permissions?.devModeAutoApprove !== undefined) {
            setDevModeAutoApprove(settings.permissions.devModeAutoApprove);
          }
        } catch (e) {
          console.error('Fallback also failed:', e);
        }
      }
    };
    loadSettings();
  }, []);

  // Toggle dev mode auto-approve (save to persistent storage)
  const handleDevModeToggle = async () => {
    // If turning ON, show confirmation first
    if (!devModeAutoApprove) {
      setShowDevModeConfirm(true);
      return;
    }

    // Turning OFF - no confirmation needed
    await saveDevModeSetting(false);
  };

  // Actually save the dev mode setting
  const saveDevModeSetting = async (newValue: boolean) => {
    setDevModeAutoApprove(newValue);
    try {
      // Save to persistent storage (survives data clear)
      await window.electronAPI?.invoke(IPC_CHANNELS.PERSISTENT_SET_DEV_MODE, newValue);
      console.log('[DisclosureSettings] Dev mode auto-approve saved to persistent storage:', newValue);
    } catch (error) {
      console.error('Failed to save dev mode setting:', error);
      // Revert on error
      setDevModeAutoApprove(!newValue);
    }
  };

  // Handle dev mode confirmation
  const handleDevModeConfirm = async () => {
    setShowDevModeConfirm(false);
    await saveDevModeSetting(true);
  };

  const handleDevModeCancel = () => {
    setShowDevModeConfirm(false);
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
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">{t.disclosure.title}</h3>
        <p className="text-xs text-zinc-400 mb-4">
          {t.disclosure.description}
        </p>
      </div>

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

      <div className="bg-zinc-800/50 rounded-lg p-4 mt-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">{t.disclosure.whyTitle}</h4>
        <p className="text-xs text-zinc-400 leading-relaxed">
          {t.disclosure.whyDescription}
        </p>
      </div>

      {/* Developer Mode Options */}
      <div className="border-t border-zinc-800 pt-4 mt-6">
        <h4 className="text-sm font-medium text-zinc-100 mb-3">{t.disclosure.devMode?.title || '开发者选项'}</h4>
        <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/50 border border-zinc-700">
          <div className="flex-1 pr-4">
            <div className="text-sm text-zinc-100">{t.disclosure.devMode?.autoApprove || '自动授权所有权限'}</div>
            <p className="text-xs text-zinc-400 mt-1">
              {t.disclosure.devMode?.autoApproveDescription || '开发模式下跳过所有权限确认弹窗，方便快速测试。'}
            </p>
          </div>
          <button
            onClick={handleDevModeToggle}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              devModeAutoApprove ? 'bg-indigo-600' : 'bg-zinc-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                devModeAutoApprove ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Dev Mode Confirmation Modal */}
      {showDevModeConfirm && (
        <DevModeConfirmModal
          onConfirm={handleDevModeConfirm}
          onCancel={handleDevModeCancel}
        />
      )}
    </div>
  );
};

// Appearance Settings Tab
const AppearanceSettings: React.FC = () => {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-4">{t.appearance.theme}</h3>
        <div className="grid grid-cols-3 gap-3">
          <button className="p-3 rounded-lg border border-blue-500 bg-blue-500/10">
            <div className="w-full h-16 rounded bg-zinc-900 border border-zinc-700 mb-2" />
            <div className="text-sm text-zinc-100">{t.appearance.themes.dark}</div>
          </button>
          <button className="p-3 rounded-lg border border-zinc-700 opacity-50 cursor-not-allowed">
            <div className="w-full h-16 rounded bg-white border border-zinc-300 mb-2" />
            <div className="text-sm text-zinc-400">{t.appearance.themes.light} ({t.common.coming})</div>
          </button>
          <button className="p-3 rounded-lg border border-zinc-700 opacity-50 cursor-not-allowed">
            <div className="w-full h-16 rounded bg-gradient-to-b from-white to-zinc-900 border border-zinc-500 mb-2" />
            <div className="text-sm text-zinc-400">{t.appearance.themes.auto} ({t.common.coming})</div>
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-4">{t.appearance.fontSize}</h3>
        <select className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-zinc-600">
          <option value="small">{t.appearance.fontSizes.small}</option>
          <option value="medium">{t.appearance.fontSizes.medium}</option>
          <option value="large">{t.appearance.fontSizes.large}</option>
        </select>
      </div>
    </div>
  );
};

// Language Settings Tab - 语言设置
const LanguageSettings: React.FC = () => {
  const { t, language, setLanguage, availableLanguages } = useI18n();

  const handleLanguageChange = async (lang: Language) => {
    setLanguage(lang);
    // Persist to backend
    try {
      // Use type assertion for partial update - backend handles merging
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
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">{t.language.title}</h3>
        <p className="text-xs text-zinc-400 mb-4">
          {t.language.description}
        </p>
      </div>

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

// About Section
const AboutSection: React.FC = () => {
  const { t } = useI18n();
  const [version, setVersion] = useState<string>('...');

  useEffect(() => {
    const loadVersion = async () => {
      try {
        const v = await window.electronAPI?.invoke(IPC_CHANNELS.APP_GET_VERSION);
        if (v) setVersion(v);
      } catch (error) {
        console.error('Failed to load version:', error);
      }
    };
    loadVersion();
  }, []);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-4">
          <Cpu className="w-10 h-10 text-white" />
        </div>
        <h3 className="text-xl font-semibold text-zinc-100">Code Agent</h3>
        <p className="text-sm text-zinc-400 mt-1">{t.about.version} {version}</p>
      </div>

      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">{t.about.title}</h4>
        <p className="text-sm text-zinc-400 leading-relaxed">
          {t.about.description}
        </p>
      </div>

      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">{t.about.technologies}</h4>
        <div className="flex flex-wrap gap-2">
          {['Electron', 'React', 'TypeScript', 'Tailwind CSS', 'DeepSeek API'].map(
            (tech) => (
              <span
                key={tech}
                className="px-2 py-1 text-xs rounded bg-zinc-900 text-zinc-400"
              >
                {tech}
              </span>
            )
          )}
        </div>
      </div>

      <div className="text-center text-xs text-zinc-500">
        {t.about.madeWith}
      </div>
    </div>
  );
};

// Cache Settings Tab - 数据管理
interface DataStats {
  sessionCount: number;
  messageCount: number;
  toolExecutionCount: number;
  knowledgeCount: number;
  databaseSize: number;
  cacheEntries: number;
}

const CacheSettings: React.FC = () => {
  const [stats, setStats] = useState<DataStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadStats = async () => {
    try {
      const dataStats = await window.electronAPI?.invoke(IPC_CHANNELS.DATA_GET_STATS);
      if (dataStats) setStats(dataStats);
    } catch (error) {
      console.error('Failed to load data stats:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const handleClearToolCache = async () => {
    setIsClearing(true);
    setMessage(null);
    try {
      const cleared = await window.electronAPI?.invoke(IPC_CHANNELS.DATA_CLEAR_TOOL_CACHE);
      if (cleared === 0) {
        setMessage({ type: 'success', text: '缓存已经是空的' });
      } else {
        setMessage({ type: 'success', text: `已清理 ${cleared} 条工具调用缓存` });
      }
      await loadStats();
    } catch (error) {
      setMessage({ type: 'error', text: '清理失败' });
    } finally {
      setIsClearing(false);
    }
  };

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">数据管理</h3>
        <p className="text-xs text-zinc-400 mb-4">
          查看应用数据使用情况。会话、消息和生成的文件不会被清理。
        </p>
      </div>

      {/* Data Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-zinc-100">{stats?.sessionCount || 0}</div>
          <div className="text-xs text-zinc-400">会话数</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-zinc-100">{stats?.messageCount || 0}</div>
          <div className="text-xs text-zinc-400">消息数</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-indigo-400">{formatSize(stats?.databaseSize || 0)}</div>
          <div className="text-xs text-zinc-400">数据库大小</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-cyan-400">{stats?.cacheEntries || 0}</div>
          <div className="text-xs text-zinc-400">内存缓存条目</div>
        </div>
      </div>

      {/* Detailed Stats */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-3">详细数据</h4>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between text-zinc-400">
            <span>工具执行记录</span>
            <span className="text-zinc-300">{stats?.toolExecutionCount || 0} 条</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>项目知识库</span>
            <span className="text-zinc-300">{stats?.knowledgeCount || 0} 条</span>
          </div>
        </div>
      </div>

      {/* Cache Info */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-3">可清理的缓存</h4>
        <p className="text-xs text-zinc-400 mb-3">
          工具调用的临时缓存（如文件读取、搜索结果）可以安全清理，不会影响您的会话和数据。
        </p>
        <button
          onClick={handleClearToolCache}
          disabled={isClearing}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isClearing ? 'animate-spin' : ''}`} />
          清空缓存 {(stats?.cacheEntries || 0) > 0 && `(${stats?.cacheEntries} 条)`}
        </button>
      </div>

      {/* Message */}
      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg ${
          message.type === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
        }`}>
          {message.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span className="text-sm">{message.text}</span>
        </div>
      )}
    </div>
  );
};

// Cloud Config Settings Tab - 云端配置管理
interface CloudConfigInfo {
  version: string;
  lastFetch: number;
  isStale: boolean;
  fromCloud: boolean;
  lastError: string | null;
}

const CloudConfigSettings: React.FC = () => {
  const { t } = useI18n();
  const [cloudConfigInfo, setCloudConfigInfo] = useState<CloudConfigInfo | null>(null);
  const [isRefreshingConfig, setIsRefreshingConfig] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadCloudConfigInfo = async () => {
    try {
      const info = await window.electronAPI?.invoke(IPC_CHANNELS.CLOUD_CONFIG_GET_INFO);
      if (info) setCloudConfigInfo(info);
    } catch (error) {
      console.error('Failed to load cloud config info:', error);
    }
  };

  useEffect(() => {
    loadCloudConfigInfo();
  }, []);

  const handleRefreshCloudConfig = async () => {
    setIsRefreshingConfig(true);
    setMessage(null);
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.CLOUD_CONFIG_REFRESH);
      if (result?.success) {
        setMessage({ type: 'success', text: `配置已更新到 v${result.version}` });
        await loadCloudConfigInfo();
      } else {
        setMessage({ type: 'error', text: result?.error || '刷新失败' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: '刷新失败' });
    } finally {
      setIsRefreshingConfig(false);
    }
  };

  // 格式化时间
  const formatTime = (timestamp: number): string => {
    if (!timestamp) return '从未';
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">
          {t.settings.cloud?.title || '云端配置'}
        </h3>
        <p className="text-xs text-zinc-400 mb-4">
          {t.settings.cloud?.description || 'System Prompt、Skills 等配置从云端实时获取，支持热更新。'}
        </p>
      </div>

      {/* Config Info */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-3">配置状态</h4>
        {cloudConfigInfo ? (
          <div className="space-y-2 text-xs">
            <div className="flex justify-between text-zinc-400">
              <span>配置版本</span>
              <span className="text-zinc-300 font-mono">{cloudConfigInfo.version}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>配置来源</span>
              <span className={cloudConfigInfo.fromCloud ? 'text-green-400' : 'text-yellow-400'}>
                {cloudConfigInfo.fromCloud ? '云端' : '内置'}
              </span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>上次获取</span>
              <span className="text-zinc-300">{formatTime(cloudConfigInfo.lastFetch)}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>缓存状态</span>
              <span className={cloudConfigInfo.isStale ? 'text-yellow-400' : 'text-green-400'}>
                {cloudConfigInfo.isStale ? '已过期' : '有效'}
              </span>
            </div>
            {cloudConfigInfo.lastError && (
              <div className="flex justify-between text-zinc-400">
                <span>最近错误</span>
                <span className="text-red-400 truncate max-w-[200px]" title={cloudConfigInfo.lastError}>
                  {cloudConfigInfo.lastError}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
          </div>
        )}
      </div>

      {/* Refresh Button */}
      <button
        onClick={handleRefreshCloudConfig}
        disabled={isRefreshingConfig}
        className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw className={`w-4 h-4 ${isRefreshingConfig ? 'animate-spin' : ''}`} />
        {isRefreshingConfig ? '刷新中...' : '刷新云端配置'}
      </button>

      {/* Message */}
      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg ${
          message.type === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
        }`}>
          {message.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span className="text-sm">{message.text}</span>
        </div>
      )}

      {/* Info Box */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">关于云端配置</h4>
        <p className="text-xs text-zinc-400 leading-relaxed">
          云端配置包含 System Prompt、Skills 定义、Feature Flags 等内容。
          配置会在应用启动时自动获取，并缓存 1 小时。如果云端不可用，
          将自动降级使用内置配置。
        </p>
      </div>
    </div>
  );
};

// Update Settings Tab - 版本更新
interface UpdateSettingsProps {
  updateInfo: UpdateInfo | null;
  onUpdateInfoChange: (info: UpdateInfo | null) => void;
  onShowUpdateModal: () => void;
}

const UpdateSettings: React.FC<UpdateSettingsProps> = ({
  updateInfo,
  onUpdateInfoChange,
  onShowUpdateModal,
}) => {
  const { t } = useI18n();
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 从 updateInfo 获取当前版本，如果没有则显示占位符
  const currentVersion = updateInfo?.currentVersion || '...';

  const checkForUpdates = async () => {
    setIsChecking(true);
    setError(null);
    try {
      const info = await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_CHECK);
      // 只处理非强制更新（强制更新由 App.tsx 处理）
      if (info && !info.forceUpdate) {
        onUpdateInfoChange(info);
      } else if (info) {
        onUpdateInfoChange(info);
      }
    } catch (err) {
      setError(t.update?.checkError || '检查更新失败，请稍后重试');
      console.error('Update check failed:', err);
    } finally {
      setIsChecking(false);
    }
  };

  useEffect(() => {
    // 如果没有 updateInfo，自动检查
    if (!updateInfo) {
      checkForUpdates();
    }
  }, []);

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">{t.update?.title || '版本更新'}</h3>
        <p className="text-xs text-zinc-400 mb-4">
          {t.update?.description || '检查并下载最新版本的 Code Agent'}
        </p>
      </div>

      {/* Current Version */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-zinc-400">{t.update?.currentVersion || '当前版本'}</div>
            <div className="text-lg font-semibold text-zinc-100">v{currentVersion}</div>
          </div>
          <button
            onClick={checkForUpdates}
            disabled={isChecking}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white text-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isChecking ? 'animate-spin' : ''}`} />
            {isChecking ? (t.update?.checking || '检查中...') : (t.update?.checkNow || '检查更新')}
          </button>
        </div>
      </div>

      {/* Update Status */}
      {updateInfo && (
        <div className={`rounded-lg p-4 ${
          updateInfo.hasUpdate ? 'bg-indigo-500/10 border border-indigo-500/30' : 'bg-green-500/10 border border-green-500/30'
        }`}>
          {updateInfo.hasUpdate ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Download className="w-5 h-5 text-indigo-400 mt-0.5" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-100">
                    {t.update?.newVersion || '发现新版本'}: v{updateInfo.latestVersion}
                  </div>
                  {updateInfo.fileSize && (
                    <p className="text-xs text-zinc-500 mt-0.5">
                      文件大小: {formatSize(updateInfo.fileSize)}
                    </p>
                  )}
                  {updateInfo.releaseNotes && (
                    <div className="mt-2 p-2 bg-zinc-800/50 rounded text-xs text-zinc-400 max-h-24 overflow-y-auto whitespace-pre-line">
                      {updateInfo.releaseNotes}
                    </div>
                  )}
                </div>
              </div>

              {/* 立即更新按钮 */}
              <button
                onClick={onShowUpdateModal}
                className="w-full py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors font-medium"
              >
                <div className="flex items-center justify-center gap-2">
                  <Download className="w-4 h-4" />
                  {t.update?.download || '立即更新'}
                </div>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-green-400" />
              <span className="text-sm text-zinc-100">{t.update?.upToDate || '已是最新版本'}</span>
            </div>
          )}
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400">
          <AlertCircle className="w-4 h-4" />
          <span className="text-sm">{error}</span>
        </div>
      )}

    </div>
  );
};
