import type { Message } from '../../../shared/contract';
import { boundDocumentEvidenceClaims } from './documentEvidenceBoundary';
import { createHandoffTailStreamFilter } from '../../handoff/handoffStream';

/** Text waits for a complete response: a later clause can negate/qualify an earlier fragment.
 * Reasoning/tool/usage events are independent. Failed/cancelled inferences never publish this buffer.
 */
export function createDocumentEvidenceStream(messages: readonly Message[], emit: (text: string) => void): {
  push(text: string | undefined): void;
  finish(content: string | undefined): void;
  readonly pending: string;
} {
  let pending = '';
  return {
    get pending() { return pending; },
    push(text) { pending += text ?? ''; },
    finish(content) {
      let visible = '';
      const handoff = createHandoffTailStreamFilter((text) => { visible += text; });
      handoff.push(content ?? pending);
      handoff.flush();
      emit(boundDocumentEvidenceClaims(visible, messages).content);
      pending = '';
    },
  };
}
