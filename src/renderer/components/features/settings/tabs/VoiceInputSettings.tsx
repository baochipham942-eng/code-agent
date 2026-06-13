// ============================================================================
// VoiceInputSettings - composer voice input settings
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Check, Cloud, Cpu, Mic, RotateCcw, SlidersHorizontal, Trash2, Wand2 } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, SpeechInputSettings, SpeechRetainedAudioClearResult, SpeechTranscriptionMode } from '@shared/contract';
import { DEFAULT_SPEECH_INPUT_SETTINGS, VOICE_INPUT_SETTINGS_UPDATED_EVENT } from '@shared/contract';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('VoiceInputSettings');

const MODE_OPTIONS: Array<{
  id: SpeechTranscriptionMode;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    id: 'local-first',
    label: '本地优先',
    description: 'whisper-cpp 可用时本地转写，失败后用 Groq 兜底',
    icon: <Cpu className="h-4 w-4" />,
  },
  {
    id: 'local-only',
    label: '仅本地',
    description: '音频不离开本机，缺模型或转写失败时直接返回错误',
    icon: <Mic className="h-4 w-4" />,
  },
  {
    id: 'cloud-only',
    label: '仅云端',
    description: '使用 Groq Whisper，适合本地模型不可用时临时使用',
    icon: <Cloud className="h-4 w-4" />,
  },
];

const LANGUAGE_OPTIONS = [
  { id: 'auto', label: '自动检测' },
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
];

const MODEL_OPTIONS = [
  { id: 'ggml-large-v3-turbo.bin', label: 'large-v3-turbo' },
  { id: 'ggml-large-v3.bin', label: 'large-v3' },
  { id: 'ggml-medium.bin', label: 'medium' },
  { id: 'ggml-small.bin', label: 'small' },
  { id: 'ggml-base.bin', label: 'base' },
];

function mergeSpeechSettings(value?: Partial<SpeechInputSettings>): SpeechInputSettings {
  return {
    ...DEFAULT_SPEECH_INPUT_SETTINGS,
    ...(value ?? {}),
  };
}

