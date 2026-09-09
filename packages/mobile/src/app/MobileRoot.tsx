import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { PlatformPorts } from '../platform/ports';
import { createMobileStore } from '../stores/mobileStore';
import { createCompanionStore } from '../stores/companionStore';
import { COMPANION_LIMITS } from '../../../../src/shared/constants/companion';
import { CompanionConversation } from '../features/sessions/CompanionConversation';
import { messages } from '../i18n';
import { createBackCoordinator } from './backCoordinator';
import { SheetHost } from './SheetHost';
import { SettingsPage } from '../features/settings/SettingsPage';
import { VirtualHistory } from '../features/sessions/VirtualHistory';
import { NeoBrandMark } from '../features/brand/NeoBrandMark';

export function MobileRoot({ ports, fixtures }: { ports: PlatformPorts; fixtures: boolean }) {
  const [store] = useState(() => createMobileStore(ports.preferences));
  const [companionStore] = useState(() => createCompanionStore(ports.companion, acceptedText => {
    return store.getState().acknowledgeDraft(acceptedText);
  }));
  const companion = useStore(companionStore);
  const state = useStore(store);
  const text = messages(navigator.language);
  const [appInfo, setAppInfo] = useState<{ version: string; build: string } | null>(null);
  const [nativeError, setNativeError] = useState(false);
  // Native pushes the Android night flag (WebView 95 never updates prefers-color-scheme); matchMedia covers web/iOS.
  const [systemDark, setSystemDark] = useState(() => document.documentElement.dataset.systemNight === 'true'
    || matchMedia('(prefers-color-scheme: dark)').matches);
  const keyboardVisible = useRef(false);
  const composing = useRef(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const theme = state.preferences.appearance === 'system' ? (systemDark ? 'dark' : 'light') : state.preferences.appearance;
  const currentPage = state.sheet?.pages.at(-1);

  // Text selections inside the composer never surface through window.getSelection on WebKit,
  // and long-press selection on WebView only lives in the element's own range.
  const selectedInput = () => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? active : null;
  };
  const textSelected = () => {
    if (window.getSelection()?.toString()) return true;
    const input = selectedInput();
    return !!input && input.selectionStart !== input.selectionEnd;
  };
  const clearTextSelection = () => {
    if (window.getSelection()?.toString()) { window.getSelection()?.removeAllRanges(); return; }
    const input = selectedInput();
    if (input) input.setSelectionRange(input.selectionEnd, input.selectionEnd);
  };
  useEffect(() => {
    void store.getState().hydrate();
    void ports.appInfo.read().then(setAppInfo).catch(() => setAppInfo(null));
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const register = (promise: Promise<() => void>) => void promise.then(cleanup => {
      if (disposed) cleanup(); else cleanups.push(cleanup);
    }).catch(() => { if (!disposed) setNativeError(true); });
    const back = createBackCoordinator({
      ports,
      hasSelection: textSelected,
      clearSelection: clearTextSelection,
      isKeyboardVisible: () => keyboardVisible.current,
      dismissLayer: () => store.getState().back(),
      onNativeError: () => setNativeError(true),
    });
    register(ports.lifecycle.subscribe(active => {
      if (!active) { void store.getState().flush(); companionStore.getState().pause(); }
      else if (companionStore.getState().binding) void companionStore.getState().reconnect();
    }, back.onBack));
    register(ports.keyboard.subscribe(visible => { keyboardVisible.current = visible; }));
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); back.onBack(); } };
    document.addEventListener('keydown', escape);
    const query = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(document.documentElement.dataset.systemNight === 'true' || query.matches);
    document.addEventListener('neo-system-night', change);
    query.addEventListener('change', change);
    // Native resize and visualViewport already reflect IME; never subtract keyboard height twice.
    const resize = () => document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport?.height ?? innerHeight}px`);
    resize(); window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize);
    return () => {
      companionStore.getState().pause();
      disposed = true; cleanups.forEach(cleanup => cleanup());
      document.removeEventListener('keydown', escape); document.removeEventListener('neo-system-night', change); query.removeEventListener('change', change);
      window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize);
    };
  }, [ports, store, companionStore]);
  useEffect(() => { if (state.ready) void companionStore.getState().hydrate(); }, [state.ready, companionStore]);
  useEffect(() => {
    if (companion.status !== 'connected') return;
    void companionStore.getState().sync();
    const timer = setInterval(() => { void companionStore.getState().sync(); }, COMPANION_LIMITS.pollIntervalMs);
    return () => clearInterval(timer);
  }, [companion.status, companionStore]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    void ports.systemBars.setStyle(theme).catch(() => {});
  }, [ports, theme]);

  const pairAndOpenConversation = async () => {
    await companionStore.getState().pair();
    const result = companionStore.getState();
    if (result.status === 'connected' && result.sessionId) store.getState().navigate('new');
  };

  const gestureStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1 || state.sheet || keyboardVisible.current ||
      textSelected() || (event.target as Element).closest('button,input,textarea,[data-testid="history"]') || touch.clientX < 24) return;
    swipe.current = { x: touch.clientX, y: touch.clientY };
  };
  const gestureEnd = (event: React.TouchEvent) => {
    const start = swipe.current; swipe.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || textSelected() || Math.abs(touch.clientY - start.y) > 60) return;
    if (state.drawer && touch.clientX - start.x < -86) state.closeDrawer();
    else if (!state.drawer && touch.clientX - start.x > 86) state.openDrawer();
  };
  if (!state.ready) return <div className="loading" role="status"><p>{state.loadError ? text.loadError : text.loading}</p>
    {state.loadError && <button onClick={() => void state.hydrate()}>{text.retry}</button>}</div>;

  return <div className="app" data-theme={theme} onTouchStart={gestureStart} onTouchEnd={gestureEnd} onTouchCancel={() => { swipe.current = null; }}>
    <main className="conversation" inert={state.drawer || !!state.sheet}>
      <header className="topbar"><button aria-label={text.sessions} data-testid="open-drawer" onClick={state.openDrawer}>☰</button>
        <strong>{companion.sessionId ? `${text.sharedSession} ${(companion.binding?.scope.indexOf(companion.sessionId) ?? 0) + 1}` : state.route === 'new' ? text.neo : text.fixture}</strong><button aria-label={text.more} data-testid="open-more" onClick={() => state.openSheet('more')}>···</button></header>
      {state.route === 'fixture' && fixtures ? <VirtualHistory text={text} /> : companion.sessionId && companion.events.some(event => event.sessionId === companion.sessionId)
        ? <CompanionConversation events={companion.events} sessionId={companion.sessionId} text={text}
          disabled={companion.busy || companion.pending || companion.status !== 'connected'} respond={companion.respond} />
        : <div className="welcome"><NeoBrandMark /><h1>{companion.status === 'connected' ? text.connectedReady : text.welcome}</h1>{companion.status === 'connected' && <p className="connection-next">{text.connectedNext}</p>}</div>}
      <div className="composer-area">
        {companion.binding && <p role="status" className="caption">{companion.pending ? text.pendingCommand : companion.status === 'connected' ? text.connected : companion.status === 'connecting' ? text.connecting : companion.status === 'storageError' ? text.secureStorageError : companion.status === 'rejected' ? text.rejected : text.unconnected}</p>}
        {companion.terminal && <p role="status" className="caption">{text[companion.terminal]}</p>}
        {companion.runId && <button disabled={companion.busy || companion.pending || companion.status !== 'connected'} onClick={() => void companion.stop()}>{text.stop}</button>}
        {fixtures && <p className="caption">{text.fixtureNotice}</p>}
        {(state.saveError || nativeError || (state.sendAttempted && companion.status !== 'connected')) && <p role="status" className="notice">
          {state.saveError ? text.saveError : nativeError ? text.nativeError : text.unconnected}
          {state.saveError && <button onClick={() => void state.flush()}>{text.retry}</button>}
        </p>}
        <div className="composer">
          <textarea ref={textarea} aria-label={text.draft} placeholder={text.placeholder} rows={2}
            value={state.preferences.drafts[state.route]} data-testid="draft"
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onChange={event => state.editDraft(event.target.value)} />
          <div className="composer-actions"><button aria-label={text.projects} onClick={() => state.openSheet('projects')}>＋</button>
            <button className="send" aria-label={text.send} data-testid="send" disabled={!state.preferences.drafts[state.route].trim() || companion.busy || companion.pending}
              onClick={() => { if (!composing.current) {
                if (companion.status === 'connected' && state.route !== 'fixture') void companion.send(state.preferences.drafts[state.route]);
                else state.attemptSend();
              } }}>↑</button></div>
        </div>
      </div>
    </main>
    {state.drawer && <div className="drawer-layer" inert={!!state.sheet}>
      <button className="scrim" aria-label={text.closeDrawer} onClick={state.closeDrawer} />
      <aside className="drawer" aria-label={text.sessions}>
        <div className="drawer-functions"><header><strong>{text.neo}</strong>{!companion.binding && <button aria-label={text.newSession} data-testid="new-session" onClick={() => state.navigate('new')}>＋</button>}</header>
          {!companion.binding && <button onClick={() => state.navigate('new')}>{text.newSession}</button>}
          <button onClick={() => state.openSheet('projects')}>{text.projects}</button><button onClick={() => state.openSheet('remote')}>{text.remote}</button></div>
        <nav className="drawer-history" aria-label={text.history}><p className="group-title">{text.history}</p>
          {companion.binding?.scope.map((id, index) => <button key={id} onClick={() => { companion.selectSession(id); state.navigate('new'); }}>{text.sharedSession} {index + 1}</button>)}
          {fixtures ? Array.from({ length: 60 }, (_, n) => <button key={n} onClick={() => state.navigate('fixture')} data-testid={n === 0 ? 'fixture-session' : undefined}>{text.fixture} {n + 1}</button>) : <p className="caption">{text.emptyHistory}</p>}
        </nav>
        <button className="personal-bar" aria-label={text.personal} data-testid="open-settings" onClick={() => state.openSheet('settings')}>
          <span className="avatar">{(state.preferences.nickname || text.guest).slice(0, 1)}</span><strong>{state.preferences.nickname || text.guest}</strong><span aria-hidden="true">⚙</span>
        </button>
      </aside>
    </div>}
    {state.sheet && currentPage && <SheetHost page={currentPage} title={text[currentPage]} hasParent={state.sheet.pages.length > 1}
      close={state.closeSheet} back={state.back} text={text}>
      {currentPage === 'remote' ? <div className="settings-group">
        <p>{text.lanHint}</p>
        {companion.status === 'connected' ? <div className="connection-success" role="status"><span className="connection-check" aria-hidden="true">✓</span><strong>{text.connected}</strong><p>{text.connectedNext}</p></div>
          : <p role="status">{companion.status === 'connecting' ? text.connecting : companion.status === 'storageError' ? text.secureStorageError : text.unconnected}</p>}
        {companion.status === 'connected' && <button className="primary" onClick={() => state.navigate('new')}>{text.enterConversation}</button>}
        {!ports.companion && <p>{text.nativeConnectionOnly}</p>}
        <button className={companion.status === 'connected' ? undefined : 'primary'} disabled={!ports.companion || companion.busy || companion.pending} onClick={() => void pairAndOpenConversation()}>{text.scan}</button>
        {ports.companion && <button disabled={companion.busy} onClick={() => void companion.reconnect()}>{text.reconnect}</button>}
      </div> : <SettingsPage page={currentPage} text={text} appearance={state.preferences.appearance} nickname={state.preferences.nickname}
        profileDraft={state.profileDraft} appInfo={appInfo} open={state.pushSheet} chooseAppearance={state.setAppearance}
        editProfile={state.editProfile} saveProfile={state.saveProfile} />}
    </SheetHost>}
  </div>;
}
