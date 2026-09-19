// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { SettingsPage } from '../../../packages/mobile/src/features/settings/SettingsPage';
import { AccountSheet } from '../../../packages/mobile/src/features/settings/AccountSheet';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { AccountLoginOutcome } from '../../../packages/mobile/src/stores/companionStore';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { messages } from '../../../packages/mobile/src/i18n';

/**
 * N-COMPANION-RELAY-ACCOUNT-LOGIN-V3（爸 2026-09-19 三条真机反馈拍板）守卫①④⑤ + R2 退出登录判定
 * + R3 登录成功收口：
 * ① 账号并进个人卡——设置页偏好区不再有单独一行，个人卡未登录/已登录两态各自的文案对。
 * ④ 登录中态：按钮内 spinner + 文案，两个输入框锁定。
 * ⑤ S7 重试：await 结束前不清掉上一轮的失败提示（不会闪回裸表单）。
 * R2：个人页「退出登录」失败判定按 `logout()` 的回传结果，不按渲染闭包里的旧 `account`
 * （监工复核纠正：旧实现里 `account` 是本次渲染捕获的值，退出成功后它仍是旧对象，恒判失败）。
 * R3①：登录成功零反馈（ai-review PR#1958 Important①）——AccountSheet 自己不管路由，登录
 * 成功后由 MobileRoot 收口：关掉弹层、触发一次重连。
 * 守卫②（欢迎页无 welcome-login-notice）在 defaultProject.test.tsx，
 * 守卫③（S8 薄面板主按钮唯一 + R2/R3 门控修正）在 sheetLibraryWait.test.tsx，这里不重复。
 */
const text = messages('zh');

beforeEach(() => {
  // 只有 R3① 的 MobileRoot 级别用例需要这两样（matchMedia 供暗色模式判定、language 供 i18n
  // 取语种），其余渲染孤立组件的用例不受影响，stub 留着无副作用。
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/**
 * R3①：MobileRoot 级别的收口验证——只 mock 传输层与登录模块（照 relayAccountRoute.test.ts
 * 的替身法），不动 companionStore 逻辑，钉住「登录成功后关闭弹层 + 触发一次重连」。
 */
const loginHarness = vi.hoisted(() => ({
  recoverCalls: 0,
  loginResult: null as null | AccountLoginOutcome,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() { throw new Error('unused'); }
    async recover() {
      loginHarness.recoverCalls += 1;
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read') return { nextOffset: null, projects: [], sessions: [], models: [] };
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

vi.mock('../../../packages/mobile/src/platform/accountLogin', () => ({
  loginNeoAccount: async () => loginHarness.loginResult ?? { ok: false, kind: 'unreachable' },
}));

describe('R3① 登录成功零反馈：MobileRoot 收口关弹层 + 触发重连（ai-review PR#1958 Important①）', () => {
  function ports(): PlatformPorts {
    const identity = createIdentity();
    return {
      preferences: { get: async () => null, set: async () => {} },
      appInfo: { read: async () => ({ version: '0.1.0', build: '35' }) },
      lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
      keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
      companion: {
        read: async () => JSON.stringify({
          version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
          binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] },
        }),
        write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}),
      },
    };
  }

  async function mountAtLoginForm() {
    loginHarness.recoverCalls = 0;
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    // 挂载即自动连一次；等它落定再进个人卡，免得把挂载那次连接算进「登录后触发的那一次」。
    await waitFor(() => { expect(loginHarness.recoverCalls).toBeGreaterThan(0); });
    const drawerButton = document.querySelector('[data-testid="open-drawer"]') as HTMLElement;
    fireEvent.click(drawerButton);
    fireEvent.click(document.querySelector('[data-testid="open-settings"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-testid="open-profile"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-login"]')).toBeTruthy(); });
    fireEvent.change(document.getElementById('account-email')!, { target: { value: 'lin@example.com' } });
    fireEvent.change(document.getElementById('account-password')!, { target: { value: 'password12' } });
  }

  it('登录成功 ⇒ sheet-host 关闭，且额外触发了一次重连', async () => {
    loginHarness.loginResult = { ok: true };
    await mountAtLoginForm();
    const before = loginHarness.recoverCalls;
    fireEvent.click(document.querySelector('[data-testid="account-submit"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="sheet-host"]')).toBeNull(); });
    await waitFor(() => { expect(loginHarness.recoverCalls).toBeGreaterThan(before); });
  });

  it('登录失败 ⇒ 弹层不关，行内错误提示照旧出现', async () => {
    loginHarness.loginResult = { ok: false, kind: 'invalidCredentials' };
    await mountAtLoginForm();
    fireEvent.click(document.querySelector('[data-testid="account-submit"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-invalid"]')).toBeTruthy(); });
    expect(document.querySelector('[data-testid="sheet-host"]')).toBeTruthy();
  });
});