export const VoiceInputSettings: React.FC = () => {
  const [settings, setSettings] = useState<SpeechInputSettings>(DEFAULT_SPEECH_INPUT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [clearingAudio, setClearingAudio] = useState(false);
  const [clearAudioMessage, setClearAudioMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const appSettings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
        if (!cancelled) {
          setSettings(mergeSpeechSettings(appSettings.speech));
        }
      } catch (error) {
        logger.error('加载语音输入设置失败', error);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = async (patch: Partial<SpeechInputSettings>) => {
    const next = mergeSpeechSettings({ ...settings, ...patch });
    setSettings(next);
    setSaving(true);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        speech: next,
      } as Partial<AppSettings>);
      window.dispatchEvent(new CustomEvent(VOICE_INPUT_SETTINGS_UPDATED_EVENT, { detail: next }));
    } catch (error) {
      logger.error('保存语音输入设置失败', error);
    } finally {
      setSaving(false);
    }
  };

  const clearRetainedAudio = async () => {
    setClearingAudio(true);
    setClearAudioMessage(null);
    try {
      const result = await ipcService.unsafeInvoke<SpeechRetainedAudioClearResult>('speech:clear-retained-audio');
      setClearAudioMessage(`已清理 ${result?.deletedFiles ?? 0} 个文件`);
    } catch (error) {
      logger.error('清理语音保留音频失败', error);
      setClearAudioMessage('清理失败');
    } finally {
      setClearingAudio(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="pr-4">
          <h3 className="mb-1 text-sm font-medium text-zinc-200">启用会话语音输入</h3>
          <p className="text-xs text-zinc-500">会话输入框显示麦克风入口，转写结果进入草稿。</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          onClick={() => persist({ enabled: !settings.enabled })}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            settings.enabled ? 'bg-primary-500' : 'bg-zinc-600'
          }`}
        >
          <span
            className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
              settings.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <div className="border-t border-zinc-700 pt-4">
        <h3 className="mb-3 text-sm font-medium text-zinc-200">转写模式</h3>
        <div className="grid grid-cols-3 gap-3">
          {MODE_OPTIONS.map((option) => {
            const active = settings.mode === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => persist({ mode: option.id })}
                className={`relative rounded-lg border p-3 text-left transition-all ${
                  active
                    ? 'border-zinc-500 bg-zinc-800/60 ring-1 ring-white/10'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                <div className="mb-2 flex items-center gap-2 text-zinc-300">
                  {option.icon}
                  <span className="text-sm font-medium">{option.label}</span>
                </div>
                <p className="text-xs leading-5 text-zinc-500">{option.description}</p>
                {active && (
                  <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-200">
                    <Check className="h-3 w-3 text-zinc-950" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 border-t border-zinc-700 pt-4">
        <label className="space-y-2">
          <span className="text-sm font-medium text-zinc-200">语言</span>
          <select
            value={settings.language}
            onChange={(event) => persist({ language: event.target.value })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-zinc-200">本地模型</span>
          <select
            value={settings.localModel}
            onChange={(event) => persist({ localModel: event.target.value })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            {MODEL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="space-y-2">
          <span className="text-sm font-medium text-zinc-200">线程数</span>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={16}
              value={settings.threads}
              onChange={(event) => persist({ threads: Number(event.target.value) })}
              className="min-w-0 flex-1"
            />
            <span className="w-8 rounded bg-zinc-800 px-2 py-1 text-center text-xs text-zinc-300">
              {settings.threads}
            </span>
          </div>
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-zinc-200">最长录音</span>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={15}
              max={300}
              step={15}
              value={settings.maxDurationSeconds}
              onChange={(event) => persist({ maxDurationSeconds: Number(event.target.value) })}
              className="min-w-0 flex-1"
            />
            <span className="w-14 rounded bg-zinc-800 px-2 py-1 text-center text-xs text-zinc-300">
              {settings.maxDurationSeconds}s
            </span>
          </div>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4 border-t border-zinc-700 pt-4">
        <label className="space-y-2">
          <span className="text-sm font-medium text-zinc-200">快捷键</span>
          <input
            value={settings.shortcut || ''}
            onChange={(event) => persist({ shortcut: event.target.value.trim() })}
            placeholder="Mod+Shift+V"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-primary-500"
          />
        </label>

        <button
          type="button"
          onClick={() => persist({ preserveAudioOnFailure: !settings.preserveAudioOnFailure })}
          className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-all ${
            settings.preserveAudioOnFailure
              ? 'border-zinc-500 bg-zinc-800/60'
              : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
          }`}
        >
          <RotateCcw className="h-4 w-4 shrink-0 text-zinc-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-zinc-200">失败后保留重试</div>
            <div className="mt-1 text-xs text-zinc-500">保留本次录音，用户可在会话页重新转写。</div>
          </div>
          {settings.preserveAudioOnFailure && <Check className="h-4 w-4 text-zinc-200" />}
        </button>

        <button
          type="button"
          onClick={() => void clearRetainedAudio()}
          disabled={clearingAudio}
          className="flex items-center gap-3 rounded-lg border border-zinc-700 p-3 text-left transition-all hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Trash2 className="h-4 w-4 shrink-0 text-zinc-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-zinc-200">清理失败录音</div>
            <div className="mt-1 text-xs text-zinc-500">
              {clearAudioMessage || '删除本机保留的重试音频，不影响已发送消息。'}
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => persist({ postProcessingEnabled: !settings.postProcessingEnabled })}
          className={`col-span-2 flex items-center gap-3 rounded-lg border p-3 text-left transition-all ${
            settings.postProcessingEnabled
              ? 'border-zinc-500 bg-zinc-800/60'
              : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
          }`}
        >
          <Wand2 className="h-4 w-4 shrink-0 text-zinc-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-zinc-200">轻量整理转写文本</div>
            <div className="mt-1 text-xs text-zinc-500">去掉常见口头停顿并整理空格，保留原始转写用于元数据追踪。</div>
          </div>
          {settings.postProcessingEnabled && <Check className="h-4 w-4 text-zinc-200" />}
        </button>
      </div>

      <div className="flex items-center gap-2 border-t border-zinc-700 pt-4 text-xs text-zinc-500">
        <SlidersHorizontal className="h-3.5 w-3.5" />
        <span>{saving ? '正在保存' : '设置会在下一次录音时生效'}</span>
      </div>
    </div>
  );
};

export default VoiceInputSettings;
