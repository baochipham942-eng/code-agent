import { useState } from 'react';
import type { messages } from '../../i18n';
import type { AccountLoginOutcome } from '../../stores/companionStore';

/**
 * 账号页（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE，UI 稿 S4/S7）：只有邮箱+密码，没有第三方登录。
 * 已登录态显示「账号 <邮箱>」与「退出登录」；未登录态是登录表单——邮箱预填配对信息里带的电脑
 * 账号邮箱，账号服务连不上（S7）主按钮「重试」、次按钮「稍后再说」。密码只活在本地 state，
 * 提交即进 platform 层的栈上，不落盘、不进日志；成功后连 state 里的密码一起清掉。
 */
export function AccountSheet({ account, hostEmail, login, logout, dismiss, text }: {
  /** 已登录账号（无票据，票据只在配对盘里）；null = 未登录。 */
  account: { email: string } | null;
  /** 配对信息里带的电脑账号邮箱：预填与「这台电脑属于谁」的文案都用它。 */
  hostEmail: string | null;
  login(email: string, password: string): Promise<AccountLoginOutcome>;
  logout(): Promise<void>;
  /** S7「稍后再说」：收掉账号页（关弹层）。 */
  dismiss(): void;
  text: ReturnType<typeof messages>;
}) {
  const [email, setEmail] = useState(hostEmail ?? account?.email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  /** S7 态重现最近一次提交（重试不用重新打字）；凭据错/账号不一致留在表单行内报。 */
  const [unreachable, setUnreachable] = useState<{ email: string; password: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [wrongAccount, setWrongAccount] = useState<string | null>(null);

  const submit = async (creds?: { email: string; password: string }) => {
    // S7 的「重试」带显式凭据重发：setState 不是同步生效，闭包里的 email/password 还是旧值。
    const useEmail = (creds?.email ?? email).trim();
    const usePassword = creds?.password ?? password;
    if (busy || !useEmail || !usePassword) return;
    setBusy(true); setInvalid(false); setWrongAccount(null); setUnreachable(null);
    const outcome = await login(useEmail, usePassword);
    setBusy(false);
    if (outcome.ok) { setPassword(''); return; }
    if (outcome.kind === 'invalidCredentials') setInvalid(true);
    else if (outcome.kind === 'wrongAccount') setWrongAccount(outcome.hostEmail);
    // 账号服务连不上（S7）：记住这次的输入，主按钮「重试」直接重发。
    else setUnreachable({ email: useEmail, password: usePassword });
  };

  if (account) {
    return <div className="account-sheet" data-testid="account-signed-in">
      <p className="caption">{text.accountLoggedInHint}</p>
      <div className="settings-group">
        <div className="settings-row"><span>{text.account}</span><span className="row-detail">{account.email}</span></div>
      </div>
      <button className="primary" data-testid="account-logout" disabled={busy} onClick={() => { void logout(); }}>{text.accountLogout}</button>
      <p className="caption">{text.accountLogoutHint}</p>
    </div>;
  }

  if (unreachable) {
    return <div className="sheet-fail" role="status" data-testid="account-unreachable">
      <strong>{text.accountLoginUnreachable}</strong>
      <button className="primary" data-testid="account-retry" disabled={busy} onClick={() => { void submit(unreachable); }}>{text.retry}</button>
      <button className="sheet-secondary" data-testid="account-later" onClick={dismiss}>{text.accountLoginLater}</button>
    </div>;
  }

  return <form className="account-sheet" data-testid="account-login" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className="caption">{text.accountLoginHint}</p>
    <label className="group-title" htmlFor="account-email">{text.accountLoginEmail}</label>
    <input id="account-email" type="email" inputMode="email" autoComplete="email" value={email}
      onChange={event => setEmail(event.target.value)} />
    <label className="group-title" htmlFor="account-password">{text.accountLoginPassword}</label>
    <input id="account-password" type="password" autoComplete="current-password" value={password}
      onChange={event => setPassword(event.target.value)} />
    {invalid && <p role="alert" data-testid="account-invalid">{text.accountLoginInvalid}</p>}
    {wrongAccount && <p role="alert" data-testid="account-wrong">{text.accountLoginWrongAccount.replace('{email}', wrongAccount)}</p>}
    <button type="submit" className="primary" data-testid="account-submit" disabled={busy || !email.trim() || !password}>{text.accountLoginSubmit}</button>
    <p className="caption">{text.accountLoginFooter}</p>
  </form>;
}
