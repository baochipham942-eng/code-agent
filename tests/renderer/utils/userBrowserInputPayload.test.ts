import { describe, expect, it } from 'vitest';
import {
  assertNoCdpPassthroughShape,
  validateUserBrowserInputPayload,
} from '../../../src/shared/utils/userBrowserInputPayload';

describe('userBrowserInputPayload 校验', () => {
  it('接受合法 click / wheel / key / insertText', () => {
    expect(validateUserBrowserInputPayload({
      kind: 'click', x: 10, y: 20, clickCount: 2,
    })).toMatchObject({
      ok: true,
      payload: { kind: 'click', x: 10, y: 20, clickCount: 2, button: 'left' },
    });
    expect(validateUserBrowserInputPayload({
      kind: 'wheel', deltaX: 0, deltaY: 120,
    }).ok).toBe(true);
    expect(validateUserBrowserInputPayload({
      kind: 'key', key: 'Enter',
    }).ok).toBe(true);
    expect(validateUserBrowserInputPayload({
      kind: 'insertText', text: '百度搜索',
    }).ok).toBe(true);
  });

  it('拒绝越界坐标', () => {
    const out = validateUserBrowserInputPayload(
      { kind: 'click', x: 900, y: 10 },
      { viewportWidth: 800, viewportHeight: 600 },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/out of bounds/i);
  });

  it('拒绝非法 keycode / 未知 kind', () => {
    expect(validateUserBrowserInputPayload({ kind: 'key', key: 'F13_HACK' }).ok).toBe(false);
    expect(validateUserBrowserInputPayload({ kind: 'key', key: '' }).ok).toBe(false);
    expect(validateUserBrowserInputPayload({ kind: 'explode' }).ok).toBe(false);
  });

  it('拒绝任意 CDP 方法直通字段（结构断言）', () => {
    const withMethod = validateUserBrowserInputPayload({
      kind: 'click',
      x: 1,
      y: 1,
      cdpMethod: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed' },
    });
    expect(withMethod.ok).toBe(false);
    if (!withMethod.ok) expect(withMethod.error).toMatch(/Forbidden field/i);

    const clean = validateUserBrowserInputPayload({ kind: 'click', x: 1, y: 1 });
    expect(clean.ok).toBe(true);
    if (clean.ok) {
      expect(() => assertNoCdpPassthroughShape(clean.payload)).not.toThrow();
    }
  });
});
