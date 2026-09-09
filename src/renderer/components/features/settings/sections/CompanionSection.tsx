import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { COMPANION_MANAGE_CHANNEL } from '@shared/constants/companion';
import type { CompanionManagementResult } from '@shared/contract/companionManagement';
import { invoke } from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { companionText } from '../../../../i18n/companion';
import { SettingsSection } from '../SettingsLayout';

export function CompanionSection() {
  const { language } = useI18n(); const text = companionText[language];
  const [status, setStatus] = useState<Extract<CompanionManagementResult, { kind: 'status' }> | null>(null);
  const [scope, setScope] = useState<string[]>([]);
  const [qr, setQr] = useState<{ image: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const [expired, setExpired] = useState(false);
  const refresh = async () => {
    const result = await invoke(COMPANION_MANAGE_CHANNEL, { action: 'status' });
    if (!result || result.kind !== 'status') throw new Error('COMPANION_UNAVAILABLE');
    setStatus(result);
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(false);
    try { await work(); } catch { setError(true); } finally { setBusy(false); }
  };
  useEffect(() => { void run(refresh); }, []);
  useEffect(() => {
    if (!qr) return;
    const timer = setTimeout(() => { setExpired(true); setQr(null); }, Math.max(0, qr.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [qr]);
  return <SettingsSection title={text.title} description={text.description}>
    <fieldset disabled={busy} className="space-y-3">
      <legend className="text-sm mb-2">{text.scope}</legend>
      {status?.sessions.length === 0 && <p>{text.empty}</p>}
      {status?.sessions.map(session => <label key={session.id} className="flex gap-2 text-sm">
        <input type="checkbox" checked={scope.includes(session.id)} onChange={event => {
          setScope(event.target.checked ? [...scope, session.id] : scope.filter(id => id !== session.id)); setQr(null);
        }} />{session.title}
      </label>)}
      <div className="flex gap-3"><button disabled={!scope.length || busy} onClick={() => void run(async () => {
        setQr(null); setExpired(false);
        const result = await invoke(COMPANION_MANAGE_CHANNEL, { action: 'invite', scope });
        if (result.kind !== 'invitation') throw new Error('COMPANION_UNAVAILABLE');
        const image = await QRCode.toDataURL(JSON.stringify(result.invitation), { width: 320, margin: 2, errorCorrectionLevel: 'M' });
        setQr({ image, expiresAt: result.invitation.expiresAt });
      })}>{busy ? text.working : text.create}</button>
        <button onClick={() => void run(refresh)}>{text.refresh}</button></div>
      {qr && <div><img src={qr.image} alt={text.qr} width={320} height={320} /><p>{text.expires}</p></div>}
      {expired && <p role="status">{text.expired}</p>}
      {!!status?.devices.length && <p>{text.devices}</p>}
      {status?.devices.map((device, index) => <div key={device.deviceId} className="flex gap-3 text-sm">
        <span>{text.phone} {index + 1}</span><button onClick={() => void run(async () => {
          await invoke(COMPANION_MANAGE_CHANNEL, { action: 'revoke', deviceId: device.deviceId }); await refresh();
        })}>{text.revoke}</button>
      </div>)}
      {error && <p role="alert">{text.error}</p>}
    </fieldset>
  </SettingsSection>;
}
