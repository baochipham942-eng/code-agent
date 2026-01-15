// ============================================================================
// SettingsModal - Application Settings
// ============================================================================

import React, { useState } from 'react';
import { useAppStore, type DisclosureLevel } from '../stores/appStore';
import { useI18n, type Language } from '../hooks/useI18n';
import { X, Key, Cpu, Palette, Info, Layers, Eye, EyeOff, Sparkles, Zap, Globe } from 'lucide-react';
import type { ModelProvider } from '@shared/types';

type SettingsTab = 'model' | 'disclosure' | 'appearance' | 'language' | 'about';

export const SettingsModal: React.FC = () => {
  const { setShowSettings, modelConfig, setModelConfig, disclosureLevel, setDisclosureLevel } = useAppStore();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>('model');

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'model', label: t.settings.tabs.model, icon: <Cpu className="w-4 h-4" /> },
    { id: 'disclosure', label: t.settings.tabs.disclosure, icon: <Layers className="w-4 h-4" /> },
    { id: 'appearance', label: t.settings.tabs.appearance, icon: <Palette className="w-4 h-4" /> },
    { id: 'language', label: t.settings.tabs.language, icon: <Globe className="w-4 h-4" /> },
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
                <span className="text-sm">{tab.label}</span>
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
            {activeTab === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
};

// Model Settings Tab
const ModelSettings: React.FC<{
  config: any;
  onChange: (config: any) => void;
}> = ({ config, onChange }) => {
  const { t } = useI18n();

  const providers: { id: ModelProvider; name: string; description: string }[] = [
    { id: 'deepseek', name: t.model.providers.deepseek.name, description: t.model.providers.deepseek.description },
    { id: 'claude', name: t.model.providers.anthropic.name, description: t.model.providers.anthropic.description },
    { id: 'openai', name: t.model.providers.openai.name, description: t.model.providers.openai.description },
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
            value={config.apiKey}
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
    </div>
  );
};

// Disclosure Settings Tab - 渐进披露设置
const DisclosureSettings: React.FC<{
  level: DisclosureLevel;
  onChange: (level: DisclosureLevel) => void;
}> = ({ level, onChange }) => {
  const { t } = useI18n();

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
            onClick={() => onChange(item.id)}
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
  const { IPC_CHANNELS } = require('@shared/ipc');

  const handleLanguageChange = async (lang: Language) => {
    setLanguage(lang);
    // Persist to backend
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_SET, {
        ui: { language: lang },
      });
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

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-4">
          <Cpu className="w-10 h-10 text-white" />
        </div>
        <h3 className="text-xl font-semibold text-zinc-100">Code Agent</h3>
        <p className="text-sm text-zinc-400 mt-1">{t.about.version} 0.1.0</p>
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
