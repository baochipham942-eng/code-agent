import { describe, expect, it } from 'vitest';
import { isMouseEventInput, parseSgrMouse } from '../../../../src/cli/tui-app/mouse';

describe('parseSgrMouse', () => {
  it('解析左键按下', () => {
    expect(parseSgrMouse('\x1b[<0;12;8M')).toEqual({
      button: 0, x: 12, y: 8, kind: 'press',
    });
  });

  it('解析移动（button+32）和松开', () => {
    expect(parseSgrMouse('\x1b[<32;12;8M')).toMatchObject({ kind: 'move', x: 12, y: 8 });
    expect(parseSgrMouse('\x1b[<0;12;8m')).toMatchObject({ kind: 'release', button: 0 });
  });

  it('Ink 剥 ESC 后的残片识别为鼠标输入，不进草稿', () => {
    expect(isMouseEventInput('[<0;12;8M')).toBe(true);
    expect(isMouseEventInput('[<32;1;1M')).toBe(true);
    expect(isMouseEventInput('[I')).toBe(false);
    expect(isMouseEventInput('hello')).toBe(false);
  });
});
