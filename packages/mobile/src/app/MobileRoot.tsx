import { VoiceInput } from '../features/sessions/VoiceInput';
import { LibrarySheet } from '../features/sessions/LibrarySheet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { PlatformPorts } from '../platform/ports';
import { createMobileStore } from '../stores/mobileStore';
import { canAddressSession, createCompanionStore } from '../stores/companionStore';
import { COMPANION_LIMITS } from '../../../../src/shared/constants/companion';
import { ApprovalCard } from '../features/sessions/ApprovalCard';
import { CompanionConversation } from '../features/sessions/CompanionConversation';
import { messages } from '../i18n';
import { createBackCoordinator } from './backCoordinator';
import { SheetHost } from './SheetHost';
import { SettingsPage } from '../features/settings/SettingsPage';
import { VirtualHistory } from '../features/sessions/VirtualHistory';
import { NeoBrandMark } from '../features/brand/NeoBrandMark';
import { AppIcon } from './AppIcon';

export function MobileRoot({ ports, fixtures }: { ports: PlatformPorts; fixtures: boolean }) {
  const [store] = useState(() => createMobileStore(ports.preferences));
  const [companionStore] = useState(() => createCompanionStore(ports.companion, (acceptedText, sessionId, hostKey) => {
    return store.getState().acknowledgeDraft(acceptedText, `${hostKey}:${sessionId}`);
  }, (text, sessionId, hostKey, commandId) => store.getState().appendTranscript(text, `${hostKey}:${sessionId}`, commandId)));
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
  const managing = useRef(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const theme = state.preferences.appearance === 'system' ? (systemDark ? 'dark' : 'light') : state.preferences.appearance;
  const currentPage = state.sheet?.pages.at(-1);
  const pendingApprovals = useMemo(() => {
    const cards = new Map<string, Record<string, unknown>>();
    for (const event of companion.events) if (event.kind === 'approval' && typeof event.payload.requestId === 'string') {
      cards.set(event.payload.requestId, { ...cards.get(event.payload.requestId), ...event.payload, sessionId: event.sessionId });
    }
    return [...cards.values()].filter(card => card.status === 'pending');
  }, [companion.events, companion.sessionId]);
  const mineApproval = pendingApprovals.find(card => card.sessionId === companion.sessionId);
  const otherApproval = pendingApprovals.find(card => card.sessionId !== companion.sessionId);

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
    void companionStore.getState().refreshLibrary();
    void companionStore.getState().sync();
    const timer = setInterval(() => { void companionStore.getState().sync(); }, COMPANION_LIMITS.pollIntervalMs);
    return () => clearInterval(timer);
  }, [companion.status, companionStore]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // #1737 起 systemBars 是可选口（并非所有宿主都提供系统栏控制），必须可选链。
    void ports.systemBars?.setStyle(theme).catch(() => {});
  }, [ports, theme]);

  useEffect(() => {
    const input = textarea.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }
  }, [state.preferences.drafts, state.ready]);

  useEffect(() => {
    if (companion.sessionId && companion.binding && state.route !== 'fixture') {
      store.getState().activateDraft(`${companion.binding.hostKey}:${companion.sessionId}`);
      void companionStore.getState().loadHistory(companion.sessionId);
    } else if (state.route !== 'fixture') store.getState().activateDraft('new');
  }, [companion.sessionId, companion.binding?.hostKey, companion.status, state.route, store, companionStore]);
  const selectSession = (id: string) => { companion.selectSession(id); state.navigate('new'); };
  const manage: typeof companion.manage = async (...args) => {
    managing.current = true;
    await companion.manage(...args);
    if (!companionStore.getState().pending && companionStore.getState().status === 'connected') state.navigate('new');
  };
  useEffect(() => {
    if (managing.current && !companion.pending && !companion.busy) {
      managing.current = false;
      if (companion.status === 'connected') store.getState().navigate('new');
    }
  }, [companion.pending, companion.busy, companion.status, store]);
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
      <header className="topbar"><button aria-label={text.sessions} data-testid="open-drawer" onClick={state.openDrawer}><AppIcon name="menu" /></button>
        <strong>{companion.sessionId ? companion.library?.sessions.find(s => s.id === companion.sessionId)?.title ?? `${text.sharedSession} ${(companion.binding?.scope.indexOf(companion.sessionId) ?? 0) + 1}` : state.route === 'new' ? text.neo : text.fixture}</strong><button aria-label={text.more} data-testid="open-more" onClick={() => state.openSheet('more')}><AppIcon name="more" /></button></header>
      {state.route === 'fixture' && fixtures ? <VirtualHistory text={text} /> : companion.sessionId && (companion.history[companion.sessionId]?.messages.length || companion.history[companion.sessionId]?.nextOffset != null || companion.events.some(event => event.sessionId === companion.sessionId))
        ? <CompanionConversation history={companion.history[companion.sessionId]} loadMore={() => void companion.loadHistory(companion.sessionId!, true)} hidePendingApprovals events={companion.events} sessionId={companion.sessionId} text={text}
          disabled={companion.busy || companion.pending || companion.status !== 'connected'} respond={companion.respond} />
        : <div className="welcome"><NeoBrandMark /><h1>{companion.status === 'connected' ? text.connectedReady : text.welcome}</h1>{companion.status === 'connected' && <p className="connection-next">{text.connectedNext}</p>}</div>}
      <div className="composer-area">
        {/* 本会话的审批优先在托盘里就地给控件——CompanionConversation 被传了
            hidePendingApprovals，它不会再渲染 pending 卡片，所以这里是本会话审批**唯一**的
            落点。原写法只看全局第一条：会话 A 先有一条没处理的审批时，在会话 B 触发的审批
            既不在对话里、也不在托盘里，B 的 run 在手机上没有任何 approve/deny 可点，
            用户得先猜到要去 A 处理完才能回来。别的会话那条仍然给一个跳转按钮，不互相挤掉。 */}
        {(mineApproval || otherApproval) && <div className="approval-tray" aria-live="polite">
          {mineApproval && <ApprovalCard card={mineApproval} text={text} disabled={companion.busy || companion.pending || companion.status !== 'connected'}
            respond={decision => companion.respond(String(mineApproval.requestId), decision)} />}
          {otherApproval && <button className="primary" onClick={() => selectSession(String(otherApproval.sessionId))}>{text.reviewApproval}</button>}
        </div>}
        {companion.binding && <div className="task-status" role="status">
          <button className="connection-pill" data-connected={companion.status === 'connected'} onClick={() => state.openSheet('remote')}>
            <span aria-hidden="true" className="status-dot" />{companion.status === 'connected' ? text.connected : companion.status === 'connecting' ? text.connecting : text.reconnect}
          </button>
          <span>{companion.pending ? text.pendingCommand : companion.runId ? text.running : companion.terminal ? text[companion.terminal] : ''}</span>
          {companion.runId && <button disabled={companion.busy || companion.pending || companion.status !== 'connected'} onClick={() => void companion.stop()}>{text.stop}</button>}
        </div>}
        {companion.binding && !['connected', 'connecting'].includes(companion.status) && <div className="connection-recovery">
          <p>{companion.status === 'storageError' ? text.secureStorageError : companion.status === 'rejected' ? text.rejected : companion.connectionError ? text[companion.connectionError] : text.unconnected}</p>
          <button disabled={companion.busy} onClick={() => void companion.reconnect()}>{text.retry}</button>
        </div>}
        {companion.libraryError && <p className="notice" role="status">{text.libraryError}<button onClick={() => void companion.reconnect()}>{text.reconnect}</button></p>}
        {fixtures && <p className="caption">{text.fixtureNotice}</p>}
        {(state.saveError || nativeError || companion.commandError || (state.sendAttempted && !canAddressSession(companion))) && <p role="status" className="notice">
          {state.saveError ? text.saveError
            : nativeError ? text.nativeError
            : companion.commandError ? text.commandRejected
            : companion.status === 'connected' ? text.noSession
            : text.unconnected}
          {state.saveError && <button onClick={() => void state.flush()}>{text.retry}</button>}
          {!state.saveError && !nativeError && !companion.commandError && companion.status === 'connected'
            && <button onClick={() => state.openSheet('projects')}>{text.projects}</button>}
        </p>}
        <div className="composer">
          <textarea ref={textarea} aria-label={text.draft} placeholder={text.placeholder} rows={1}
            value={(state.preferences.drafts[state.draftKey] ?? '')} data-testid="draft"
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onChange={event => state.editDraft(event.target.value)} />
          <div className="composer-actions"><button aria-label={text.projects} onClick={() => state.openSheet('projects')}><AppIcon name="plus" /></button>
            {ports.recorder && companion.sessionId && <VoiceInput key={`${companion.binding?.hostKey}:${companion.sessionId}`} recorder={ports.recorder} text={text}
              disabled={companion.status !== 'connected' || companion.busy || companion.pending} pending={companion.pending} outcome={companion.voiceOutcome} transcribe={audio => companion.transcribe(audio, companion.sessionId!, companion.binding!.hostKey)} />}
            <button className="send" aria-label={text.send} data-testid="send" disabled={!(state.preferences.drafts[state.draftKey] ?? '').trim() || companion.busy || companion.pending}
              onClick={() => { if (!composing.current) {
                // companionStore.send 在没有 sessionId 时会静默 return（只勾了项目的二维码
                // 配对就是这个形态）。不把这一档也走 attemptSend 的话，用户看到「已连接」、
                // 点发送却什么都不发生——无报错、无 pending、草稿不清，只能反复点。
                if (canAddressSession(companion) && state.route !== 'fixture') void companion.send((state.preferences.drafts[state.draftKey] ?? ''));
                else state.attemptSend();
              } }}><AppIcon name="arrow" /></button></div>
        </div>
      </div>
    </main>
    {state.drawer && <div className="drawer-layer" inert={!!state.sheet}>
      <button className="scrim" aria-label={text.closeDrawer} onClick={state.closeDrawer} />
      <aside className="drawer" aria-label={text.sessions}>
        <div className="drawer-functions"><header><strong>{text.neo}</strong>{<button aria-label={text.newSession} data-testid="new-session" onClick={() => companion.binding ? state.openSheet('projects') : state.navigate('new')}><AppIcon name="plus" /></button>}</header>
          <button onClick={() => companion.binding ? state.openSheet('projects') : state.navigate('new')}>{text.newSession}</button>
          <button onClick={() => state.openSheet('projects')}>{text.projects}</button><button onClick={() => state.openSheet('remote')}>{text.remote}</button></div>
        <nav className="drawer-history" aria-label={text.history}><p className="group-title">{text.history}</p>
          {companion.library?.sessions.map(session => <button key={session.id} aria-current={session.id === companion.sessionId ? 'page' : undefined} onClick={() => selectSession(session.id)}>{session.title}{session.archived ? ` · ${text.archived}` : ''}</button>)}
          {companion.library?.nextOffset != null && <button onClick={() => void companion.refreshLibrary(true)}>{text.loadHistory}</button>}
          {fixtures ? Array.from({ length: 60 }, (_, n) => <button key={n} onClick={() => state.navigate('fixture')} data-testid={n === 0 ? 'fixture-session' : undefined}>{text.fixture} {n + 1}</button>) : !companion.library?.sessions.length && <p className="caption">{text.emptyHistory}</p>}
        </nav>
        <button className="personal-bar" aria-label={text.personal} data-testid="open-settings" onClick={() => state.openSheet('settings')}>
          <span className="avatar">{(state.preferences.nickname || text.guest).slice(0, 1)}</span><strong>{state.preferences.nickname || text.guest}</strong><AppIcon name="settings" />
        </button>
      </aside>
    </div>}
    {state.sheet && currentPage && <SheetHost page={currentPage} title={text[currentPage]} hasParent={state.sheet.pages.length > 1}
      close={state.closeSheet} back={state.back} text={text}>
      {pendingApprovals.length > 0 && <button className="primary" onClick={() => selectSession(String(pendingApprovals[0].sessionId))}>{text.reviewApproval}</button>}
      {(currentPage === 'projects' || currentPage === 'more') && companion.binding ? <>
        {companion.library ? <LibrarySheet key={`${currentPage}:${companion.sessionId}`} library={companion.library} sessionId={companion.sessionId} text={text} mode={currentPage} busy={companion.busy || companion.pending || companion.status !== 'connected'} select={selectSession} manage={manage} loadMore={() => void companion.refreshLibrary(true)} /> : <p>{companion.libraryError ? text.libraryError : text.loading}</p>}
        <button onClick={() => void companion.refreshLibrary()}>{text.retry}</button>
      </> : currentPage === 'remote' ? <div className="settings-group">
        <p>{text.lanHint}</p>
        {companion.status === 'connected' ? <div className="connection-success" role="status"><span className="connection-check"><AppIcon name="check" /></span><strong>{text.connected}</strong><p>{text.connectedNext}</p></div>
          : <p role="status">{companion.status === 'connecting' ? text.connecting : companion.status === 'storageError' ? text.secureStorageError : companion.connectionError ? text[companion.connectionError] : text.unconnected}</p>}
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
