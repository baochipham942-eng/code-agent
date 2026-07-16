import { describe, expect, it } from 'vitest';
import { shouldSuppressOsNotification } from '../../../src/renderer/utils/osNotification';

describe('shouldSuppressOsNotification（焦点门控四象限）', () => {
  it('聚焦且可见 → 抑制（用户正盯着 app，OS 弹窗只重复打扰）', () => {
    expect(shouldSuppressOsNotification(true, true)).toBe(true);
  });

  it('失焦且可见 → 放行（窗口在别的 app 后面）', () => {
    expect(shouldSuppressOsNotification(false, true)).toBe(false);
  });

  it('聚焦但页面不可见 → 放行（最小化等边缘态，宁可通知）', () => {
    expect(shouldSuppressOsNotification(true, false)).toBe(false);
  });

  it('失焦且不可见 → 放行', () => {
    expect(shouldSuppressOsNotification(false, false)).toBe(false);
  });
});
