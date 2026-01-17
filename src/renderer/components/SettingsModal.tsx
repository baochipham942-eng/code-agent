// ============================================================================
// SettingsModal - Application Settings
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useAppStore, type DisclosureLevel } from '../stores/appStore';
import { useI18n, type Language } from '../hooks/useI18n';
import { X, Key, Cpu, Palette, Info, Layers, Eye, EyeOff, Sparkles, Zap, Globe, Database, Download, RefreshCw, Trash2, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import type { ModelProvider } from '@shared/types';
import { IPC_CHANNELS, type CacheStats, type UpdateInfo } from '@shared/ipc';

type SettingsTab = 'model' | 'disclosure' | 'appearance' | 'language' | 'cache' | 'update' | 'about';

export const SettingsModal: React.FC = () => {
  const { setShowSettings, modelConfig, setModelConfig, disclosureLevel, setDisclosureLevel } = useAppStore();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>('model');

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'model', label: t.settings.tabs.model, icon: <Cpu className="w-4 h-4" /> },
    { id: 'disclosure', label: t.settings.tabs.disclosure, icon: <Layers className="w-4 h-4" /> },
    { id: 'appearance', label: t.settings.tabs.appearance, icon: <Palette className="w-4 h-4" /> },
    { id: 'language', label: t.settings.tabs.language, icon: <Globe className="w-4 h-4" /> },
    { id: 'cache', label: t.settings.tabs.cache || '缓存', icon: <Database className="w-4 h-4" /> },
    { id: 'update', label: t.settings.tabs.update || '更新', icon: <Download className="w-4 h-4" /> },
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
            {activeTab === 'cache' && <CacheSettings />}
            {activeTab === 'update' && <UpdateSettings />}
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
          defaultProvider: config.provider,
          providers: {
            [config.provider]: {
              apiKey: config.apiKey,
              model: config.model,
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

// Cache Settings Tab - 缓存管理
const CacheSettings: React.FC = () => {
  const { t } = useI18n();
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadStats = async () => {
    try {
      const cacheStats = await window.electronAPI?.invoke(IPC_CHANNELS.CACHE_GET_STATS);
      setStats(cacheStats);
    } catch (error) {
      console.error('Failed to load cache stats:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const handleClearCache = async () => {
    setIsClearing(true);
    setMessage(null);
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.CACHE_CLEAR);
      setMessage({ type: 'success', text: t.cache?.cleared || '缓存已清除' });
      await loadStats();
    } catch (error) {
      setMessage({ type: 'error', text: t.cache?.clearError || '清除缓存失败' });
    } finally {
      setIsClearing(false);
    }
  };

  const handleCleanExpired = async () => {
    setIsClearing(true);
    setMessage(null);
    try {
      const cleaned = await window.electronAPI?.invoke(IPC_CHANNELS.CACHE_CLEAN_EXPIRED);
      setMessage({ type: 'success', text: `${t.cache?.expiredCleaned || '已清理过期缓存'}: ${cleaned} ${t.cache?.entries || '条'}` });
      await loadStats();
    } catch (error) {
      setMessage({ type: 'error', text: t.cache?.cleanError || '清理失败' });
    } finally {
      setIsClearing(false);
    }
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
        <h3 className="text-sm font-medium text-zinc-100 mb-2">{t.cache?.title || '缓存管理'}</h3>
        <p className="text-xs text-zinc-400 mb-4">
          {t.cache?.description || '工具调用结果会被缓存以提升响应速度。缓存的数据包括文件读取、目录列表、搜索结果等。'}
        </p>
      </div>

      {/* Cache Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-zinc-100">{stats?.totalEntries || 0}</div>
          <div className="text-xs text-zinc-400">{t.cache?.totalEntries || '缓存条目'}</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-zinc-100">
            {stats ? `${(stats.hitRate * 100).toFixed(1)}%` : '0%'}
          </div>
          <div className="text-xs text-zinc-400">{t.cache?.hitRate || '命中率'}</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-green-400">{stats?.hitCount || 0}</div>
          <div className="text-xs text-zinc-400">{t.cache?.hits || '缓存命中'}</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-orange-400">{stats?.missCount || 0}</div>
          <div className="text-xs text-zinc-400">{t.cache?.misses || '缓存未命中'}</div>
        </div>
      </div>

      {/* Cache Policies */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-3">{t.cache?.policies || '缓存策略'}</h4>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between text-zinc-400">
            <span>read_file</span>
            <span className="text-zinc-500">5 {t.cache?.minutes || '分钟'}</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>glob, grep, list_directory</span>
            <span className="text-zinc-500">2 {t.cache?.minutes || '分钟'}</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>web_fetch</span>
            <span className="text-zinc-500">15 {t.cache?.minutes || '分钟'}</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>bash, write_file, edit_file</span>
            <span className="text-zinc-500 text-rose-400">{t.cache?.notCached || '不缓存'}</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleCleanExpired}
          disabled={isClearing}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isClearing ? 'animate-spin' : ''}`} />
          {t.cache?.cleanExpired || '清理过期'}
        </button>
        <button
          onClick={handleClearCache}
          disabled={isClearing}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-400 transition-colors disabled:opacity-50"
        >
          <Trash2 className="w-4 h-4" />
          {t.cache?.clearAll || '清除全部'}
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

// Update Settings Tab - 版本更新
const UpdateSettings: React.FC = () => {
  const { t } = useI18n();
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  } | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 从 updateInfo 获取当前版本，如果没有则显示占位符
  const currentVersion = updateInfo?.currentVersion || '...';

  // 监听下载进度事件
  useEffect(() => {
    const handleUpdateEvent = (event: { type: string; data?: any }) => {
      console.log('[UpdateSettings] Received event:', event.type, event.data);

      switch (event.type) {
        case 'download_progress':
          setDownloadProgress(event.data);
          break;

        case 'download_complete':
          setDownloadedPath(event.data.filePath);
          setIsDownloading(false);
          setDownloadProgress(null);
          break;

        case 'download_error':
          setError(event.data.error);
          setIsDownloading(false);
          setDownloadProgress(null);
          break;
      }
    };

    const unsubscribe = window.electronAPI?.on(IPC_CHANNELS.UPDATE_EVENT, handleUpdateEvent);

    return () => {
      unsubscribe?.();
    };
  }, []);

  const checkForUpdates = async () => {
    setIsChecking(true);
    setError(null);
    try {
      const info = await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_CHECK);
      setUpdateInfo(info);
    } catch (err) {
      setError(t.update?.checkError || '检查更新失败，请稍后重试');
      console.error('Update check failed:', err);
    } finally {
      setIsChecking(false);
    }
  };

  const downloadUpdate = async () => {
    if (!updateInfo?.downloadUrl) return;

    setIsDownloading(true);
    setDownloadProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    setError(null);

    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD, updateInfo.downloadUrl);
    } catch (err) {
      setError(t.update?.downloadError || '下载更新失败');
      console.error('Download failed:', err);
      setIsDownloading(false);
      setDownloadProgress(null);
    }
  };

  const openDownloadedFile = async () => {
    if (!downloadedPath) return;
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_OPEN_FILE, downloadedPath);
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  };

  useEffect(() => {
    // Auto check on mount
    checkForUpdates();
  }, []);

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // 格式化速度
  const formatSpeed = (bytesPerSecond: number): string => {
    if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
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
            disabled={isChecking || isDownloading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isChecking ? 'animate-spin' : ''}`} />
            {isChecking ? (t.update?.checking || '检查中...') : (t.update?.checkNow || '检查更新')}
          </button>
        </div>
      </div>

      {/* Update Status */}
      {updateInfo && (
        <div className={`rounded-lg p-4 ${
          updateInfo.hasUpdate ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-green-500/10 border border-green-500/30'
        }`}>
          {updateInfo.hasUpdate ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Download className="w-5 h-5 text-blue-400 mt-0.5" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-100">
                    {t.update?.newVersion || '发现新版本'}: v{updateInfo.latestVersion}
                  </div>
                  {updateInfo.releaseNotes && (
                    <p className="text-xs text-zinc-400 mt-1 whitespace-pre-line">
                      {updateInfo.releaseNotes}
                    </p>
                  )}
                </div>
              </div>

              {/* Download Actions */}
              {!downloadedPath ? (
                <div className="space-y-3">
                  {/* 下载按钮（带进度） */}
                  <button
                    onClick={downloadUpdate}
                    disabled={isDownloading}
                    className="w-full relative overflow-hidden py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:cursor-not-allowed"
                  >
                    {/* 进度条背景 */}
                    {isDownloading && downloadProgress && (
                      <div
                        className="absolute inset-0 bg-blue-400/30 transition-all duration-300"
                        style={{ width: `${downloadProgress.percent}%` }}
                      />
                    )}
                    {/* 按钮内容 */}
                    <div className="relative flex items-center justify-center gap-2">
                      {isDownloading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>
                            {downloadProgress ? (
                              `${downloadProgress.percent.toFixed(0)}% · ${formatSize(downloadProgress.transferred)} / ${formatSize(downloadProgress.total)}`
                            ) : (
                              t.update?.downloading || '下载中...'
                            )}
                          </span>
                          {downloadProgress && downloadProgress.bytesPerSecond > 0 && (
                            <span className="text-blue-200 text-xs">
                              {formatSpeed(downloadProgress.bytesPerSecond)}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4" />
                          {t.update?.download || '下载更新'}
                        </>
                      )}
                    </div>
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-green-400">
                    <CheckCircle className="w-4 h-4" />
                    <span className="text-sm">{t.update?.downloadComplete || '下载完成'}</span>
                  </div>
                  <button
                    onClick={openDownloadedFile}
                    className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors"
                  >
                    {t.update?.openInstaller || '打开安装包'}
                  </button>
                </div>
              )}
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

      {/* Auto Update Info */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">{t.update?.autoUpdate || '自动更新'}</h4>
        <p className="text-xs text-zinc-400">
          {t.update?.autoUpdateDesc || '应用启动时会自动检查更新。下载后需要手动安装新版本。'}
        </p>
      </div>
    </div>
  );
};
