// Cold-boot helpers for unsent composer drafts. A draft is keyed by the session it was typed in,
// so boot must land on that session (or carry the home draft over) or the card never shows.
import {
  COMPOSER_DRAFT_ADOPTED_EVENT,
  composerDraftStorageKey,
  readComposerDraft,
  removeComposerDraft,
  writeComposerDraftIfAbsent,
} from '../components/features/chat/ChatInput/composerDraftStore';

/** First blank new-task session (list order = most recent first) that holds an unsent draft. */
export function findBlankSessionWithDraft<T extends { id: string }>(
  sessions: T[],
  isBlank: (session: T) => boolean,
): T | null {
  return sessions.find((session) => (
    isBlank(session) && readComposerDraft(composerDraftStorageKey(session.id, false)) !== null
  )) ?? null;
}

/** Move the sessionless home draft onto a freshly created session so the card shows there. */
export function adoptHomeDraft(sessionId: string): void {
  const homeKey = composerDraftStorageKey(null, false);
  const text = readComposerDraft(homeKey);
  if (text === null) return;
  if (writeComposerDraftIfAbsent(composerDraftStorageKey(sessionId, false), text)) {
    removeComposerDraft(homeKey);
    // The composer may already be mounted on this session and has read its (then empty) draft.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(COMPOSER_DRAFT_ADOPTED_EVENT));
  }
}

/**
 * Cold-boot and re-sign-in both pick the session to show. A blank new-task session holding an
 * unsent draft wins over the most recent session; with no sessions at all the home draft moves
 * onto the one that gets created.
 */
export async function openInitialSession<T extends { id: string }>(deps: {
  sessions: T[];
  isBlank: (session: T) => boolean;
  switchSession: (id: string) => Promise<unknown>;
  createSession: () => Promise<{ id: string } | null>;
}): Promise<void> {
  const { sessions, isBlank, switchSession, createSession } = deps;
  if (sessions.length > 0) {
    await switchSession((findBlankSessionWithDraft(sessions, isBlank) ?? sessions[0]).id);
    return;
  }
  const created = await createSession();
  if (created) adoptHomeDraft(created.id);
}
