// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { SettingsPage } from '../../../packages/mobile/src/features/settings/SettingsPage';
import { AccountSheet } from '../../../packages/mobile/src/features/settings/AccountSheet';
import type { AccountLoginOutcome } from '../../../packages/mobile/src/stores/companionStore';
import { messages } from '../../../packages/mobile/src/i18n';

/**
 * N-COMPANION-RELAY-ACCOUNT-LOGIN-V3（爸 2026-09-19 三条真机反馈拍板）守卫①④⑤ + R2 退出登录判定：
 * ① 账号并进个人卡——设置页偏好区不再有单独一行，个人卡未登录/已登录两态各自的文案对。
 * ④ 登录中态：按钮内 spinner + 文案，两个输入框锁定。
 * ⑤ S7 重试：await 结束前不清掉上一轮的失败提示（不会闪回裸表单）。
 * R2：个人页「退出登录」失败判定按 `logout()` 的回传结果，不按渲染闭包里的旧 `account`
 * （监工复核纠正：旧实现里 `account` 是本次渲染捕获的值，退出成功后它仍是旧对象，恒判失败）。
 * 守卫②（欢迎页无 welcome-login-notice）在 defaultProject.test.tsx，
 * 守卫③（S8 薄面板主按钮唯一 + R2 门控修正）在 sheetLibraryWait.test.tsx，这里不重复。
 */
const text = messages('zh');

afterEach(() => { cleanup(); });

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
