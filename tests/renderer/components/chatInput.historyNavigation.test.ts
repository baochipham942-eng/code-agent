import { describe, expect, it } from 'vitest';
import {
  shouldBrowseHistoryOnArrowDown,
  shouldBrowseHistoryOnArrowUp,
} from '../../../src/renderer/components/features/chat/ChatInput/InputArea';

describe('ChatInput history navigation keys', () => {
  it('lets ArrowUp move the caret before browsing history from a single-line draft', () => {
    const draft = '呼呼呼呼';

    expect(shouldBrowseHistoryOnArrowUp(draft.length, draft.length)).toBe(false);
    expect(shouldBrowseHistoryOnArrowUp(0, 0)).toBe(true);
  });

  it('lets ArrowDown move the caret before browsing forward through history', () => {
    const draft = '上一条输入';

    expect(shouldBrowseHistoryOnArrowDown(draft, 0, 0)).toBe(false);
    expect(shouldBrowseHistoryOnArrowDown(draft, draft.length, draft.length)).toBe(true);
  });

  it('does not browse history while a text range is selected', () => {
    const draft = '选中一段';

    expect(shouldBrowseHistoryOnArrowUp(0, draft.length)).toBe(false);
    expect(shouldBrowseHistoryOnArrowDown(draft, 0, draft.length)).toBe(false);
  });
});
