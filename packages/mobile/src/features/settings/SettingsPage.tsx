import type { messages } from '../../i18n';
import type { Appearance, SheetPage } from '../../stores/mobileStore';
import { NeoBrandMark } from '../brand/NeoBrandMark';
import { AppIcon } from '../../app/AppIcon';

export function SettingsPage({ page, text, appearance, nickname, profileDraft, appInfo, open, chooseAppearance, editProfile, saveProfile }: {
  page: SheetPage; text: ReturnType<typeof messages>; appearance: Appearance; nickname: string;
  profileDraft: string; appInfo: { version: string; build: string } | null;
  open(page: SheetPage): void; chooseAppearance(value: Appearance): void; editProfile(value: string): void; saveProfile(): void;
}) {
  const row = (target: SheetPage, detail?: string) => <button className="settings-row" data-testid={`open-${target}`} onClick={() => open(target)}>
    <span>{text[target]}</span><span className="row-detail">{detail}<AppIcon name="chevron" /></span>
  </button>;
  switch (page) {
    case 'settings': return <>
      <button className="profile-card" onClick={() => open('profile')} data-testid="open-profile">
        <span className="avatar">{(nickname || text.guest).slice(0, 1)}</span><strong>{nickname || text.guest}</strong><AppIcon name="chevron" />
      </button>
      <p className="group-title">{text.preferences}</p><div className="settings-group">{row('appearance', text[appearance])}</div>
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
    </form>;
    case 'about': return <div className="about"><NeoBrandMark size={56} /><h3>{text.neo}</h3>
      <p>{text.aboutDescription}</p><p data-testid="app-version">{appInfo ? `${text.version} ${appInfo.version}（${appInfo.build}）` : text.unavailableVersion}</p>
    </div>;
    case 'help': return <p>{text.helpBody}</p>;
    case 'projects': return <p>{text.noProjects}</p>;
    case 'remote': return <><h3>{text.noComputers}</h3><p>{text.baseNotice}</p></>;
    case 'more': return <div className="settings-group">{row('projects')}{row('remote')}</div>;
  }
}
