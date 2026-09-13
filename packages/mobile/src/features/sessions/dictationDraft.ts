import { joinTranscript } from '../../stores/mobileStore';
import type { CompanionDictationEvent } from '../../../../../src/shared/contract/companionDictation';

/** One recording's spoken text: finals stay, the current sentence is replaced in place. */
export type DictationDraft = {
  committed: string;
  partial: string;
  sentenceId: number | null;
};

export const emptyDictationDraft = (): DictationDraft => ({ committed: '', partial: '', sentenceId: null });

function joinSpoken(left: string, right: string): string {
  return joinTranscript(left, right, Boolean(left));
}

export function dictationDisplay(draft: DictationDraft): string {
  if (!draft.partial) return draft.committed;
  return joinSpoken(draft.committed, draft.partial);
}

export function applyDictationEvent(draft: DictationDraft, event: CompanionDictationEvent): DictationDraft {
  if (event.type === 'error') return draft;
  if (event.type === 'partial') {
    if (draft.sentenceId !== null && event.sentenceId !== draft.sentenceId && draft.partial) {
      return { committed: joinSpoken(draft.committed, draft.partial), partial: event.text, sentenceId: event.sentenceId };
    }
    return { committed: draft.committed, partial: event.text, sentenceId: event.sentenceId };
  }
  const committed = joinSpoken(draft.committed, event.text);
  return {
    committed,
    partial: draft.sentenceId === event.sentenceId ? '' : draft.partial,
    sentenceId: event.sentenceId,
  };
}


