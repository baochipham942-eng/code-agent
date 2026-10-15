// @vitest-environment jsdom
// useConnectorCardFocus —— 连接器深链落点：等目标卡渲染后 scrollIntoView + 高亮环
import React, { useEffect, useState } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsCapabilityFocus } from '../../../src/renderer/stores/appStore';
import { useConnectorCardFocus } from '../../../src/renderer/hooks/useConnectorCardFocus';

function createScrollSpy() {
  // jsdom 未实现 scrollIntoView；真实浏览器里由 hook 直接调用
  return vi.fn((arg?: boolean | ScrollIntoViewOptions) => {
    void arg;
  });
}

let scrollIntoView: ReturnType<typeof createScrollSpy>;

beforeEach(() => {
  scrollIntoView = createScrollSpy();
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  delete (window.HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

function FocusHarness({
  focus,
  deferredCardTestid,
}: {
  focus: SettingsCapabilityFocus | null;
  /** 传则先不渲染该卡，~150ms 后才出现——模拟 SaaS skeleton 先行 */
  deferredCardTestid?: string;
}) {
  useConnectorCardFocus(focus);
  const [deferredVisible, setDeferredVisible] = useState(false);
  useEffect(() => {
    if (!deferredCardTestid) return;
    const timer = window.setTimeout(() => setDeferredVisible(true), 150);
    return () => window.clearTimeout(timer);
  }, [deferredCardTestid]);
  return (
    <div>
      <div data-testid="native-connector-card-mail">Mail card</div>
      <div data-testid="saas-connector-skeleton-feishu">skeleton</div>
      {deferredVisible || !deferredCardTestid ? (
        <div data-testid={deferredCardTestid ?? 'saas-connector-feishu'}>SaaS card</div>
      ) : null}
    </div>
  );
}

describe('useConnectorCardFocus', () => {
  it('native 卡：定位 native-connector-card-<id>，滚动并挂高亮环', () => {
    render(React.createElement(FocusHarness, {
      focus: { kind: 'connector', id: 'mail', nonce: 1 },
    }));

    const card = document.querySelector('[data-testid="native-connector-card-mail"]') as HTMLElement;
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(card);
    expect(card.classList.contains('connector-focus-ring')).toBe(true);
    expect(card.getAttribute('data-connector-focus')).toBe('true');
  });

  it('SaaS 卡：定位 saas-connector-<id>（skeleton 不算命中）', async () => {
    render(React.createElement(FocusHarness, {
      focus: { kind: 'connector', id: 'feishu', nonce: 2 },
      deferredCardTestid: 'saas-connector-feishu',
    }));

    // skeleton 期不误滚动
    expect(scrollIntoView).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    }, { timeout: 3_000 });
    const card = document.querySelector('[data-testid="saas-connector-feishu"]') as HTMLElement;
    expect(card.classList.contains('connector-focus-ring')).toBe(true);
  });

  it('focus 清空后撤高亮环', async () => {
    const { rerender } = render(React.createElement(FocusHarness, {
      focus: { kind: 'connector', id: 'mail', nonce: 3 },
    }));
    const card = document.querySelector('[data-testid="native-connector-card-mail"]') as HTMLElement;
    expect(card.classList.contains('connector-focus-ring')).toBe(true);

    rerender(React.createElement(FocusHarness, { focus: null }));

    expect(card.classList.contains('connector-focus-ring')).toBe(false);
    expect(card.hasAttribute('data-connector-focus')).toBe(false);
  });

  it('kind 非 connector 时不滚动不高亮', () => {
    render(React.createElement(FocusHarness, {
      focus: { kind: 'mcp', id: 'github', nonce: 4 },
    }));

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.querySelector('.connector-focus-ring')).toBeNull();
  });
});
