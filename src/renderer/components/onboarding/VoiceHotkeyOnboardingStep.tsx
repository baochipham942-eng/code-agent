import React, { useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';
import type { AppSettings } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import {
  createDefaultKeybindingsSettings,
  eventToAccelerator,
  formatShortcutForDisplay,
  getCurrentKeybindingPlatform,
  mergeKeybindingsWithDefaults,
  type KeybindingsSettings,
} from '@shared/keybindings';
import { emitKeybindingsChanged } from '../../hooks/useKeybindingsSettings';
import { useI18n } from '../../hooks/useI18n';
import { interpolate } from '../../i18n/interpolate';
import ipcService from '../../services/ipcService';
import { createLogger } from '../../utils/logger';
import { evaluateVoiceCallToggleHotkey } from './evaluateVoiceCallToggleHotkey';

const logger = createLogger('VoiceHotkeyOnboarding');

type SettingsLoadState = 'pending' | 'ready' | 'failed';

export interface VoiceHotkeyOnboardingStepProps {
  canCapture: boolean;
  disabled?: boolean;
  onBound: () => void;
}

export const VoiceHotkeyOnboardingStep: React.FC<VoiceHotkeyOnboardingStepProps> = ({
  canCapture,
  disabled = false,
  onBound,
}) => {
  const { t } = useI18n();
  const text = t.onboarding;
  const platform = getCurrentKeybindingPlatform();
  const [keybindings, setKeybindings] = useState<KeybindingsSettings>(() =>
    createDefaultKeybindingsSettings(platform),
  );
  const [loadState, setLoadState] = useState<SettingsLoadState>('pending');
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<'error' | 'info'>('info');
  const settingsReady = loadState === 'ready';
  const captureBlocked = disabled || !settingsReady;

  useEffect(() => {
    if (!canCapture) {
      setLoadState('pending');
      return;
    }
    let cancelled = false;
    setLoadState('pending');
    setRecording(false);
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (cancelled) return;
        setKeybindings(mergeKeybindingsWithDefaults(settings?.keybindings, platform));
        setLoadState('ready');
      })
      .catch((error) => {
        logger.error('load keybindings for onboarding hotkey failed', error);
        if (cancelled) return;
        setRecording(false);
        setLoadState('failed');
        setMessage(text.voiceHotkeyLoadFailed);
        setMessageTone('error');
      });
    return () => {
      cancelled = true;
    };
  }, [canCapture, platform, text.voiceHotkeyLoadFailed]);

  useEffect(() => {
    if (!recording || captureBlocked) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(false);
        return;
      }
      if (!settingsReady) {
        setRecording(false);
        return;
      }
      const accelerator = eventToAccelerator(event, platform);
      if (!accelerator) return;
      const evaluation = evaluateVoiceCallToggleHotkey(keybindings, accelerator, platform);
      if (!evaluation.ok && evaluation.kind === 'conflict') {
        const labels = evaluation.actionIds
          .map((id) => t.settings.keybindings.actions[id]?.label ?? id)
          .join(' / ');
        setMessage(interpolate(text.voiceHotkeyConflict, { actions: labels }));
        setMessageTone('error');
        setRecording(false);
        return;
      }
      if (!evaluation.ok && evaluation.kind === 'system') {
        const reserved = t.settings.keybindings.systemReservedReasons[platform] as Record<string, string>;
        const reason = reserved[evaluation.normalizedShortcut] ?? evaluation.reason;
        setMessage(interpolate(text.voiceHotkeySystemConflict, { reason }));
        setMessageTone('error');
        setRecording(false);
        return;
      }
      if (!evaluation.ok) return;
      setRecording(false);
      setKeybindings(evaluation.next);
      setMessage('');
      void ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        keybindings: evaluation.next,
      } as Partial<AppSettings>).then(() => {
        emitKeybindingsChanged(evaluation.next);
        onBound();
      }).catch((error) => {
        logger.error('save onboarding voice call hotkey failed', error);
        setMessage(text.voiceHotkeySaveFailed);
        setMessageTone('error');
      });
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [
    captureBlocked,
    keybindings,
    onBound,
    platform,
    recording,
    settingsReady,
    t.settings.keybindings,
    text,
  ]);

  const current = mergeKeybindingsWithDefaults(keybindings, platform).bindings['voice.callToggle'];

  return (
    <section className="space-y-4" data-testid="onboarding-voice-hotkey-step">
      <div className="flex items-start gap-3">
        <Keyboard className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-zinc-100">{text.voiceHotkeyTitle}</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            {canCapture ? text.voiceHotkeyDescription : text.voiceHotkeyUnavailableDescription}
          </p>
          {canCapture ? (
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                data-testid="onboarding-voice-hotkey-bind"
                disabled={captureBlocked}
                onClick={() => {
                  if (captureBlocked) return;
                  setMessage('');
                  setRecording(true);
                }}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
              >
                {recording ? text.voiceHotkeyRecording : text.voiceHotkeyBind}
              </button>
              <span data-testid="onboarding-voice-hotkey-current" className="text-xs text-zinc-400">
                {current?.enabled && current.accelerator
                  ? formatShortcutForDisplay(current.accelerator, platform)
                  : text.voiceHotkeyUnbound}
              </span>
            </div>
          ) : null}
          {message ? (
            <p
              role="alert"
              data-testid="onboarding-voice-hotkey-message"
              className={`mt-2 text-xs ${messageTone === 'error' ? 'text-badge-danger' : 'text-zinc-500'}`}
            >
              {message}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
};
