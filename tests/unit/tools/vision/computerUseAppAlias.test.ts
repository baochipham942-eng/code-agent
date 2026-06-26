import { describe, expect, it } from 'vitest';
import { resolveMacOSApplicationAlias } from '../../../../src/host/tools/vision/computerUse';

describe('resolveMacOSApplicationAlias', () => {
  it.each([
    ['记事本', 'Notes'],
    ['备忘录', 'Notes'],
    ['notes', 'Notes'],
    ['Notepad', 'Notes'],
    ['文本编辑', 'TextEdit'],
    ['text edit', 'TextEdit'],
  ])('maps %s to %s on macOS', (input, expected) => {
    expect(resolveMacOSApplicationAlias(input)).toBe(expected);
  });

  it('keeps unknown app names unchanged', () => {
    expect(resolveMacOSApplicationAlias('Safari')).toBe('Safari');
  });
});

