// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import {
  COMPOSER_DRAFT_DEBOUNCE_MS,
  COMPOSER_DRAFT_SEND_TIMEOUT_MS,
  composerDraftStorageKey,
  createComposerDraftWriter,
  readComposerDraft,
} from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';
import { useComposerDraftPersistence } from '../../../src/renderer/components/features/chat/ChatInput/useComposerDraftPersistence';
import { adoptHomeDraft } from '../../../src/renderer/stores/sessionBootDraft';
import { UnsentDraftNotice } from '../../../src/renderer/components/features/chat/ChatInput/UnsentDraftNotice';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

class FlushTarget {
  private listeners = new Set<() => void>();
  addEventListener(_type: string, listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: () => void): void { this.listeners.delete(listener); }
  emit(): void { for (const listener of this.listeners) listener(); }
}

class VisibilityTarget extends FlushTarget {
  visibilityState = 'visible';
}

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const KEY_A = composerDraftStorageKey(SESSION_A, false)!;
const KEY_B = composerDraftStorageKey(SESSION_B, false)!;

function DraftHarness({ sessionId = SESSION_A, sessionless = false }: { sessionId?: string | null; sessionless?: boolean }) {
  const [value, setValue] = useState('');
  const draft = useComposerDraftPersistence({ sessionId, sessionless, value, setValue });
  return (
    <div>
      {draft.notice && (
        <UnsentDraftNotice
          preview={draft.notice.preview}
          onPutBack={draft.putBack}
          onDiscard={draft.discard}
        />
      )}
      <textarea
        data-testid="composer-draft-box"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </div>
  );
}

describe('composer draft store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('debounces a write per session and does not store whitespace', () => {
    const storage = memoryStorage();
    const page = new FlushTarget();
    const visibility = new VisibilityTarget();
    const writer = createComposerDraftWriter({
      storage,
      pageTarget: page,
      visibilityTarget: visibility,
    });

    const homeKey = composerDraftStorageKey(null, false);
    expect(homeKey).toEqual(expect.stringMatching(/^neo\.composerDraft\.v1:/));
    if (!homeKey) throw new Error('home composer key missing');
    expect(homeKey).not.toBe(KEY_A);
    expect(composerDraftStorageKey(SESSION_A, true)).toBeNull();
    writer.flushNow(KEY_A, '   \n\t', () => false);
    expect(readComposerDraft(KEY_A, storage)).toBeNull();
    expect(storage.getItem(KEY_A)).toBeNull();

    writer.schedule(KEY_A, 'from A', () => false);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS - 1); });
    expect(readComposerDraft(KEY_A, storage)).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(readComposerDraft(KEY_A, storage)).toBe('from A');

    writer.schedule(KEY_B, 'from B', () => false);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_B, storage)).toBe('from B');
    expect(readComposerDraft(KEY_A, storage)).toBe('from A');

    writer.schedule(KEY_A, '   \n\t', () => false);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A, storage)).toBeNull();
    expect(storage.getItem(KEY_A)).toBeNull();

    writer.schedule(KEY_B, 'keep during send', () => false);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS); });
    writer.schedule(KEY_B, '   ', () => true);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_B, storage)).toBe('keep during send');

    writer.schedule(composerDraftStorageKey(null, true), 'sessionless', () => false);
    act(() => { vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(storage.getItem(homeKey)).toBeNull();

    writer.schedule(homeKey, 'home brief', () => false);
    page.emit();
    expect(readComposerDraft(homeKey, storage)).toBe('home brief');

    writer.schedule(homeKey, 'hidden brief', () => false);
    visibility.visibilityState = 'hidden';
    visibility.emit();
    expect(readComposerDraft(homeKey, storage)).toBe('hidden brief');
    writer.dispose();
  });
});

