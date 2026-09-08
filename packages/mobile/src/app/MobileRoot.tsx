import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { PlatformPorts } from '../platform/ports';
import { createMobileStore } from '../stores/mobileStore';
import { messages } from '../i18n';
import { SheetHost } from './SheetHost';
import { SettingsPage } from '../features/settings/SettingsPage';
import { VirtualHistory } from '../features/sessions/VirtualHistory';

export function MobileRoot({ ports, fixtures }: { ports: PlatformPorts; fixtures: boolean }) {
  const [store] = useState(() => createMobileStore(ports.preferences));
  const state = useStore(store);
  const text = messages(navigator.language);
  const [appInfo, setAppInfo] = useState<{ version: string; build: string } | null>(null);
  const [nativeError, setNativeError] = useState(false);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const keyboardVisible = useRef(false);
  const composing = useRef(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const theme = state.preferences.appearance === 'system' ? (systemDark ? 'dark' : 'light') : state.preferences.appearance;
  const currentPage = state.sheet?.pages.at(-1);

  useEffect(() => {
    void store.getState().hydrate();
    void ports.appInfo.read().then(setAppInfo).catch(() => setAppInfo(null));
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const register = (promise: Promise<() => void>) => void promise.then(cleanup => {
      if (disposed) cleanup(); else cleanups.push(cleanup);
    }).catch(() => { if (!disposed) setNativeError(true); });
    const back = () => {
      if (window.getSelection()?.toString()) { window.getSelection()?.removeAllRanges(); return; }
      if (keyboardVisible.current) {
        void ports.keyboard.hide().catch(() => setNativeError(true)); return;
      }
      if (!store.getState().back()) void ports.lifecycle.leave().catch(() => setNativeError(true));
    };
    register(ports.lifecycle.subscribe(active => { if (!active) void store.getState().flush(); }, back));
    register(ports.keyboard.subscribe(visible => { keyboardVisible.current = visible; }));
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); back(); } };
    document.addEventListener('keydown', escape);
    const query = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(query.matches);
    query.addEventListener('change', change);
    // Native resize and visualViewport already reflect IME; never subtract keyboard height twice.
    const resize = () => document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport?.height ?? innerHeight}px`);
    resize(); window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize);
    return () => {
      disposed = true; cleanups.forEach(cleanup => cleanup());
      document.removeEventListener('keydown', escape); query.removeEventListener('change', change);
      window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize);
    };
  }, [ports, store]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const gestureStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1 || state.sheet || keyboardVisible.current ||
      window.getSelection()?.toString() || (event.target as Element).closest('button,input,textarea,[data-testid="history"]') || touch.clientX < 24) return;
    swipe.current = { x: touch.clientX, y: touch.clientY };
  };
  const gestureEnd = (event: React.TouchEvent) => {
    const start = swipe.current; swipe.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || window.getSelection()?.toString() || Math.abs(touch.clientY - start.y) > 60) return;
    if (state.drawer && touch.clientX - start.x < -86) state.closeDrawer();
    else if (!state.drawer && touch.clientX - start.x > 86) state.openDrawer();
  };
  if (!state.ready) return <div className="loading" role="status"><p>{state.loadError ? text.loadError : text.loading}</p>
    {state.loadError && <button onClick={() => void state.hydrate()}>{text.retry}</button>}</div>;

  return <div className="app" data-theme={theme} onTouchStart={gestureStart} onTouchEnd={gestureEnd} onTouchCancel={() => { swipe.current = null; }}>
    <main className="conversation" inert={state.drawer || !!state.sheet}>
      <header className="topbar"><button aria-label={text.sessions} data-testid="open-drawer" onClick={state.openDrawer}>☰</button>
        <strong>{state.route === 'new' ? text.neo : text.fixture}</strong><button aria-label={text.more} data-testid="open-more" onClick={() => state.openSheet('more')}>···</button></header>
      {state.route === 'fixture' && fixtures ? <VirtualHistory text={text} /> : <div className="welcome"><span className="brand">N<span>²</span></span><h1>{text.welcome}</h1></div>}
      <div className="composer-area">
        {fixtures && <p className="caption">{text.fixtureNotice}</p>}
        {(state.saveError || nativeError || state.sendAttempted) && <p role="status" className="notice">
          {state.saveError ? text.saveError : nativeError ? text.nativeError : text.unconnected}
          {state.saveError && <button onClick={() => void state.flush()}>{text.retry}</button>}
        </p>}
        <div className="composer">
          <textarea ref={textarea} aria-label={text.draft} placeholder={text.placeholder} rows={2}
            value={state.preferences.drafts[state.route]} data-testid="draft"
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onChange={event => state.editDraft(event.target.value)} />
          <div className="composer-actions"><button aria-label={text.projects} onClick={() => state.openSheet('projects')}>＋</button>
            <button className="send" aria-label={text.send} data-testid="send" disabled={!state.preferences.drafts[state.route].trim()}
              onClick={() => { if (!composing.current) state.attemptSend(); }}>↑</button></div>
        </div>
      </div>
    </main>
    {state.drawer && <div className="drawer-layer" inert={!!state.sheet}>
      <button className="scrim" aria-label={text.closeDrawer} onClick={state.closeDrawer} />
      <aside className="drawer" aria-label={text.sessions}>
        <div className="drawer-functions"><header><strong>{text.neo}</strong><button aria-label={text.newSession} data-testid="new-session" onClick={() => state.navigate('new')}>＋</button></header>
          <button onClick={() => state.navigate('new')}>{text.newSession}</button>
          <button onClick={() => state.openSheet('projects')}>{text.projects}</button><button onClick={() => state.openSheet('remote')}>{text.remote}</button></div>
        <nav className="drawer-history" aria-label={text.history}><p className="group-title">{text.history}</p>
          {fixtures ? Array.from({ length: 60 }, (_, n) => <button key={n} onClick={() => state.navigate('fixture')} data-testid={n === 0 ? 'fixture-session' : undefined}>{text.fixture} {n + 1}</button>) : <p className="caption">{text.emptyHistory}</p>}
        </nav>
        <button className="personal-bar" aria-label={text.personal} data-testid="open-settings" onClick={() => state.openSheet('settings')}>
          <span className="avatar">{(state.preferences.nickname || text.guest).slice(0, 1)}</span><strong>{state.preferences.nickname || text.guest}</strong><span aria-hidden="true">⚙</span>
        </button>
      </aside>
    </div>}
    {state.sheet && currentPage && <SheetHost page={currentPage} title={text[currentPage]} hasParent={state.sheet.pages.length > 1}
      close={state.closeSheet} back={state.back} text={text}>
      <SettingsPage page={currentPage} text={text} appearance={state.preferences.appearance} nickname={state.preferences.nickname}
        profileDraft={state.profileDraft} appInfo={appInfo} open={state.pushSheet} chooseAppearance={state.setAppearance}
        editProfile={state.editProfile} saveProfile={state.saveProfile} />
    </SheetHost>}
  </div>;
}
