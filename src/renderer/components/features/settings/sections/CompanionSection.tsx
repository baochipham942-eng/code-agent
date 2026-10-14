import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { COMPANION_LIMITS, COMPANION_MANAGE_CHANNEL } from '@shared/constants/companion';
import { hasFullProjectScope, projectScope } from '@shared/contract/companionLibrary';
import type { CompanionManagementResult, CompanionPairedDevice, CompanionRelayStatus } from '@shared/contract/companionManagement';
import { useAuthStore } from '../../../../stores/authStore';
import { invoke } from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { companionErrorCopy, companionText } from '../../../../i18n/companion';
import { deriveInvitationVerify, formatInvitationVerify } from '@shared/companion/lanProtocol';
import { Button, Toggle } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { SettingsSection } from '../SettingsLayout';

type Status = Extract<CompanionManagementResult, { kind: 'status' }>;
type Copy = (typeof companionText)['zh'];

export function CompanionSection() {
  const { language } = useI18n();
  const text = companionText[language];
  const locale = language === 'en' ? 'en-US' : 'zh-CN';
  const setShowAuthModal = useAuthStore((state) => state.setShowAuthModal);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [status, setStatus] = useState<Status | null>(null);
  const [qr, setQr] = useState<{ image: string; expiresAt: number; verify?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [confirmRemoteOff, setConfirmRemoteOff] = useState(false);
  const projects = status?.projects ?? [];
  const grants = projectScope(projects).slice(0, COMPANION_LIMITS.maxScopeSessions);
  const capped = (status?.projects?.length ?? 0) > grants.length;
  // 远程访问总闸：状态只认 host 的 status 结果（旧 host 缺省按开算），不吃本地存储，重启后仍以 host 为准。
  const remoteOn = status?.remoteEnabled ?? true;
  const deviceCount = status?.devices.length ?? 0;
  const canInvite = !!status && grants.length > 0 && remoteOn;
  const refresh = async () => {
    const result = await invoke(COMPANION_MANAGE_CHANNEL, { action: 'status' });
    if (result?.kind !== 'status') throw new Error('COMPANION_UNAVAILABLE');
    setStatus(result);
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      console.error('[companion] management failed', caught);
      setError(companionErrorCopy(text, detail || 'UNKNOWN_ERROR'));
    } finally { setBusy(false); }
  };
  const invite = () => void run(async () => {
    if (!grants.length) return;
    setQr(null); setExpired(false);
    const result = await invoke(COMPANION_MANAGE_CHANNEL, { action: 'invite', scope: grants });
    if (result.kind !== 'invitation') throw new Error('COMPANION_UNAVAILABLE');
    const image = await QRCode.toDataURL(JSON.stringify(result.invitation), { width: 320, margin: 2, errorCorrectionLevel: 'M' });
    setQr({
      image, expiresAt: result.invitation.expiresAt,
      verify: result.invitation.verify
        ? deriveInvitationVerify(result.invitation.psk, result.invitation.hostKey) : undefined,
    });
  });
  // 总闸开 = 直发；关 = 先弹确认（见 ConfirmDialog），取消/关闭一律不发请求，也绝不走 revoke。
  const applyRemote = (enabled: boolean) => void run(async () => {
    const result = await invoke(COMPANION_MANAGE_CHANNEL, { action: 'setRemote', enabled });
    if (result?.kind !== 'status') throw new Error('COMPANION_UNAVAILABLE');
    setStatus(result);
    // 总闸一关 LAN/relay 都停了，页面上已展示的配对码必死，别留着误导。
    if (!enabled) { setQr(null); setExpired(false); }
  });
  useEffect(() => { void run(refresh); }, []);
  // 登录态变化后重拉一次：点「去登录」成功回来，状态块不能还停在「未开通」（也不做轮询）。
  const wasAuthenticated = useRef(isAuthenticated);
  useEffect(() => {
    if (wasAuthenticated.current === isAuthenticated) return;
    wasAuthenticated.current = isAuthenticated;
    void run(refresh);
  }, [isAuthenticated]);
  useEffect(() => {
    if (!qr) return;
    const timer = setTimeout(() => { setExpired(true); setQr(null); }, Math.max(0, qr.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [qr]);
  return <SettingsSection title={text.title} description={text.description}>
    <fieldset disabled={busy} className="space-y-4">
      <div className="flex items-center justify-between gap-3" data-testid="companion-remote-row">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-zinc-200">{text.remoteTitle}</p>
          <p className="text-xs text-zinc-500" data-testid={remoteOn ? 'companion-remote-count' : 'companion-remote-off-hint'}>
            {remoteOn ? (deviceCount > 0 ? text.remoteCount(deviceCount) : text.remoteCountNone) : text.remoteOffHint}
          </p>
        </div>
        <span data-testid="companion-remote-toggle">
          <Toggle checked={remoteOn} onChange={(next) => (next ? applyRemote(true) : setConfirmRemoteOff(true))} aria-label={text.remoteTitle} />
        </span>
      </div>
      {status && !projects.length && <p className="text-sm text-zinc-400">{text.empty}</p>}
      {capped && <p role="status">{text.scopeCapped}</p>}
      <div className="flex flex-wrap items-start gap-5">
        {qr && <img src={qr.image} alt={text.qr} width={320} height={320} className="rounded-lg bg-white p-2" />}
        <div className="space-y-2 text-sm">
          <p>{text.scanHint}</p>
          {qr?.verify && <>
            <p className="text-xs text-zinc-500">{text.verifyLabel}</p>
            <p className="font-mono text-2xl tracking-[0.2em] text-zinc-100" data-testid="companion-verify">
              {formatInvitationVerify(qr.verify)}
            </p>
          </>}
          <p className="text-xs text-zinc-500">{qr ? text.expires : expired ? text.expired : text.expires}</p>
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" size="sm" loading={busy} disabled={!canInvite || busy} onClick={invite}>
              {busy ? text.working : qr || expired ? text.regenerate : text.create}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void run(refresh)}>{text.refresh}</Button>
          </div>
        </div>
      </div>
      {expired && !qr && <p role="status">{text.expired}</p>}
      <p className="text-xs text-zinc-500">{text.awayHint}</p>
      {status?.relay && (
        <CrossNetworkStatus relay={status.relay} text={text} onSignIn={() => setShowAuthModal(true)} />
      )}
      <div className="space-y-2">
        <p className="text-sm font-medium text-zinc-200">{text.devices}</p>
        {status && !status.devices.length && <p className="text-sm text-zinc-400">{text.noDevices}</p>}
        {status?.devices.map((device, index) => (
          <DeviceRow key={device.deviceId} device={device} index={index} projects={projects} text={text} locale={locale}
            busy={busy} onRevoke={() => void run(async () => {
              await invoke(COMPANION_MANAGE_CHANNEL, { action: 'revoke', deviceId: device.deviceId });
              await refresh();
            })} />
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </fieldset>
    <ConfirmDialog
      isOpen={confirmRemoteOff}
      title={text.remoteOffTitle}
      message={text.remoteOffConfirm(deviceCount)}
      variant="warning"
      confirmText={text.remoteOffConfirmYes}
      cancelText={text.remoteOffConfirmNo}
      onConfirm={() => { setConfirmRemoteOff(false); applyRemote(false); }}
      onCancel={() => setConfirmRemoteOff(false)}
    />
  </SettingsSection>;
}

/** 跨网连接状态块：四态一句人话，只有 signedOut 有「去登录」；旧通道小字只在确实连着时显示。 */
function CrossNetworkStatus({ relay, text, onSignIn }: {
  relay: CompanionRelayStatus; text: Copy; onSignIn: () => void;
}) {
  const [title, hint] = relay.account === 'off' ? [text.crossnetOff, text.crossnetOffHint]
    : relay.account === 'signedOut' ? [text.crossnetSignedOut, text.crossnetSignedOutHint]
    : relay.account === 'connecting' ? [text.crossnetConnecting, text.crossnetConnectingHint]
    : [text.crossnetConnected, text.crossnetConnectedHint];
  return <div className="space-y-1" data-testid="companion-crossnet">
    <p className="text-sm font-medium text-zinc-200">{title}</p>
    <p className="text-sm text-zinc-400">{hint}</p>
    {relay.account === 'signedOut' && (
      <Button variant="secondary" size="sm" onClick={onSignIn} data-testid="companion-crossnet-action">
        {text.crossnetSignIn}
      </Button>
    )}
    {relay.legacy === 'connected' && (
      <p className="text-xs text-zinc-500">{text.crossnetLegacyConnected}</p>
    )}
  </div>;
}

function DeviceRow({ device, index, projects, text, locale, busy, onRevoke }: {
  device: CompanionPairedDevice; index: number; projects: { id: string; name: string }[];
  text: Copy; locale: string; busy: boolean; onRevoke: () => void;
}) {
  const full = hasFullProjectScope(device.scope, projects);
  return <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
    <div className="space-y-1">
      <p>{device.name?.trim() || `${text.phone} ${index + 1}`}</p>
      {device.pairedAt != null && <p className="text-xs text-zinc-500">{text.pairedAt} {new Date(device.pairedAt).toLocaleString(locale)}</p>}
      <p className="text-xs text-zinc-400">{full ? text.scopeAll : text.scopeLimited}</p>
      {!full && <p className="text-xs text-zinc-500">{text.legacyScope}</p>}
    </div>
    <Button variant="danger" size="sm" disabled={busy} onClick={onRevoke}>{text.revoke}</Button>
  </div>;
}
