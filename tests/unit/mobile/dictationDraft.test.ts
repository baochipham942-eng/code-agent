import { describe, expect, it } from 'vitest';
import { applyDictationEvent, emptyDictationDraft } from '../../../packages/mobile/src/features/sessions/dictationDraft';

describe('dictationDraft', () => {
  it('replaces the current sentence in place so pauses do not duplicate text', () => {
    let draft = emptyDictationDraft();
    draft = applyDictationEvent(draft, { type: 'partial', text: '你', sentenceId: 1 });
    expect(draft.partial).toBe('你');
    draft = applyDictationEvent(draft, { type: 'partial', text: '你好', sentenceId: 1 });
    expect(draft.partial).toBe('你好');
    expect(draft.committed).toBe('');
    draft = applyDictationEvent(draft, { type: 'final', text: '你好。', sentenceId: 1 });
    expect(draft).toMatchObject({ committed: '你好。', partial: '' });
    draft = applyDictationEvent(draft, { type: 'partial', text: '我', sentenceId: 2 });
    expect(draft).toMatchObject({ committed: '你好。', partial: '我' });
    draft = applyDictationEvent(draft, { type: 'partial', text: '我在', sentenceId: 2 });
    expect(draft).toMatchObject({ committed: '你好。', partial: '我在' });
  });

  it('commits a dangling partial when the provider jumps to a new sentence without a final', () => {
    let draft = emptyDictationDraft();
    draft = applyDictationEvent(draft, { type: 'partial', text: '上半句', sentenceId: 1 });
    draft = applyDictationEvent(draft, { type: 'partial', text: '下一句', sentenceId: 2 });
    expect(draft).toMatchObject({ committed: '上半句', partial: '下一句' });
  });

  it('leaves already-committed text in place when the stream errors', () => {
    let draft = emptyDictationDraft();
    draft = applyDictationEvent(draft, { type: 'final', text: '已经说了', sentenceId: 1 });
    draft = applyDictationEvent(draft, { type: 'error', code: 'SPEECH_NO_CHANNEL', message: 'upstream' });
    expect(draft).toMatchObject({ committed: '已经说了', partial: '' });
  });
});
