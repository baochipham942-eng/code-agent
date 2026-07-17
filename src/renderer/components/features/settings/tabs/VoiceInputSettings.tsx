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
import { useI18n } from '../../../../hooks/useI18n';
import { Toggle } from '../../../primitives/Toggle';

const logger = createLogger('VoiceInputSettings');

const MODE_OPTIONS: Array<{
  id: SpeechTranscriptionMode;
  icon: React.ReactNode;
}> = [
  {
    id: 'local-first',
    icon: <Cpu className="h-4 w-4" />,
  },
  {
    id: 'local-only',
    icon: <Mic className="h-4 w-4" />,
  },
  {
    id: 'cloud-only',
    icon: <Cloud className="h-4 w-4" />,
  },
];

const LANGUAGE_OPTION_IDS = ['auto', 'zh', 'en', 'ja', 'ko', 'es', 'fr'] as const;

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
  const { t } = useI18n();
  const voiceText = t.settings.voiceInput;
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
        logger.error(voiceText.loadSettingsFailedLog, error);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [voiceText.loadSettingsFailedLog]);

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
      logger.error(voiceText.saveSettingsFailedLog, error);
    } finally {
      setSaving(false);
    }
  };

  const clearRetainedAudio = async () => {
    setClearingAudio(true);
    setClearAudioMessage(null);
    try {
      const result = await ipcService.unsafeInvoke<SpeechRetainedAudioClearResult>('speech:clear-retained-audio');
      setClearAudioMessage(`${voiceText.clearAudioSuccessPrefix}${result?.deletedFiles ?? 0}${voiceText.clearAudioSuccessSuffix}`);
    } catch (error) {
      logger.error(voiceText.clearAudioFailedLog, error);
      setClearAudioMessage(voiceText.clearAudioFailed);
    } finally {
      setClearingAudio(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="pr-4">
          <h3 className="mb-1 text-sm font-medium text-zinc-200">{voiceText.enableTitle}</h3>
          <p className="text-xs text-zinc-500">{voiceText.enableDescription}</p>
        </div>
        <Toggle
          size="md"
          checked={settings.enabled}
          onChange={(next) => persist({ enabled: next })}
          aria-label={voiceText.enableTitle}
        />
      </div>

      <div className="border-t border-zinc-700 pt-4">
        <h3 className="mb-3 text-sm font-medium text-zinc-200">{voiceText.modeTitle}</h3>
        <div className="grid grid-cols-3 gap-3">
          {MODE_OPTIONS.map((option) => {
            const active = settings.mode === option.id;
            const optionText = voiceText.modes[option.id];
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
                  <span className="text-sm font-medium">{optionText.label}</span>
                </div>
                <p className="text-xs leading-5 text-zinc-500">{optionText.description}</p>
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
          <span className="text-sm font-medium text-zinc-200">{voiceText.languageLabel}</span>
          <select
            value={settings.language}
            onChange={(event) => persist({ language: event.target.value })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            {LANGUAGE_OPTION_IDS.map((id) => (
              <option key={id} value={id}>{voiceText.languages[id]}</option>
            ))}
          </select>
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-zinc-200">{voiceText.localModelLabel}</span>
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
          <span className="text-sm font-medium text-zinc-200">{voiceText.threadsLabel}</span>
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
          <span className="text-sm font-medium text-zinc-200">{voiceText.maxDurationLabel}</span>
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
          <span className="text-sm font-medium text-zinc-200">{voiceText.shortcutLabel}</span>
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
            <div className="text-sm font-medium text-zinc-200">{voiceText.preserveAudioTitle}</div>
            <div className="mt-1 text-xs text-zinc-500">{voiceText.preserveAudioDescription}</div>
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
            <div className="text-sm font-medium text-zinc-200">{voiceText.clearAudioTitle}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {clearAudioMessage || voiceText.clearAudioDescription}
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
            <div className="text-sm font-medium text-zinc-200">{voiceText.postProcessingTitle}</div>
            <div className="mt-1 text-xs text-zinc-500">{voiceText.postProcessingDescription}</div>
          </div>
          {settings.postProcessingEnabled && <Check className="h-4 w-4 text-zinc-200" />}
        </button>
      </div>

      <div className="flex items-center gap-2 border-t border-zinc-700 pt-4 text-xs text-zinc-500">
        <SlidersHorizontal className="h-3.5 w-3.5" />
        <span>{saving ? voiceText.saving : voiceText.effectiveNextRecording}</span>
      </div>
    </div>
  );
};

export default VoiceInputSettings;
