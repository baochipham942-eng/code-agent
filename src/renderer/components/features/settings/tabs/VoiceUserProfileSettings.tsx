import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { VOICE_USER_PROFILE } from '@shared/constants/voice';
import type { VoiceUserProfileView } from '@shared/contract/voice';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { Toggle } from '../../../primitives/Toggle';
import { Button } from '../../../primitives/Button';

export function VoiceUserProfileSettings() {
  const { t } = useI18n();
  const text = t.voice.settings;
  const [profile, setProfile] = useState<VoiceUserProfileView | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ipcService.invokeDomain<VoiceUserProfileView>(IPC_DOMAINS.VOICE, 'getUserProfile')
      .then((view) => {
        if (cancelled) return;
        setProfile(view);
        setDraft(view.text);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const save = async (enabled: boolean, override: string | null) => {
    setBusy(true);
    setFailed(false);
    try {
      const view = await ipcService.invokeDomain<VoiceUserProfileView>(IPC_DOMAINS.VOICE, 'setUserProfile', { enabled, override });
      setProfile(view);
      setDraft(view.text);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3" aria-label={text.profileTitle}>
      <h3 className="text-sm font-medium text-zinc-200">{text.profileTitle}</h3>
      <p className="text-xs text-zinc-400">{text.profileHint}</p>
      {profile && <>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{text.profileEnabled}</span>
          <Toggle checked={profile.enabled} disabled={busy} aria-label={text.profileEnabled}
            onChange={(enabled) => void save(enabled, profile.override)} />
        </div>
        <pre data-testid="voice-user-profile-preview" className="whitespace-pre-wrap break-words text-sm">{profile.text}</pre>
        {!profile.text && <p className="text-xs text-zinc-400">{profile.enabled ? text.profileEmpty : text.profileOff}</p>}
        {profile.enabled && <>
          <textarea aria-label={text.profileTitle} value={draft} disabled={busy}
            maxLength={VOICE_USER_PROFILE.MAX_CHARS}
            className="min-h-32 w-full rounded border border-zinc-700 bg-zinc-900 p-3 text-sm"
            onChange={(event) => setDraft(event.target.value)} />
          <div className="flex gap-2">
            <Button disabled={busy || draft === profile.text} onClick={() => void save(true, draft)}>{text.profileSave}</Button>
            <Button disabled={busy} onClick={() => void save(true, null)}>{text.profileRegenerate}</Button>
          </div>
        </>}
      </>}
      {failed && <p role="alert" className="text-sm text-badge-danger">{text.profileError}</p>}
    </section>
  );
}
