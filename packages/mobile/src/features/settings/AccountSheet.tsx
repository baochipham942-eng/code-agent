import { useState } from 'react';
import type { messages } from '../../i18n';
import type { AccountLoginOutcome } from '../../stores/companionStore';
import { COMPANION_LIMITS } from '../../../../../src/shared/constants/companion';

/**
 * 登录页（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE，UI 稿 S4/S7；N-COMPANION-RELAY-ACCOUNT-LOGIN-V3
 * 收窄为纯登录表单）：只有邮箱+密码，没有第三方登录。已登录态不再走这里——设置页个人卡已登录时
 * 直接进个人信息页（SettingsPage 'profile' 分支），账号区（邮箱 + 退出登录）画在那一页，这里只
 * 剩「还没登录」这一条路。账号服务连不上（S7）主按钮「重试」、次按钮「稍后再说」。密码只活在
 * 本地 state，提交即进 platform 层的栈上，不落盘、不进日志；成功后连 state 里的密码一起清掉。
 */
export function AccountSheet({ hostEmail, login, dismiss, text }: {
  /** 配对信息里带的电脑账号邮箱：预填与「这台电脑属于谁」的文案都用它。 */
  hostEmail: string | null;
  login(email: string, password: string): Promise<AccountLoginOutcome>;
  /** S7「稍后再说」：收掉账号页（关弹层）。 */
  dismiss(): void;
  text: ReturnType<typeof messages>;
}) {
  const [email, setEmail] = useState(hostEmail ?? '');
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
    // 只置 busy，既有的失败面板/行内报错留着不清——await 结束前清掉会让 S7 重试瞬间
    // 切回裸表单再切回失败面板，「错误提示先消失」（N-COMPANION-RELAY-ACCOUNT-LOGIN-V3 D，
    // 守卫⑤）。哪个分支亮由 await 结束后的新结局决定，不是提交那一刻决定。
    setBusy(true);
    const outcome = await login(useEmail, usePassword);
    setBusy(false);
    if (outcome.ok) { setPassword(''); setInvalid(false); setWrongAccount(null); setUnreachable(null); return; }
    if (outcome.kind === 'invalidCredentials') { setInvalid(true); setWrongAccount(null); setUnreachable(null); }
    else if (outcome.kind === 'wrongAccount') { setWrongAccount(outcome.hostEmail); setInvalid(false); setUnreachable(null); }
    // 账号服务连不上（S7）：记住这次的输入，主按钮「重试」直接重发。
    else { setUnreachable({ email: useEmail, password: usePassword }); setInvalid(false); setWrongAccount(null); }
  };

  if (unreachable) {
    return <div className="sheet-fail" role="status" data-testid="account-unreachable">
      <strong>{text.accountLoginUnreachable}</strong>
      {/* S7 重试 busy 态同款 spinner+文案（R3 ai-review Nit），跟登录表单主按钮一个样式，
          不是「按钮变灰」这一种反馈。 */}
      <button className={busy ? 'primary busy' : 'primary'} data-testid="account-retry" disabled={busy} onClick={() => { void submit(unreachable); }}>
        {busy ? <><span className="spinner" aria-hidden="true" />{text.accountLoginBusy}</> : text.retry}
      </button>
      <button className="sheet-secondary" data-testid="account-later" onClick={dismiss}>{text.accountLoginLater}</button>
    </div>;
  }

  return <form className="account-sheet" data-testid="account-login" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className="caption">{text.accountLoginHint}</p>
    <label className="group-title" htmlFor="account-email">{text.accountLoginEmail}</label>
    <input id="account-email" type="email" inputMode="email" autoComplete="email" value={email} disabled={busy}
      maxLength={COMPANION_LIMITS.accountEmailMaxLength} onChange={event => setEmail(event.target.value)} />
    <label className="group-title" htmlFor="account-password">{text.accountLoginPassword}</label>
    <input id="account-password" type="password" autoComplete="current-password" value={password} disabled={busy}
      onChange={event => setPassword(event.target.value)} />
    {invalid && <p role="alert" data-testid="account-invalid">{text.accountLoginInvalid}</p>}
    {wrongAccount && <p role="alert" data-testid="account-wrong">{text.accountLoginWrongAccount.replace('{email}', wrongAccount)}</p>}
    <button type="submit" className={busy ? 'primary busy' : 'primary'} data-testid="account-submit" disabled={busy || !email.trim() || !password}>
      {busy ? <><span className="spinner" aria-hidden="true" />{text.accountLoginBusy}</> : text.accountLoginSubmit}
    </button>
    <p className="caption">{text.accountLoginFooter}</p>
  </form>;
}
