import { describe, expect, it } from 'vitest';
import { neoUIOrdinalAtOffset } from '../../../src/renderer/components/features/chat/GenerativeUI/sourceOrdinal';

describe('neoUIOrdinalAtOffset', () => {
  it('binds multiple fences to stable zero-based source ordinals', () => {
    const content = 'A\n```neo_ui\n{"fallback":"one"}\n```\nB\n```neo_ui\n{"fallback":"two"}\n```';
    expect(neoUIOrdinalAtOffset(content, content.indexOf('```neo_ui'))).toBe(0);
    expect(neoUIOrdinalAtOffset(content, content.lastIndexOf('```neo_ui'))).toBe(1);
  });

  it('fails safely to the first instance when source position is unavailable', () => {
    expect(neoUIOrdinalAtOffset('```neo_ui\n{}\n```')).toBe(0);
  });
});
