import { describe, expect, it } from 'vitest';
import {
  classifyUserPromptIntent,
  renderVerbatimBlockQuote,
  shouldUpdateActiveIntent,
} from '../../../src/host/context/checkpoint';

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

  it('does not misjudge commitment verbs inside identifiers (audit C-M2)', () => {
    expect(classifyUserPromptIntent('how does run_eval.sh work')).toBe('inspection');
    expect(classifyUserPromptIntent('tell me what build-switch.txt does')).toBe('inspection');
    expect(classifyUserPromptIntent('run the tests')).toBe('commitment');
  });

  it('resolves mixed prompts by first occurrence (audit C-M2)', () => {
    expect(classifyUserPromptIntent('explain how the eval works before we run it')).toBe('inspection');
    expect(classifyUserPromptIntent('fix the bug, then show me the diff')).toBe('commitment');
  });

  it('defaults to KEEP when intent is ambiguous', () => {
    expect(classifyUserPromptIntent('checkpoint maybe later')).toBe('keep');
    expect(shouldUpdateActiveIntent('checkpoint maybe later')).toBe(false);
  });

  it('renders exact user words as a block quote', () => {
    expect(renderVerbatimBlockQuote('run the checkpoint writer')).toBe('> "run the checkpoint writer"');
  });
});

