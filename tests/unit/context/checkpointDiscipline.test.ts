import { describe, expect, it } from 'vitest';
import {
  classifyUserPromptIntent,
  renderVerbatimBlockQuote,
  shouldUpdateActiveIntent,
} from '../../../src/main/context/checkpoint';

describe('checkpoint writer active-intent discipline', () => {
  it('updates §1 for commitment-style verbs', () => {
    expect(classifyUserPromptIntent('implement checkpoint-writer now')).toBe('commitment');
    expect(classifyUserPromptIntent('fix the rebuild boundary bug')).toBe('commitment');
    expect(shouldUpdateActiveIntent('开干，推动完整目标实现')).toBe(true);
  });

  it('keeps §1 for inspection-style prompts', () => {
    expect(classifyUserPromptIntent('show me every checkpoint file')).toBe('inspection');
    expect(classifyUserPromptIntent('explain why the checkpoint failed')).toBe('inspection');
    expect(shouldUpdateActiveIntent('解释一下这个 checkpoint 为什么失败')).toBe(false);
  });

  it('defaults to KEEP when intent is ambiguous', () => {
    expect(classifyUserPromptIntent('checkpoint maybe later')).toBe('keep');
    expect(shouldUpdateActiveIntent('checkpoint maybe later')).toBe(false);
  });

  it('renders exact user words as a block quote', () => {
    expect(renderVerbatimBlockQuote('run the checkpoint writer')).toBe('> "run the checkpoint writer"');
  });
});

