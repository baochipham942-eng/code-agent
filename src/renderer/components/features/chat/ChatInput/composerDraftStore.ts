// Per-session idle composer text. Attachments, voice, and @refs are not stored.
// localStorage only — the queued_inputs table is for messages already handed to the host.

export const COMPOSER_DRAFT_DEBOUNCE_MS = 400;
const COMPOSER_DRAFT_PREVIEW_LIMIT = 40;
export const COMPOSER_DRAFT_SEND_TIMEOUT_MS = 15_000;
const COMPOSER_DRAFT_KEY_PREFIX = 'neo.composerDraft.v1:';
const COMPOSER_DRAFT_HOME_KEY = `${COMPOSER_DRAFT_KEY_PREFIX}home`;

export type ComposerDraftSendOutcome = 'success' | 'failure' | 'timeout';

interface ComposerDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredComposerDraft {
  v: 1;
  text: string;
}

interface ComposerDraftFlushTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface ComposerDraftVisibilityTarget extends ComposerDraftFlushTarget {
  visibilityState: string;
}

interface PendingDraftWrite {
  key: string | null;
  text: string;
  isSendInFlight: () => boolean;
}

export interface ComposerDraftWriter {
  schedule(key: string | null, text: string, isSendInFlight: () => boolean): void;
  /** Drop the timer and write this pair now. Empty text does not delete while a send is in flight. */
  flushNow(key: string | null, text: string, isSendInFlight: () => boolean): void;
  /** Write whatever schedule() last queued. Used on page hide and before a session switch. */
  flushPending(): void;
  cancel(): void;
  dispose(): void;
}

export function composerDraftStorageKey(sessionId: string | null, sessionless: boolean): string | null {
  if (sessionless) return null;
  if (sessionId === null) return COMPOSER_DRAFT_HOME_KEY;
  return `${COMPOSER_DRAFT_KEY_PREFIX}${sessionId}`;
}

export function composerDraftPreview(text: string, limit = COMPOSER_DRAFT_PREVIEW_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function hasDraftText(text: string): boolean {
  return text.trim().length > 0;
}

export function readComposerDraft(
  key: string | null,
  storage?: Pick<ComposerDraftStorage, 'getItem'>,
): string | null {
  if (!key) return null;
  // Boot code also runs where localStorage does not exist (node tests, SSR): no storage = no draft.
  const source = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (!source) return null;
  try {
    const raw = source.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredComposerDraft>;
    if (parsed.v !== 1 || typeof parsed.text !== 'string' || !hasDraftText(parsed.text)) return null;
    return parsed.text;
  } catch {
    return null;
  }
}

/** Whitespace-only text is ignored: nothing is written and an existing value is left untouched. */
function writeComposerDraft(
  key: string | null,
  text: string,
  storage: ComposerDraftStorage = localStorage,
): boolean {
  if (!key || !hasDraftText(text)) return false;
  try {
    const payload: StoredComposerDraft = { v: 1, text };
    storage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Write only when the key holds no draft yet. Returns true when the key ends up holding this text. */
export function writeComposerDraftIfAbsent(key: string | null, text: string): boolean {
  if (readComposerDraft(key) !== null) return false;
  return writeComposerDraft(key, text);
}

export function removeComposerDraft(
  key: string | null,
  storage: Pick<ComposerDraftStorage, 'removeItem'> = localStorage,
): void {
  if (!key) return;
  try {
    storage.removeItem(key);
  } catch {
    // Private mode and quota failures leave the in-memory composer as the source of truth.
  }
}

function defaultPageTarget(): ComposerDraftFlushTarget | null {
  return typeof window === 'undefined' ? null : window;
}

function defaultVisibilityTarget(): ComposerDraftVisibilityTarget | null {
  return typeof document === 'undefined' ? null : document;
}

export function createComposerDraftWriter(options: {
  storage?: ComposerDraftStorage;
  delayMs?: number;
  pageTarget?: ComposerDraftFlushTarget | null;
  visibilityTarget?: ComposerDraftVisibilityTarget | null;
  onCommitted?: (key: string, text: string) => void;
  onRemoved?: (key: string) => void;
} = {}): ComposerDraftWriter {
  const storage = options.storage ?? localStorage;
  const delayMs = options.delayMs ?? COMPOSER_DRAFT_DEBOUNCE_MS;
  const pageTarget = options.pageTarget === undefined ? defaultPageTarget() : options.pageTarget;
  const visibilityTarget = options.visibilityTarget === undefined ? defaultVisibilityTarget() : options.visibilityTarget;
  let pending: PendingDraftWrite | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const commit = (entry: PendingDraftWrite): void => {
    if (!entry.key) return;
    if (!hasDraftText(entry.text)) {
      // Optimistic clear empties the box before anyone knows whether the send landed.
      // Deleting here would drop the only copy. A later success outcome removes it.
      if (entry.isSendInFlight()) return;
      removeComposerDraft(entry.key, storage);
      options.onRemoved?.(entry.key);
      return;
    }
    if (writeComposerDraft(entry.key, entry.text, storage)) {
      options.onCommitted?.(entry.key, entry.text);
    }
  };

  const cancelTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flushPending = (): void => {
    const entry = pending;
    pending = null;
    cancelTimer();
    if (entry) commit(entry);
  };

  const onPageHide = (): void => {
    flushPending();
  };

  const onVisibility = (): void => {
    if (visibilityTarget?.visibilityState === 'hidden') flushPending();
  };

  pageTarget?.addEventListener('pagehide', onPageHide);
  visibilityTarget?.addEventListener('visibilitychange', onVisibility);

  return {
    schedule(key, text, isSendInFlight) {
      pending = { key, text, isSendInFlight };
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        const entry = pending;
        pending = null;
        if (entry) commit(entry);
      }, delayMs);
    },
    flushNow(key, text, isSendInFlight) {
      pending = null;
      cancelTimer();
      commit({ key, text, isSendInFlight });
    },
    flushPending,
    cancel() {
      pending = null;
      cancelTimer();
    },
    dispose() {
      pending = null;
      cancelTimer();
      pageTarget?.removeEventListener('pagehide', onPageHide);
      visibilityTarget?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
