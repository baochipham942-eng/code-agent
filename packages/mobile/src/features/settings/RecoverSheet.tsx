import { useState } from 'react';
import type { CompanionRelayHostEntry } from '../../../../../src/shared/contract/companionRelay';
import { formatRelayPairVerify } from '../../../../../src/shared/companion/relayPair';
import { recoverErrorCopy, type messages } from '../../i18n';
import type { RecoverError, RecoverStep } from '../../stores/companionStore';

/**
 * 「登录找回我的电脑」弹层（N-COMPANION-RELAY-ACCOUNT-RECOVER，UI 稿 S4/S5/S6）：登录 → 列
 * 在线电脑 → 等电脑上同意（4 位核对码与桌面卡片比对）。密码只活在本地 state，提交即进 platform
 * 层的栈上，不落盘、不进日志；S7 的「重试」原样重发最近一次输入。
 */
export function RecoverSheet({ step, error, hosts, targetName, code, login, selectHost, cancel, text }: {
  step: RecoverStep;
  error: RecoverError | null;
  hosts: readonly CompanionRelayHostEntry[];
  targetName: string | null;
  code: string | null;
  login(email: string, password: string): Promise<void>;
  selectHost(entry: CompanionRelayHostEntry): Promise<void>;
  cancel(): void;
  text: ReturnType<typeof messages>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const busy = step === 'opening';
  const submit = () => {
    if (busy || !email.trim() || !password) return;
    void login(email.trim(), password);
  };

  if (step === 'hosts' || step === 'pairing') {
    return <div className="settings-group remote-sheet" data-testid="recover-sheet">
      {step === 'hosts' ? <>
        <p className="caption">{text.recoverHostsHint}</p>
        {error && <p role="alert" data-testid="recover-error">{recoverErrorCopy(text, error)}</p>}
        <div className="settings-group">
          {hosts.map(host => host.fingerprint
            ? <button key={host.instanceId} className="settings-row" data-testid={`recover-host-${host.instanceId}`}
                onClick={() => void selectHost(host)}>
                <span>{host.name || text.recoverFallbackName}</span>
                <span className="row-detail">{text.recoverHostOnline}</span>
              </button>
            : <div key={host.instanceId} className="settings-row mock-off" data-testid={`recover-host-old-${host.instanceId}`}>
                <span>{host.name || text.recoverFallbackName}</span>
                <span className="row-detail">{text.recoverHostUpgrade}</span>
              </div>)}
        </div>
      </> : <div className="remote-failed" role="status" data-testid="recover-waiting">
        <div className="remote-state"><span className="spinner" aria-hidden="true" />{text.recoverSentTo.replace('{name}', targetName || text.recoverFallbackName)}</div>
        <p>{text.recoverCodeHint}</p>
        <p className="pair-code" aria-label={text.recoverCodeLabel} data-testid="recover-code">{formatRelayPairVerify(code ?? '')}</p>
        <button className="sheet-secondary" data-testid="recover-cancel" onClick={cancel}>{text.cancel}</button>
      </div>}
    </div>;
  }

  // 账号服务连不上（S7 形状）：重试原样重发本地保留的输入，「稍后再说」收掉整个找回流。
  if (error === 'unreachable' && !busy) {
    return <div className="sheet-fail" role="status" data-testid="recover-unreachable">
      <strong>{text.accountLoginUnreachable}</strong>
      <button className="primary" data-testid="recover-retry" onClick={submit}>{text.retry}</button>
      <button className="sheet-secondary" data-testid="recover-later" onClick={cancel}>{text.accountLoginLater}</button>
    </div>;
  }

  return <form className="account-sheet" data-testid="recover-login" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className="caption">{text.recoverHint}</p>
    <label className="group-title" htmlFor="recover-email">{text.accountLoginEmail}</label>
    <input id="recover-email" type="email" inputMode="email" autoComplete="email" value={email}
      onChange={event => setEmail(event.target.value)} />
    <label className="group-title" htmlFor="recover-password">{text.accountLoginPassword}</label>
    <input id="recover-password" type="password" autoComplete="current-password" value={password}
      onChange={event => setPassword(event.target.value)} />
    {error === 'invalidCredentials' && <p role="alert" data-testid="recover-invalid">{text.accountLoginInvalid}</p>}
    {error === 'noHosts' && <p role="alert" data-testid="recover-nohosts">{text.recoverNoHosts}</p>}
    <button type="submit" className="primary" data-testid="recover-submit" disabled={busy || !email.trim() || !password}>
      {busy ? text.connecting : text.accountLoginSubmit}
    </button>
    <p className="caption">{text.recoverFooter}</p>
  </form>;
}
