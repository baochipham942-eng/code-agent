// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import { sheetLibraryStatus } from '../../../packages/mobile/src/app/sheetLibraryStatus';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';
import { messages } from '../../../packages/mobile/src/i18n';

/**
 * 反馈③（2026-09-14 build 34）：电脑断连/连接僵死时，项目/会话 sheet 不许无限转圈——
 * 秒级超时落「连不上电脑」失败态并给重试；已断连时进 sheet 直接示失败态。
 * LanCompanionClient 整个 mock 掉（companionProjectPair.test.ts 的形态）：recover 可控成败，
 * read 类 request 永远悬着就是「连接僵死」的形状。
 */
const harness = vi.hoisted(() => ({ mode: 'hang' as 'hang' | 'reject' }));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() { throw new Error('COMPANION_PAIRING_REJECTED'); }
    async recover() {
      if (harness.mode === 'reject') throw new Error('COMPANION_NETWORK_UNAVAILABLE');
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] };
    }
    async request(payload: unknown) {
      if ((payload as { action?: string }).action === 'read') return new Promise(() => { /* 连接僵死：读回永远不回来 */ });
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

function savedWithProjectBinding(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '34' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => savedWithProjectBinding(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
});

const text = messages('zh');

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  // jsdom 的 navigator.language 是 en；MobileRoot 按 navigator.language 取文案，中文断言要钉成 zh。
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); cleanup(); });

describe('sheetLibraryStatus 纯函数', () => {
  const base = { library: null, status: 'connected', libraryError: false };
  it('已断连（非 connecting）直接是失败态，不先转圈', () => {
    expect(sheetLibraryStatus({ ...base, status: 'offline' }, false)).toBe('unreachable');
    expect(sheetLibraryStatus({ ...base, status: 'rejected' }, false)).toBe('unreachable');
    expect(sheetLibraryStatus({ ...base, status: 'unpaired' }, false)).toBe('unreachable');
  });
  it('connecting 仍算等待——有一场重连在飞，直接报「连不上」是谎报；超时兜底收口', () => {
    expect(sheetLibraryStatus({ ...base, status: 'connecting' }, false)).toBe('waiting');
    expect(sheetLibraryStatus({ ...base, status: 'connecting' }, true)).toBe('unreachable');
  });
  it('连着且在等库是等待态；到点超时落失败态', () => {
    expect(sheetLibraryStatus(base, false)).toBe('waiting');
    expect(sheetLibraryStatus(base, true)).toBe('unreachable');
  });
  it('读回失败（libraryError）与已有库各自落位', () => {
    expect(sheetLibraryStatus({ ...base, libraryError: true }, false)).toBe('unreachable');
    expect(sheetLibraryStatus({ ...base, library: { sessions: [], projects: [], models: [] } }, true)).toBe('ready');
  });
});

// 两次点击各自让 fireEvent 自带的 act 同步 flush——包进外层 async act 反而会让第一跳的
// 重渲染推迟到 act 收尾，第二次点击时抽屉还没挂上（实测踩坑）。
async function openProjectsSheetFromDrawer() {
  const drawerButton = document.querySelector('[data-testid="open-drawer"]') as HTMLElement;
  fireEvent.click(drawerButton);
  const projects = [...document.querySelectorAll('.drawer-functions button')].find(button => button.textContent === text.projects) as HTMLElement;
  fireEvent.click(projects);
}

async function openRemoteSheetFromDrawer() {
  const drawerButton = document.querySelector('[data-testid="open-drawer"]') as HTMLElement;
  fireEvent.click(drawerButton);
  const remote = [...document.querySelectorAll('.drawer-functions button')].find(button => button.textContent === text.remote) as HTMLElement;
  fireEvent.click(remote);
}

describe('项目 sheet 等库：超时落失败态，断连不转圈（真机反馈③）', () => {
  it('连着但库迟迟读不到：先等待，到 librarySheetWaitMs 落「连不上电脑」+ 重试 pill', async () => {
    vi.useFakeTimers();
    harness.mode = 'hang';
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    // 配对过且只授权项目 ⇒ 连上后自动弹项目 sheet（needsLibraryPick 路径）
    for (let i = 0; i < 40 && !document.querySelector('.sheet-wait'); i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(25); });
    }
    const waiting = document.querySelector('.sheet-wait');
    expect(waiting).toBeTruthy();
    // 反馈④：库来自电脑——说「正在连接电脑…」，不再说「正在读取本机数据」
    expect(waiting?.textContent).toContain('正在连接电脑…');
    expect(waiting?.textContent).not.toContain('本机');
    expect(waiting?.querySelector('button.inline-retry')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.librarySheetWaitMs); });
    const failed = document.querySelector('.sheet-wait');
    expect(failed?.textContent).toContain('连不上电脑');
    expect(failed?.textContent).not.toContain('正在连接电脑…');
    expect(failed?.querySelector('button.inline-retry')).toBeTruthy();
  });

  it('已断连时进 sheet 直接示失败态，不先转圈', async () => {
    harness.mode = 'reject';
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    await openProjectsSheetFromDrawer();
    const line = document.querySelector('.sheet-wait');
    expect(line?.textContent).toContain('连不上电脑');
    expect(line?.textContent).not.toContain('正在连接电脑');
    expect(line?.querySelector('button.inline-retry')).toBeTruthy();
  });

  it('连接电脑 sheet 一行主提示；具体原因收进「为什么连不上？」二级（反馈⑤）', async () => {
    harness.mode = 'reject';
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    await openRemoteSheetFromDrawer();
    const group = document.querySelector('.remote-sheet');
    expect(group).toBeTruthy();
    expect(group?.textContent).toContain(text.lanHint);
    // 状态行只剩一句，不再把与会话页 banner 重复的整段 connectionUnavailable 铺在 sheet 里
    const statusLine = group?.querySelector('p[role="status"]');
    expect(statusLine?.textContent).toBe(text.remoteNotConnected);
    expect(statusLine?.textContent).not.toContain('无法连接电脑');
    const trouble = group?.querySelector('details.connection-trouble');
    expect(trouble?.querySelector('summary')?.textContent).toBe(text.connectionTrouble);
    expect(trouble?.textContent).toContain('同一 Wi-Fi');
  });
});