describe('守卫① 账号并进个人卡（SettingsPage）', () => {
  const noop = () => {};
  const base = {
    page: 'settings' as const, text, appearance: 'system' as const, nickname: '',
    profileDraft: '', appInfo: null, open: noop, chooseAppearance: noop, editProfile: noop, saveProfile: noop,
  };

  it('未登录：偏好区没有单独的账号行，个人卡显示「未登录」+ 卡片提示文案', () => {
    render(<SettingsPage {...base} account={null} />);
    expect(document.querySelector('[data-testid="open-account"]')).toBeNull();
    const card = document.querySelector('[data-testid="open-profile"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain(text.accountNotLoggedIn);
    expect(card.textContent).toContain(text.accountCardHint);
  });

  it('已登录：偏好区仍没有单独的账号行，个人卡显示昵称/邮箱 + 邮箱副标题', () => {
    render(<SettingsPage {...base} nickname="小林" account={{ email: 'lin@example.com' }} />);
    expect(document.querySelector('[data-testid="open-account"]')).toBeNull();
    const card = document.querySelector('[data-testid="open-profile"]') as HTMLElement;
    expect(card.textContent).toContain('小林');
    expect(card.textContent).toContain('lin@example.com');
  });

  it('已登录点个人卡进个人信息页，账号区有邮箱与「退出登录」文字链接', () => {
    render(<SettingsPage {...base} page="profile" profileDraft="小林" account={{ email: 'lin@example.com' }} logout={async () => true} />);
    expect(document.querySelector('[data-testid="account-logout"]')?.textContent).toBe(text.accountLogout);
    expect(document.body.textContent).toContain('lin@example.com');
    // 主按钮仍是「保存」，退出不是主按钮（拍板④）。
    expect(document.querySelector('form button.primary')?.textContent).toBe(text.save);
    expect(document.querySelector('[data-testid="account-logout"]')?.classList.contains('primary')).toBe(false);
  });
});

describe('R2 个人页退出登录判定：按 logout() 回传结果，不按渲染闭包里的旧 account', () => {
  const noop = () => {};
  const base = {
    page: 'profile' as const, text, appearance: 'system' as const, nickname: '',
    profileDraft: '小林', appInfo: null, open: noop, chooseAppearance: noop, editProfile: noop, saveProfile: noop,
  };

  it('退出成功（logout 回传 true）：不出现「退出登录没有成功」；随后重新登录进个人页仍不出现', async () => {
    const { rerender } = render(<SettingsPage {...base} account={{ email: 'lin@example.com' }} logout={async () => true} />);
    fireEvent.click(document.querySelector('[data-testid="account-logout"]')!);
    await waitFor(() => { expect((document.querySelector('[data-testid="account-logout"]') as HTMLButtonElement).disabled).toBe(false); });
    expect(document.querySelector('[data-testid="account-logout-failed"]')).toBeNull();
    // 父层退出成功后把 account 同步成 null（个人卡回到未登录），个人页这时不再渲染账号区。
    rerender(<SettingsPage {...base} account={null} logout={async () => true} />);
    expect(document.querySelector('[data-testid="account-logout-failed"]')).toBeNull();
    // 重新登录、再次进个人页：不能把上一轮的判定带过来。
    rerender(<SettingsPage {...base} account={{ email: 'lin@example.com' }} logout={async () => true} />);
    expect(document.querySelector('[data-testid="account-logout-failed"]')).toBeNull();
  });

  it('退出失败（logout 回传 false，store persist 失败保留 account）：出现「退出登录没有成功」', async () => {
    render(<SettingsPage {...base} account={{ email: 'lin@example.com' }} logout={async () => false} />);
    fireEvent.click(document.querySelector('[data-testid="account-logout"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-logout-failed"]')).toBeTruthy(); });
    expect(document.querySelector('[data-testid="account-logout-failed"]')?.textContent).toBe(text.accountLogoutFailed);
  });
});

