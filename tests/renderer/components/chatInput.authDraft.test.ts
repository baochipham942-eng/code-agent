import { describe, expect, it } from 'vitest';
import { shouldClearComposerAfterSend } from '../../../src/renderer/components/features/chat/ChatInput/utils';

describe('ChatInput draft retention', () => {
  it('keeps the composer draft when send is blocked before execution', () => {
    expect(shouldClearComposerAfterSend(false)).toBe(false);
  });

  it('clears the composer draft after a confirmed send', () => {
    expect(shouldClearComposerAfterSend(true)).toBe(true);
  });
});
