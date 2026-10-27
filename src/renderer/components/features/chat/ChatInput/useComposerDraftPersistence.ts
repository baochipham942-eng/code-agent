import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COMPOSER_DRAFT_DEBOUNCE_MS,
  COMPOSER_DRAFT_SEND_TIMEOUT_MS,
  composerDraftPreview,
  composerDraftStorageKey,
  createComposerDraftWriter,
  readComposerDraft,
  removeComposerDraft,
  type ComposerDraftSendOutcome,
  type ComposerDraftWriter,
} from './composerDraftStore';

interface ComposerDraftNotice {
  text: string;
  preview: string;
}

interface ComposerDraftPersistence {
  notice: ComposerDraftNotice | null;
  putBack: () => void;
  discard: () => void;
  /**
   * Call immediately before the optimistic setValue('').
   * Flushes the current text and marks the send in flight so the empty box
   * does not delete the stored draft.
   */
  noteOptimisticClear: () => void;
  /** Delete the stored draft only for 'success'. Failure and timeout keep it. */
  noteSendSettled: (outcome: ComposerDraftSendOutcome) => void;
  /**
   * Public send wrapper: optimistic-clear hold, then delete only when `send`
   * resolves true. false, a throw, and a timeout all leave the stored draft.
   */
  trackSend: (send: () => boolean | Promise<boolean>) => Promise<boolean | 'timeout'>;
}

export function useComposerDraftPersistence(args: {
  sessionId: string | null;
  sessionless: boolean;
  value: string;
  setValue: (value: string) => void;
  /** Queued-edit mode borrows the box. Don't persist that text or clear the idle draft when it leaves. */
  suspend?: boolean;
}): ComposerDraftPersistence {
  const { sessionId, sessionless, value, setValue, suspend = false } = args;
  const key = composerDraftStorageKey(sessionId, sessionless);
  const keyRef = useRef(key);
  const prevKeyRef = useRef(key);
  const valueRef = useRef(value);
  valueRef.current = value;
  const sendInFlightRef = useRef(false);
  const ignoreNextEmptyRef = useRef(true);
  const wasSuspendedRef = useRef(false);
  const writerRef = useRef<ComposerDraftWriter | null>(null);
  const [sendInFlight, setSendInFlight] = useState(false);
  const [stored, setStored] = useState<string | null>(() => readComposerDraft(key));

  useEffect(() => {
    const writer = createComposerDraftWriter({
      delayMs: COMPOSER_DRAFT_DEBOUNCE_MS,
      onCommitted: (committedKey, text) => {
        if (committedKey === keyRef.current) setStored(text);
      },
      onRemoved: (removedKey) => {
        if (removedKey === keyRef.current) setStored(null);
      },
    });
    writerRef.current = writer;
    return () => {
      writer.dispose();
      if (writerRef.current === writer) writerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const writer = writerRef.current;
    if (!writer) return;
    if (suspend) {
      // The box now shows a queued message. Flush the idle text that was already
      // scheduled, and don't replace it with the queued body.
      if (!wasSuspendedRef.current) writer.flushPending();
      wasSuspendedRef.current = true;
      if (prevKeyRef.current !== key) {
        prevKeyRef.current = key;
        keyRef.current = key;
        ignoreNextEmptyRef.current = true;
        setStored(readComposerDraft(key));
      }
      return;
    }
    if (wasSuspendedRef.current) {
      wasSuspendedRef.current = false;
      ignoreNextEmptyRef.current = true;
    }
    if (prevKeyRef.current !== key) {
      const previousKey = prevKeyRef.current;
      prevKeyRef.current = key;
      keyRef.current = key;
      // Session switch clears the box in a later effect. This render still has
      // the previous session's text, so flush it onto the previous key first.
      if (valueRef.current.trim()) {
        writer.flushNow(previousKey, valueRef.current, () => false);
      } else {
        writer.flushPending();
      }
      ignoreNextEmptyRef.current = true;
      setStored(readComposerDraft(key));
      return;
    }
    keyRef.current = key;
    if (!value.trim() && ignoreNextEmptyRef.current) {
      // Mount and the post-switch clear both start from an empty box. That
      // empty value is not the user deleting the stored draft.
      ignoreNextEmptyRef.current = false;
      return;
    }
    ignoreNextEmptyRef.current = false;
    writer.schedule(key, value, () => sendInFlightRef.current);
  }, [key, suspend, value]);

  const noteOptimisticClear = useCallback(() => {
    sendInFlightRef.current = true;
    setSendInFlight(true);
    // Hold, do not remove. Success is the only outcome that deletes.
    writerRef.current?.flushNow(keyRef.current, valueRef.current, () => true);
  }, []);

  const noteSendSettled = useCallback((outcome: ComposerDraftSendOutcome) => {
    sendInFlightRef.current = false;
    setSendInFlight(false);
    // Cancel the empty-box schedule captured during the optimistic clear so it
    // cannot remove the draft once the in-flight flag drops.
    writerRef.current?.cancel();
    if (outcome !== 'success') return;
    removeComposerDraft(keyRef.current);
    setStored(null);
  }, []);

  const trackSend = useCallback(async (send: () => boolean | Promise<boolean>) => {
    noteOptimisticClear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        Promise.resolve().then(send),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), COMPOSER_DRAFT_SEND_TIMEOUT_MS);
        }),
      ]);
      if (raced === 'timeout') {
        noteSendSettled('timeout');
        return 'timeout' as const;
      }
      const ok = raced === true;
      noteSendSettled(ok ? 'success' : 'failure');
      return ok;
    } catch (error) {
      noteSendSettled('failure');
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, [noteOptimisticClear, noteSendSettled]);

  const putBack = useCallback(() => {
    const text = readComposerDraft(keyRef.current);
    if (!text) return;
    setValue(text);
  }, [setValue]);

  const discard = useCallback(() => {
    writerRef.current?.cancel();
    removeComposerDraft(keyRef.current);
    setStored(null);
  }, []);

  const notice = sendInFlight || value.trim() || !stored
    ? null
    : { text: stored, preview: composerDraftPreview(stored) };

  return {
    notice,
    putBack,
    discard,
    noteOptimisticClear,
    noteSendSettled,
    trackSend,
  };
}
