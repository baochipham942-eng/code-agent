import { describe, expect, it } from 'vitest';
import {
  resolveBrowserToolbarState,
} from '../../../src/renderer/utils/browserToolbarState';

describe('browserToolbarState（N2 按钮可用态）', () => {
  it('无页面/未运行时后退前进刷新均置灰', () => {
    const state = resolveBrowserToolbarState({
      running: false,
      hasUrl: false,
      canGoBack: false,
      canGoForward: false,
      ownedByCurrentSession: true,
    });
    expect(state.backEnabled).toBe(false);
    expect(state.forwardEnabled).toBe(false);
    expect(state.reloadEnabled).toBe(false);
    expect(state.openExternalEnabled).toBe(false);
  });

  it('有页面但无历史时后退/前进置灰，刷新与外开可用', () => {
    const state = resolveBrowserToolbarState({
      running: true,
      hasUrl: true,
      canGoBack: false,
      canGoForward: false,
      ownedByCurrentSession: true,
    });
    expect(state.backEnabled).toBe(false);
    expect(state.forwardEnabled).toBe(false);
    expect(state.reloadEnabled).toBe(true);
    expect(state.openExternalEnabled).toBe(true);
  });

  it('有历史时后退/前进可点；非本会话全部禁用', () => {
    const owned = resolveBrowserToolbarState({
      running: true,
      hasUrl: true,
      canGoBack: true,
      canGoForward: true,
      ownedByCurrentSession: true,
    });
    expect(owned.backEnabled).toBe(true);
    expect(owned.forwardEnabled).toBe(true);

    const foreign = resolveBrowserToolbarState({
      running: true,
      hasUrl: true,
      canGoBack: true,
      canGoForward: true,
      ownedByCurrentSession: false,
    });
    expect(foreign.backEnabled).toBe(false);
    expect(foreign.forwardEnabled).toBe(false);
    expect(foreign.reloadEnabled).toBe(false);
    expect(foreign.openExternalEnabled).toBe(false);
  });
});
