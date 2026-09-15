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
 * fix4-③④（2026-09-15）：项目/会话 sheet 等库 = spinner + 一句「正在连接电脑…」，失败 =
 * 状态页（标题「连不上电脑」+ 诊断句 + 重新连接 + 去连接电脑）；连接电脑 sheet 状态机
 * （连接中只有 spinner，已连接给电脑名+上次同步，连不上按分类给诊断句与主按钮）。
 * LanCompanionClient 整个 mock 掉（companionProjectPair.test.ts 的形态）：recover 可控成败，
 * read 类 request 悬着就是「连接僵死」的形状。
 */
const harness = vi.hoisted(() => ({ mode: 'hang' as 'hang' | 'reject' | 'refused' | 'rejectIdentity' | 'connectHang' | 'ok' }));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() { throw new Error('COMPANION_PAIRING_REJECTED'); }
    async recover() {
      if (harness.mode === 'reject') throw new Error('COMPANION_NETWORK_UNAVAILABLE');
      if (harness.mode === 'refused') throw new Error('COMPANION_CONNECTION_REFUSED');
      if (harness.mode === 'rejectIdentity') throw new Error('COMPANION_PAIRING_REJECTED');
      if (harness.mode === 'connectHang') return new Promise(() => { /* 重连在飞 */ });
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read') {
        if (harness.mode === 'ok') return { sessions: [], projects: [], models: [] };
        return new Promise(() => { /* 连接僵死：读回永远不回来 */ });
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

function savedWithProjectBinding(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '35' }) },
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

describe('项目 sheet：等库 spinner，失败态是状态页（反馈③④ + fix4-④）', () => {
  it('连着但库迟迟读不到：先 spinner +「正在连接电脑…」，无重试 pill', async () => {
    vi.useFakeTimers();
    harness.mode = 'hang';
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    // 配对过且只授权项目 ⇒ 连上后自动弹项目 sheet（needsLibraryPick 路径）
    for (let i = 0; i < 40 && !document.querySelector('.sheet-wait'); i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(25); });
    }
    const waiting = document.querySelector('.sheet-wait');
    expect(waiting).toBeTruthy();
    expect(waiting?.textContent).toContain('正在连接电脑…');
    expect(waiting?.querySelector('.spinner')).toBeTruthy();
    expect(waiting?.querySelector('button')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.librarySheetWaitMs); });
    const failed = document.querySelector('[data-testid="sheet-unreachable"]');
    expect(failed).toBeTruthy();
    expect(failed?.textContent).toContain('连不上电脑');
    expect(failed?.textContent).toContain('电脑没回应');
    expect(failed?.textContent).not.toContain('正在连接电脑…');
    expect([...failed?.querySelectorAll('button') ?? []].map(button => button.textContent)).toEqual(['重新连接', '去连接电脑']);
  });

  it('已断连时进 sheet 直接示状态页，不先转圈；诊断句按失败分类（连接被拒绝）', async () => {
    harness.mode = 'refused';
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    await openProjectsSheetFromDrawer();
    const failed = document.querySelector('[data-testid="sheet-unreachable"]');
    expect(failed).toBeTruthy();
    expect(failed?.textContent).toContain('连不上电脑');
    expect(failed?.textContent).toContain('电脑上的 Neo 没在运行');
    expect(failed?.textContent).not.toContain('正在连接电脑');
  });

  it('「去连接电脑」次按钮跳到连接电脑 sheet（不替换项目 sheet，可返回）', async () => {
    harness.mode = 'refused';
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    await openProjectsSheetFromDrawer();
    const goRemote = [...document.querySelectorAll('[data-testid="sheet-unreachable"] button')]
      .find(button => button.textContent === text.goRemote) as HTMLElement;
    fireEvent.click(goRemote);
    expect(document.querySelector('[data-page="remote"]')).toBeTruthy();
    // 有父级可返回（projects 还在栈里）
    const back = document.querySelector('.sheet-header button[aria-label="返回上一级"]') as HTMLElement;
    expect(back).toBeTruthy();
    fireEvent.click(back);
    expect(document.querySelector('[data-testid="sheet-unreachable"]')).toBeTruthy();
  });
});

