import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, SpeechInputSettings } from '@shared/contract';
import { DEFAULT_SPEECH_INPUT_SETTINGS, VOICE_INPUT_SETTINGS_UPDATED_EVENT } from '@shared/contract';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('VoiceInputModelSettings');
const OPTIONS = [
  { id: 'ggml-large-v3-turbo.bin', label: 'large-v3-turbo' },
  { id: 'ggml-large-v3.bin', label: 'large-v3' },
  { id: 'ggml-medium.bin', label: 'medium' },
  { id: 'ggml-small.bin', label: 'small' },
  { id: 'ggml-base.bin', label: 'base' },
];

function mergeSpeech(value?: Partial<SpeechInputSettings>): SpeechInputSettings {
  return { ...DEFAULT_SPEECH_INPUT_SETTINGS, ...(value ?? {}) };
}

const VoiceInputModelSettings: React.FC = () => {
  const { t } = useI18n();
  const text = t.settings.voiceModel;
  const [speech, setSpeech] = useState<SpeechInputSettings>(DEFAULT_SPEECH_INPUT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => { if (!cancelled) setSpeech(mergeSpeech(settings.speech)); })
      .catch((error) => logger.error('load transcription model settings failed', error));
    return () => { cancelled = true; };
  }, []);

  const persist = async (localModel: string) => {
    const next = mergeSpeech({ ...speech, localModel });
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { speech: next } as Partial<AppSettings>);
      setSpeech(next);
      window.dispatchEvent(new CustomEvent(VOICE_INPUT_SETTINGS_UPDATED_EVENT, { detail: next }));
    } catch (error) {
      logger.error('save transcription model settings failed', error);
    }
  };

  return (
    <div className="space-y-6" data-testid="voice-model-settings">
      <label className="block space-y-2">
        <span className="text-sm font-medium text-zinc-200">{text.transcriptionModelLabel}</span>
        <select
          data-testid="voice-model-transcription-model"
          value={speech.localModel}
          onChange={(event) => void persist(event.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent-accessible"
        >
          {OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <p className="text-xs text-zinc-500">{text.transcriptionModelNote}</p>
      </label>
    </div>
  );
};

export default VoiceInputModelSettings;
