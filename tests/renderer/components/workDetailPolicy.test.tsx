// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { App } from '../../../src/renderer/App';
import { useAppStore, type DisclosureLevel } from '../../../src/renderer/stores/appStore';
import { useWorkDetailPolicy } from '../../../src/renderer/utils/workDetailPolicy';

vi.mock('../../../src/renderer/utils/platform', () => ({
  isDesktopShellMode: () => false,
  isTauriMode: () => false,
  isWebMode: () => true,
}));

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REAL_INNER_WIDTH = window.innerWidth;
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true });
});


const TODAY = {
  foldThreshold: 5,
  toolGroupDefaultExpanded: false,
  showThinkingDigest: true,
};

const EXPECTED: Record<DisclosureLevel, typeof TODAY> = {
  simple: { foldThreshold: 2, toolGroupDefaultExpanded: false, showThinkingDigest: false },
  standard: TODAY,
  advanced: { foldThreshold: Infinity, toolGroupDefaultExpanded: false, showThinkingDigest: true },
  expert: { foldThreshold: Infinity, toolGroupDefaultExpanded: true, showThinkingDigest: true },
};

describe('workDetailPolicy', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ disclosureLevel: 'standard' });
    Object.defineProperty(window, 'innerWidth', { value: REAL_INNER_WIDTH, configurable: true, writable: true });
  });

  it('standard equals today: fold at 5, tool groups collapsed, thinking digest shown', () => {
    useAppStore.setState({ disclosureLevel: 'standard' });
    const { result } = renderHook(() => useWorkDetailPolicy());
    expect(result.current).toEqual(TODAY);
  });

  it.each(Object.entries(EXPECTED) as Array<[DisclosureLevel, typeof TODAY]>)(
    '%s exposes foldThreshold, toolGroupDefaultExpanded, and showThinkingDigest',
    (level, expected) => {
      useAppStore.setState({ disclosureLevel: level });
      const { result } = renderHook(() => useWorkDetailPolicy());
      expect(result.current.foldThreshold).toBe(expected.foldThreshold);
      expect(result.current.toolGroupDefaultExpanded).toBe(expected.toolGroupDefaultExpanded);
      expect(result.current.showThinkingDigest).toBe(expected.showThinkingDigest);
    },
  );
});


describe('侧栏可见性不随披露档位变化', () => {
  it.each(['simple', 'standard', 'advanced', 'expert'] as const)('%s 档：侧栏容器、会话列表与新任务入口都在场', (level) => {
    useAppStore.setState({ disclosureLevel: level, sidebarCollapsed: false });
    const { container, getByTestId } = render(<App />);

    expect(container.querySelector('.w-60.h-full')).toBeTruthy();
    expect(getByTestId('sidebar-new-task')).toBeTruthy();
    expect(getByTestId('sidebar-session-scroll')).toBeTruthy();
  });

  it('简洁档收起侧栏：唯一隐藏途径仍是「收起」（壳挂载、内容被裁切）', () => {
    useAppStore.setState({ disclosureLevel: 'simple', sidebarCollapsed: true });
    const { container } = render(<App />);

    const shell = container.querySelector('.w-60.h-full');
    expect(shell).toBeTruthy();
    const pane = shell?.parentElement;
    expect(pane?.getAttribute('aria-hidden')).toBe('true');
    expect(pane?.className).toContain('w-0');
  });
});