describe('守卫④ 登录中态：按钮内 spinner + 文案，输入框锁定', () => {
  it('提交后（await 结束前）两个输入框 disabled，按钮显示「登录中…」', async () => {
    let resolveLogin: (value: AccountLoginOutcome) => void = () => {};
    const login = () => new Promise<AccountLoginOutcome>(resolve => { resolveLogin = resolve; });
    render(<AccountSheet hostEmail={null} login={login} dismiss={() => {}} text={text} />);
    fireEvent.change(document.getElementById('account-email')!, { target: { value: 'lin@example.com' } });
    fireEvent.change(document.getElementById('account-password')!, { target: { value: 'password12' } });
    fireEvent.click(document.querySelector('[data-testid="account-submit"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-submit"]')?.textContent).toContain(text.accountLoginBusy); });
    expect((document.getElementById('account-email') as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById('account-password') as HTMLInputElement).disabled).toBe(true);
    expect(document.querySelector('[data-testid="account-submit"] .spinner')).toBeTruthy();
    resolveLogin({ ok: true });
    await waitFor(() => { expect((document.getElementById('account-email') as HTMLInputElement)?.disabled).not.toBe(true); });
  });
});

describe('守卫⑤ S7 重试：await 结束前不清掉上一轮的失败提示', () => {
  it('点「重试」后，在新一轮 await 落地前，原来的「连不上账号服务」面板仍在（不会闪回裸表单）', async () => {
    let resolveFirst: (value: AccountLoginOutcome) => void = () => {};
    let resolveSecond: (value: AccountLoginOutcome) => void = () => {};
    let call = 0;
    const login = () => new Promise<AccountLoginOutcome>(resolve => {
      call += 1;
      if (call === 1) resolveFirst = resolve; else resolveSecond = resolve;
    });
    render(<AccountSheet hostEmail={null} login={login} dismiss={() => {}} text={text} />);
    fireEvent.change(document.getElementById('account-email')!, { target: { value: 'lin@example.com' } });
    fireEvent.change(document.getElementById('account-password')!, { target: { value: 'password12' } });
    fireEvent.click(document.querySelector('[data-testid="account-submit"]')!);
    resolveFirst({ ok: false, kind: 'unreachable' });
    await waitFor(() => { expect(document.querySelector('[data-testid="account-unreachable"]')).toBeTruthy(); });
    fireEvent.click(document.querySelector('[data-testid="account-retry"]')!);
    // 重试的第二次 await 还没落地：不许已经切回裸表单——「连不上账号服务」原样还在。
    expect(document.querySelector('[data-testid="account-unreachable"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="account-login"]')).toBeNull();
    resolveSecond({ ok: false, kind: 'unreachable' });
    await waitFor(() => { expect(document.querySelector('[data-testid="account-retry"]') as HTMLButtonElement).not.toBeNull(); });
  });
});
