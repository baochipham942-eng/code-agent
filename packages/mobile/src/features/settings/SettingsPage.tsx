import { useEffect, useState } from 'react';
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
  /**
   * 个人信息页内「退出登录」文字链接；只在已登录时渲染那个区块。回传是否真的退出成功
   * （store 的 logout() 本身不回传——persist 失败时静默保留 account），调用方在 MobileRoot
   * 里退出后重读一次 store 现状换算成布尔值（N-COMPANION-RELAY-ACCOUNT-LOGIN-V3 R2）。
   */
  logout?: () => Promise<boolean>;
}) {
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  // SettingsPage 跨页切换不卸载：不能只在提交那一刻判失败，还得在进个人页 / 账号状态换了
  // （退出成功、或换个账号重新登录）时把上一轮的失败提示复位，否则会一直粘在页面上
  // （R2 监工复核纠正：旧实现读渲染闭包里的 account 判失败，退出成功后它仍是旧对象，恒判失败）。
  useEffect(() => { setLogoutFailed(false); }, [page, account?.email]);
  const row = (target: SheetPage, detail?: string) => <button className="settings-row" data-testid={`open-${target}`} onClick={() => open(target)}>
    <span>{text[target]}</span><span className="row-detail">{detail}<AppIcon name="chevron" /></span>
  </button>;
  const handleLogout = async () => {
    if (!logout || logoutBusy) return;
    setLogoutBusy(true); setLogoutFailed(false);
    const ok = await logout();
    setLogoutBusy(false);
    setLogoutFailed(!ok);
  };
  switch (page) {
    case 'settings': return <>
      <button className="profile-card" onClick={() => open(account ? 'profile' : 'account')} data-testid="open-profile">
        {account
          ? <span className="avatar">{(nickname || account.email).slice(0, 1)}</span>
          : <span className="avatar avatar-generic"><AppIcon name="profile" /></span>}
        <span className="stack">
          <strong>{account ? (nickname || account.email) : text.accountNotLoggedIn}</strong>
          {/* 昵称为空时主标题已经在用邮箱了，副标题不能再复读一遍同一串（R3 ai-review Nit）——
              换成一句「已登录」提示；有昵称时副标题才轮到邮箱当第二行身份信息。 */}
          <span className="small">{account ? (nickname ? account.email : text.accountLoggedInHint) : text.accountCardHint}</span>
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