describe('连接电脑 sheet 状态机：一态一主操作（fix4-③）', () => {
  it('连接中：只有「正在连接电脑…」+ spinner，没有「重新连接」也没有扫码按钮', async () => {
    harness.mode = 'connectHang';
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    await openRemoteSheetFromDrawer();
    const connecting = document.querySelector('[data-testid="remote-connecting"]');
    expect(connecting).toBeTruthy();
    expect(connecting?.textContent).toContain('正在连接电脑…');
    expect(connecting?.querySelector('.spinner')).toBeTruthy();
    const sheet = document.querySelector('.remote-sheet') as HTMLElement;
    expect([...sheet.querySelectorAll('button')]).toEqual([]);
    expect(sheet.textContent).not.toContain('同一 Wi-Fi');
  });

  it('连不上（连接被拒绝）：诊断句「电脑上的 Neo 没在运行」+ 主按钮「重新连接」', async () => {
    harness.mode = 'refused';
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    await openRemoteSheetFromDrawer();
    const failed = document.querySelector('[data-testid="remote-unreachable"]');
    expect(failed).toBeTruthy();
    expect(failed?.textContent).toContain('连不上电脑');
    expect(failed?.textContent).toContain('电脑上的 Neo 没在运行');
    const buttons = [...failed?.querySelectorAll('button') ?? []].map(button => button.textContent);
    expect(buttons).toContain(text.reconnect);
    expect(buttons).not.toContain(text.scan);
  });

  it('连不上（配对失效）：诊断句「需要重新扫码」+ 主按钮换「扫描电脑二维码」，不给重新连接', async () => {
    harness.mode = 'rejectIdentity';
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    await openRemoteSheetFromDrawer();
    const failed = document.querySelector('[data-testid="remote-unreachable"]');
    expect(failed?.textContent).toContain('配对信息已失效');
    expect(failed?.textContent).toContain('重新扫码');
    const buttons = [...failed?.querySelectorAll('button') ?? []].map(button => button.textContent);
    expect(buttons).toContain(text.scan);
    expect(buttons).not.toContain(text.reconnect);
  });

  it('已连接：电脑名（mDNS 名去 .local）+ 上次同步时间，不给重连按钮', async () => {
    harness.mode = 'ok';
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    // 连上 + 只授权项目 ⇒ 项目 sheet 自动弹；先关掉再从抽屉进连接电脑 sheet
    await waitFor(() => { expect(document.querySelector('[data-testid="sheet-host"]')).toBeTruthy(); });
    fireEvent.click(document.querySelector('.sheet-header button[aria-label="关闭弹层"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="sheet-host"]')).toBeNull(); });
    await openRemoteSheetFromDrawer();
    const success = document.querySelector('.connection-success');
    expect(success).toBeTruthy();
    expect(success?.textContent).toContain('imac');
    await waitFor(() => { expect(success?.textContent).toContain('上次同步'); });
    const buttons = [...document.querySelectorAll('.remote-sheet button')].map(button => button.textContent);
    expect(buttons).not.toContain(text.reconnect);
  });
});

describe('没配对过时连接电脑 sheet 不吞失败原因（ai-review PR#1814 Important④）', () => {
  it('扫码失败：「还没连接电脑」下面给出扫码失败的诊断句', async () => {
    const base = ports();
    const withScanFailure: PlatformPorts = { ...base, companion: { ...base.companion!, read: async () => null, scan: async () => { throw new Error('cancelled'); } } };
    await act(async () => { render(<MobileRoot ports={withScanFailure} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    await openRemoteSheetFromDrawer();
    const unpaired = document.querySelector('[data-testid="remote-unpaired"]');
    expect(unpaired?.textContent).toContain(text.noComputers);
    expect(unpaired?.textContent).not.toContain(text.connectionScanFailed);
    fireEvent.click([...unpaired!.querySelectorAll('button')].find(button => button.textContent === text.scan) as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="remote-unpaired"]')?.textContent).toContain(text.connectionScanFailed); });
  });

  it('本机安全存储读不出：不止说「没有电脑」，给出存储故障的句子', async () => {
    const base = ports();
    const withStorageFailure: PlatformPorts = { ...base, companion: { ...base.companion!, read: async () => { throw new Error('keychain unavailable'); } } };
    await act(async () => { render(<MobileRoot ports={withStorageFailure} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.app')).toBeTruthy(); });
    await openRemoteSheetFromDrawer();
    await waitFor(() => { expect(document.querySelector('[data-testid="remote-unpaired"]')?.textContent).toContain(text.secureStorageError); });
  });
});
