import { afterEach, describe, expect, it } from 'vitest';
import {
  AppWindow,
  hasInteractiveUi,
  setBrowserWindowInteractionProbe,
} from '../../../src/host/platform/windowBridge';

afterEach(() => {
  setBrowserWindowInteractionProbe(null);
  for (const window of AppWindow.getAllWindows()) window.destroy();
});

describe('hasInteractiveUi', () => {
  it('web 探针优先于常驻 AppWindow 数量', () => {
    const window = new AppWindow();
    setBrowserWindowInteractionProbe(() => false);
    expect(AppWindow.getAllWindows()).toContain(window);
    expect(hasInteractiveUi()).toBe(false);

    setBrowserWindowInteractionProbe(() => true);
    expect(hasInteractiveUi()).toBe(true);
  });

  it('桌面未注册探针时回退到 live AppWindow', () => {
    expect(hasInteractiveUi()).toBe(false);
    const window = new AppWindow();
    expect(hasInteractiveUi()).toBe(true);
    window.destroy();
    expect(hasInteractiveUi()).toBe(false);
  });
});