describe('useComposerDraftPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('deletes the stored draft only after a successful send', async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useComposerDraftPersistence({
        sessionId: SESSION_A,
        sessionless: false,
        value,
        setValue: () => undefined,
      }),
      { initialProps: { value: 'keep until success' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('keep until success');

    let resolveSend: (value: boolean) => void = () => undefined;
    const pendingSend = new Promise<boolean>((resolve) => { resolveSend = resolve; });
    let tracked: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { tracked = result.current.trackSend(() => pendingSend); });
    expect(readComposerDraft(KEY_A)).toBe('keep until success');
    rerender({ value: '' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('keep until success');
    await act(async () => {
      resolveSend(true);
      await tracked;
    });
    expect(readComposerDraft(KEY_A)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBeNull();
  });

  it('keeps the stored draft when onSend returns false, throws, or times out', async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useComposerDraftPersistence({
        sessionId: SESSION_A,
        sessionless: false,
        value,
        setValue: () => undefined,
      }),
      { initialProps: { value: 'still here' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });

    let resolveSend: (value: boolean) => void = () => undefined;
    const pendingSend = new Promise<boolean>((resolve) => { resolveSend = resolve; });
    let tracked: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { tracked = result.current.trackSend(() => pendingSend); });
    rerender({ value: '' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('still here');
    await act(async () => {
      resolveSend(false);
      await tracked;
    });
    expect(readComposerDraft(KEY_A)).toBe('still here');
    rerender({ value: 'still here' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('still here');

    await expect(act(async () => {
      await result.current.trackSend(() => { throw new Error('send failed closed'); });
    })).rejects.toThrow('send failed closed');
    expect(readComposerDraft(KEY_A)).toBe('still here');

    let timed: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { timed = result.current.trackSend(() => new Promise<boolean>(() => undefined)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_SEND_TIMEOUT_MS); });
    await expect(timed).resolves.toBe('timeout');
    expect(readComposerDraft(KEY_A)).toBe('still here');
  });

  it('deletes the draft of the session that sent, not the one current when the send settles', async () => {
    const seeder = createComposerDraftWriter({ pageTarget: null, visibilityTarget: null });
    seeder.flushNow(KEY_B, 'beta text', () => false);
    seeder.dispose();

    const { result, rerender } = renderHook(
      ({ sessionId, value }: { sessionId: string; value: string }) => useComposerDraftPersistence({
        sessionId,
        sessionless: false,
        value,
        setValue: () => undefined,
      }),
      { initialProps: { sessionId: SESSION_A, value: 'alpha send' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('alpha send');

    let resolveSend: (value: boolean) => void = () => undefined;
    const pendingSend = new Promise<boolean>((resolve) => { resolveSend = resolve; });
    let tracked: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { tracked = result.current.trackSend(() => pendingSend); });
    // The optimistic clear already emptied the box; the user switches to
    // session B while the send from A is still in flight.
    rerender({ sessionId: SESSION_B, value: '' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });

    await act(async () => {
      resolveSend(true);
      await tracked;
    });
    expect(readComposerDraft(KEY_A)).toBeNull();
    expect(readComposerDraft(KEY_B)).toBe('beta text');
    expect(result.current.notice?.preview).toBe('beta text');

    // Back on A the successful send is not offered again.
    rerender({ sessionId: SESSION_A, value: '' });
    expect(result.current.notice).toBeNull();
  });

  it('does not store queued-edit text or drop the idle draft when that edit ends', async () => {
    const { rerender } = renderHook(
      ({ value, suspend }: { value: string; suspend: boolean }) => useComposerDraftPersistence({
        sessionId: SESSION_A,
        sessionless: false,
        value,
        setValue: () => undefined,
        suspend,
      }),
      { initialProps: { value: 'idle brief', suspend: false } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('idle brief');

    rerender({ value: 'queued body that must stay out of the idle draft', suspend: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('idle brief');

    rerender({ value: '', suspend: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('idle brief');
  });

  it('flushes the previous session before the box is cleared', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId, value }: { sessionId: string; value: string }) => useComposerDraftPersistence({
        sessionId,
        sessionless: false,
        value,
        setValue: () => undefined,
      }),
      { initialProps: { sessionId: SESSION_A, value: 'alpha text' } },
    );
    const seeder = createComposerDraftWriter({ pageTarget: null, visibilityTarget: null });
    seeder.flushNow(KEY_B, 'beta text', () => false);
    seeder.dispose();
    rerender({ sessionId: SESSION_B, value: 'alpha text' });
    rerender({ sessionId: SESSION_B, value: '' });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(KEY_A)).toBe('alpha text');
    expect(readComposerDraft(KEY_B)).toBe('beta text');
    expect(result.current.notice?.preview).toBe('beta text');
  });
});

describe('UnsentDraftNotice restart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  const longText = `给 Neo 的长说明${'甲'.repeat(40)}`;

  async function typeAndUnmount(): Promise<void> {
    const view = render(<DraftHarness />);
    fireEvent.change(screen.getByTestId('composer-draft-box'), { target: { value: longText } });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    view.unmount();
  }

  it('shows the first 40 characters after remount, and put back fills the box', async () => {
    await typeAndUnmount();
    render(<DraftHarness />);
    const notice = screen.getByTestId('unsent-draft-notice');
    expect(notice.textContent).toContain('上次输入框里还有一段内容');
    expect(notice.textContent).toContain(longText.slice(0, 40));
    expect(notice.textContent).not.toContain(longText);

    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect((screen.getByTestId('composer-draft-box') as HTMLTextAreaElement).value).toBe(longText);
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
  });

  it('discard removes the stored draft and the notice', async () => {
    await typeAndUnmount();
    render(<DraftHarness />);
    fireEvent.click(screen.getByTestId('unsent-draft-discard'));
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
    expect(readComposerDraft(KEY_A)).toBeNull();
  });

  it('shows the card when boot adopts the home draft onto the already-mounted session', async () => {
    localStorage.setItem(composerDraftStorageKey(null, false)!, JSON.stringify({ v: 1, text: 'typed with no session' }));
    render(<DraftHarness sessionId="fresh-session" />);
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
    act(() => { adoptHomeDraft('fresh-session'); });
    expect(screen.getByTestId('unsent-draft-notice')).toBeTruthy();
    fireEvent.click(screen.getByTestId('unsent-draft-put-back'));
    expect((screen.getByTestId('composer-draft-box') as HTMLTextAreaElement).value).toBe('typed with no session');
  });

  it('home key (no session): saves, restores on a fresh mount, and clears after a successful send', async () => {
    const HOME = composerDraftStorageKey(null, false)!;
    const first = renderHook(
      ({ value }: { value: string }) => useComposerDraftPersistence({
        sessionId: null, sessionless: false, value, setValue: () => undefined,
      }),
      { initialProps: { value: 'home task description' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS); });
    expect(readComposerDraft(HOME)).toBe('home task description');
    first.unmount();

    const setValue = vi.fn();
    const second = renderHook(() => useComposerDraftPersistence({
      sessionId: null, sessionless: false, value: '', setValue,
    }));
    expect(second.result.current.notice?.preview).toBe('home task description');
    act(() => { second.result.current.putBack(); });
    expect(setValue).toHaveBeenCalledWith('home task description');

    let tracked: Promise<boolean | 'timeout'> = Promise.resolve(false);
    act(() => { tracked = second.result.current.trackSend(() => Promise.resolve(true)); });
    await act(async () => { await tracked; });
    expect(readComposerDraft(HOME)).toBeNull();
    expect(second.result.current.notice).toBeNull();
  });
});
