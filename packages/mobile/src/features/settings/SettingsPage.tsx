import { useState } from 'react';
import type { messages } from '../../i18n';
import type { Appearance, SheetPage } from '../../stores/mobileStore';
import type { OsPermission } from '../../platform/ports';
import type { RegistrationStatus } from '../../stores/notificationStore';
import { NeoBrandMark } from '../brand/NeoBrandMark';
import { AppIcon } from '../../app/AppIcon';

export function SettingsPage({ page, text, appearance, nickname, profileDraft, appInfo, open, chooseAppearance, editProfile, saveProfile, storage, notifications, account, logout }: {
  page: SheetPage; text: ReturnType<typeof messages>; appearance: Appearance; nickname: string;
  profileDraft: string; appInfo: { version: string; build: string } | null;
  open(page: SheetPage): void; chooseAppearance(value: Appearance): void; editProfile(value: string): void; saveProfile(): void;
  storage?: { previewBytes: number; conversationBytes?: number; result: 'clean' | null; confirm: boolean; onConfirm(): void; onClear(): void };
  notifications?: {
    preference: boolean; osPermission: OsPermission; registration: RegistrationStatus; lastFailure: string | null;
    onToggle(value: boolean): void; onRequest(): void; onOpenSettings(): void;
  };
  /**
   * 已登录的 Neo 账号（null = 未登录）：账号并进个人卡，不再单独一行
   * （N-COMPANION-RELAY-ACCOUNT-LOGIN-V3，爸 2026-09-19 拍板）。
   */
  account?: { email: string } | null;
  /** 个人信息页内「退出登录」文字链接；只在已登录时渲染那个区块。 */
  logout?: () => Promise<void>;
}) {
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const row = (target: SheetPage, detail?: string) => <button className="settings-row" data-testid={`open-${target}`} onClick={() => open(target)}>
    <span>{text[target]}</span><span className="row-detail">{detail}<AppIcon name="chevron" /></span>
  </button>;
  const handleLogout = async () => {
    if (!logout || logoutBusy) return;
    setLogoutBusy(true); setLogoutFailed(false);
    await logout();
    setLogoutBusy(false);
    // companionStore.logout() 的 persist 失败分支静默保留 account、不改状态（见其注释）：
    // 不改 store 逻辑，借这个既有信号在 UI 报一句，而不是新开一条失败通道。
    if (account) setLogoutFailed(true);
  };
  switch (page) {
    case 'settings': return <>
      <button className="profile-card" onClick={() => open(account ? 'profile' : 'account')} data-testid="open-profile">
        {account
          ? <span className="avatar">{(nickname || account.email).slice(0, 1)}</span>
          : <span className="avatar avatar-generic"><AppIcon name="profile" /></span>}
        <span className="stack">
          <strong>{account ? (nickname || account.email) : text.accountNotLoggedIn}</strong>
          <span className="small">{account ? account.email : text.accountCardHint}</span>
        </span>
        <AppIcon name="chevron" />
      </button>
      <p className="group-title">{text.preferences}</p><div className="settings-group">{row('appearance', text[appearance])}{row('storage')}{row('notifications', notifications?.preference ? text.notificationOn : text.notificationOff)}</div>
      <p className="group-title">{text.support}</p><div className="settings-group">{row('help')}{row('about')}</div>
    </>;
    case 'appearance': return <div className="settings-group" role="group" aria-label={text.appearance}>
      {(['system', 'light', 'dark'] as const).map(value => <button className="settings-row" key={value}
        data-testid={`theme-${value}`} aria-pressed={appearance === value} onClick={() => chooseAppearance(value)}>
        <span>{text[value]}</span>{appearance === value && <AppIcon name="check" />}
      </button>)}
    </div>;
    case 'profile': return <form onSubmit={event => { event.preventDefault(); saveProfile(); }}>
      <label className="group-title" htmlFor="nickname">{text.nickname}</label>
      <input id="nickname" autoComplete="nickname" value={profileDraft} maxLength={60} onChange={event => editProfile(event.target.value)} />
      <button type="submit" className="primary" disabled={!profileDraft.trim()}>{text.save}</button>
      {account && <>
        <p className="group-title">{text.account}</p>
        <div className="settings-group">
          <div className="settings-row"><span>{text.accountLoginEmail}</span><span className="row-detail">{account.email}</span></div>
        </div>
        <button type="button" className="sheet-secondary" data-testid="account-logout" disabled={logoutBusy} onClick={() => { void handleLogout(); }}>{text.accountLogout}</button>
        {logoutFailed && <p role="alert" data-testid="account-logout-failed">{text.accountLogoutFailed}</p>}
        <p className="caption">{text.accountLogoutHint}</p>
      </>}
    </form>;
    case 'about': return <div className="about"><NeoBrandMark size={56} /><h3>{text.neo}</h3>
      <p>{text.aboutDescription}</p><p data-testid="app-version">{appInfo ? `${text.version} ${appInfo.version}（${appInfo.build}）` : text.unavailableVersion}</p>
    </div>;
    case 'help': return <p>{text.helpBody}</p>;
    case 'storage': return <div>
      <p className="caption">{text.storageProtected}</p>
      <div className="settings-group">
        <div className="settings-row"><span>{text.storageUsage}</span><span className="row-detail">{Math.ceil((storage?.previewBytes ?? 0) / (1024 * 1024))} MB</span></div>
        <div className="settings-row"><span>{text.storageConversation}</span><span className="row-detail">{Math.ceil((storage?.conversationBytes ?? 0) / (1024 * 1024))} MB</span></div>
      </div>
      {storage?.result === 'clean' && <p className="notice" role="status">{text.cacheCleared}</p>}
      {storage?.confirm
        ? <><p role="alert">{text.clearCacheConfirm}</p><button className="primary" onClick={storage.onClear}>{text.confirmClear}</button></>
        : <button className="primary" onClick={storage?.onConfirm}>{text.clearCache}</button>}
    </div>;
    case 'notifications': return <div>
      <div className="settings-group">
        <button className="settings-row" data-testid="notify-toggle" aria-pressed={notifications?.preference === true}
          onClick={() => notifications?.onToggle(!notifications.preference)}>
          <span>{text.notificationPreference}</span>{notifications?.preference && <AppIcon name="check" />}
        </button>
      </div>
      {notifications?.osPermission === 'denied' || notifications?.osPermission === 'restricted'
        ? <><p className="caption">{text.notificationDenied}</p>
          <button className="primary" data-testid="notify-settings" onClick={() => notifications?.onOpenSettings()}>{text.openSystemSettings}</button></>
        : notifications?.lastFailure === 'REGISTRATION_FAILED'
          ? <p className="caption" role="status">{text.notificationRegistrationError}</p>
          : notifications?.lastFailure?.startsWith('CHANNEL_MISSING')
            ? <p className="caption" role="status">{text.notificationFailed}</p>
            : notifications?.registration === 'registered' ? <p className="caption" role="status">{text.notificationReady}</p>
            : !notifications?.preference ? <button className="primary" data-testid="notify-enable" onClick={() => { notifications?.onToggle(true); notifications?.onRequest(); }}>{text.enableNotifications}</button>
              : null}
    </div>;
    case 'preview':
    case 'attachment':
    case 'cameraDenied':
    case 'pairConfirm':
    case 'voiceSetup':
      return null;
    case 'projects': return <p>{text.noProjects}</p>;
    case 'remote': return <><h3>{text.noComputers}</h3><p>{text.baseNotice}</p></>;
    case 'more': return <div className="settings-group">{row('projects')}{row('remote')}</div>;
  }
}
