// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { SettingsPage } from '../../../packages/mobile/src/features/settings/SettingsPage';
import { AccountSheet } from '../../../packages/mobile/src/features/settings/AccountSheet';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { AccountLoginOutcome } from '../../../packages/mobile/src/stores/companionStore';
import type { AccountLoginResult } from '../../../packages/mobile/src/platform/accountLogin';
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
 * 守卫①（N-COMPANION-ACCOUNT-CARD-POLISH，爸真机看 v3：深色下 .avatar 用 --group 跟个人卡
 * 所在的 --surface 几乎同色，圆底不可见，只剩裸字浮着）。jsdom 不跑真正的 CSS 级联，量不了
 * 渲染后的颜色，退而求其次：直接读 styles.css 文本核对规则本身——`.avatar` 用了新 token
 * `--avatar-bg`（不是又滑回 `--group`）、`border-radius: 50%` 还在、加了描边兜底；再核对
 * `--avatar-bg` 在浅深色两个 `:root` 块里都定义了。渲染结构那半用 DOM 查询核对
 * `.profile-card .avatar` 真的会出现在个人卡里（未登录通用图标、已登录首字都在同一个圆里）。
 */
describe('守卫①（CSS）个人卡头像圆底：--avatar-bg 与描边', () => {
  const styles = readFileSync('packages/mobile/src/styles.css', 'utf8');
  const avatarRule = styles.match(/\.avatar\s*\{[^}]*\}/)?.[0] ?? '';

  it('.avatar 规则用 --avatar-bg 当底色、border-radius 50%、有描边兜底（不是又用回 --group）', () => {
    expect(avatarRule).toContain('var(--avatar-bg)');
    expect(avatarRule).not.toContain('var(--group)');
    expect(avatarRule).toContain('border-radius: 50%');
    expect(avatarRule).toContain('border: 1px solid var(--line)');
  });

  it('--avatar-bg 浅深色两个 :root 块都定义了，且两个取值不同（不是抄同一个数）', () => {
    const lightRoot = styles.match(/:root\s*\{[^}]*\}/)?.[0] ?? '';
    const darkRoot = styles.match(/:root\[data-theme='dark'\]\s*\{[^}]*\}/)?.[0] ?? '';
    const lightMatch = lightRoot.match(/--avatar-bg:\s*(#[0-9a-fA-F]+)/);
    const darkMatch = darkRoot.match(/--avatar-bg:\s*(#[0-9a-fA-F]+)/);
    expect(lightMatch).toBeTruthy();
    expect(darkMatch).toBeTruthy();
    expect(lightMatch?.[1]).not.toBe(darkMatch?.[1]);
  });

  /**
   * R2（ai-review：确认块的「退出登录」用 `className="primary danger"`，但 `.primary` 的
   * `background: var(--text)` 没被覆盖，只有 `color` 被 `.danger` 盖成红——变成黑底红字/
   * 白底红字，不是危险主按钮的样子）：钉住组合规则真的把背景也换成了红。
   */
  it('.primary.danger 组合规则把背景/字色都换成红色（不是只覆盖 .danger 的字色）', () => {
    const comboRule = styles.match(/\.primary\.danger\s*\{[^}]*\}/)?.[0] ?? '';
    expect(comboRule).toBeTruthy();
    expect(comboRule).toContain('background: #c43b38');
  });

  const base = {
    page: 'settings' as const, text, appearance: 'system' as const, nickname: '',
    profileDraft: '', appInfo: null, open: () => {}, chooseAppearance: () => {}, editProfile: () => {}, saveProfile: () => {},
    logout: async () => true,
  };

  it('.profile-card .avatar 在未登录/已登录两态都渲染（结构没被这次样式改动带歪）', () => {
    const { unmount } = render(<SettingsPage {...base} account={null} />);
    expect(document.querySelector('.profile-card .avatar')).toBeTruthy();
    unmount();
    render(<SettingsPage {...base} nickname="小林" account={{ email: 'lin@example.com' }} />);
    expect(document.querySelector('.profile-card .avatar')?.textContent).toBe('小');
  });
});

/**
 * R3①/R4：MobileRoot 级别的收口验证——只 mock 传输层与登录模块（照 relayAccountRoute.test.ts
 * 的替身法），不动 companionStore 逻辑。R3① 钉住「登录成功后触发一次重连」；R4 纠正 R3① 的
 * 收口动作——不是无条件关掉整个弹层，是退回上一页（`back()`），弹层本身还开着：从设置页
 * 个人卡进来的回到设置页看到已登录的个人卡（v3 稿），从 S8 薄面板「去登录」进来的回到连接面。
 */
const loginHarness = vi.hoisted(() => ({
  recoverCalls: 0,
  // loginNeoAccount 的成功结果带 ticket/userId/email——companionStore.login() 拿这三样落盘/
  // 入状态，只给 `{ ok: true }`（AccountLoginOutcome 那个更窄的形状）会让 account.email
  // 变成 undefined，撞到 SettingsPage 个人卡的 `.slice`。
  loginResult: null as null | AccountLoginResult,
  /** 首次 recover() 是否先失败一次（离网），用来在挂载时自然触发 S8 的 loginPrompt 置起。 */
  failFirstRecover: false,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() { throw new Error('unused'); }
    async recover() {
      loginHarness.recoverCalls += 1;
      if (loginHarness.failFirstRecover && loginHarness.recoverCalls === 1) throw new Error('COMPANION_NETWORK_UNAVAILABLE');
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

describe('R3①/R4 登录成功零反馈：MobileRoot 收口回上一页 + 触发重连（ai-review PR#1958 Important①）', () => {
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

  function currentPage() {
    return document.querySelector('.sheet-content')?.getAttribute('data-page');
  }

  /** 路径①：设置页个人卡（未登录）→ 登录页。登录成功后应该退回 `settings`。 */
  async function mountFromSettings() {
    loginHarness.recoverCalls = 0;
    loginHarness.failFirstRecover = false;
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(loginHarness.recoverCalls).toBeGreaterThan(0); });
    fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-testid="open-settings"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-testid="open-profile"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-login"]')).toBeTruthy(); });
    expect(currentPage()).toBe('account');
    fireEvent.change(document.getElementById('account-email')!, { target: { value: 'lin@example.com' } });
    fireEvent.change(document.getElementById('account-password')!, { target: { value: 'password12' } });
  }

  /** 路径②：S8 薄面板「去登录」→ 登录页。挂载时先撞一次离网失败让 loginPrompt 置真、
   *  薄面板出现，再点「去登录」进表单。登录成功后应该退回 `remote`（连接面），不是关掉。 */
  async function mountFromS8() {
    loginHarness.recoverCalls = 0;
    loginHarness.failFirstRecover = true;
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.topbar strong')).toBeTruthy(); });
    fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
    fireEvent.click([...document.querySelectorAll('.drawer-functions button')].find(b => b.textContent === text.remote) as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="relay-login-go"]')).toBeTruthy(); });
    expect(currentPage()).toBe('remote');
    fireEvent.click(document.querySelector('[data-testid="relay-login-go"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-login"]')).toBeTruthy(); });
    expect(currentPage()).toBe('account');
    fireEvent.change(document.getElementById('account-email')!, { target: { value: 'lin@example.com' } });
    fireEvent.change(document.getElementById('account-password')!, { target: { value: 'password12' } });
  }

  it('从设置页进登录页，登录成功 ⇒ 弹层仍开、退回 settings，个人卡显示邮箱', async () => {
    loginHarness.loginResult = { ok: true, ticket: 'neo1.test-ticket', userId: 'user-1', email: 'lin@example.com' };
    await mountFromSettings();
    fireEvent.click(document.querySelector('[data-testid="account-submit"]')!);
    await waitFor(() => { expect(currentPage()).toBe('settings'); });
    expect(document.querySelector('[data-testid="sheet-host"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="open-profile"]')?.textContent).toContain('lin@example.com');
  });

  it('从 S8 薄面板「去登录」进登录页，登录成功 ⇒ 弹层仍开、退回 remote，且触发了一次重连', async () => {
    loginHarness.loginResult = { ok: true, ticket: 'neo1.test-ticket', userId: 'user-1', email: 'lin@example.com' };
    await mountFromS8();
    const before = loginHarness.recoverCalls;
    fireEvent.click(document.querySelector('[data-testid="account-submit"]')!);
    await waitFor(() => { expect(currentPage()).toBe('remote'); });
    expect(document.querySelector('[data-testid="sheet-host"]')).toBeTruthy();
    await waitFor(() => { expect(loginHarness.recoverCalls).toBeGreaterThan(before); });
  });

  it('登录失败 ⇒ 弹层不关，停在登录页，行内错误提示照旧出现', async () => {
    loginHarness.loginResult = { ok: false, kind: 'invalidCredentials' };
    await mountFromSettings();
    fireEvent.click(document.querySelector('[data-testid="account-submit"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-invalid"]')).toBeTruthy(); });
    expect(document.querySelector('[data-testid="sheet-host"]')).toBeTruthy();
  });

  /**
   * R5②a（ai-review PR#1958 二轮 Important②）：安全存储故障时 status 变 storageError，
   * 但 connectionError 可能还停在离网码上——真实序列是「先撞一次离网失败成功置起
   * loginPrompt（写盘成功）→ 用户去登录，凭据本身没错，但落盘账号信息那一步写失败」。
   * 这是 companionStore.login() 里 `persist()` 会做的事：写失败时把 status 打成
   * storageError 并把异常原样抛给调用方（R5②b 那条 AccountSheet 的 try/finally 接住）。
   * 门控必须排除 storageError，不然这一拍会显示「在外面用需要先登录」，把
   * secureStorageError 那句更准确的诊断和「忘记这台电脑」出口一起藏起来。
   */
  it('先离网触发 loginPrompt，登录时账号落盘失败 ⇒ storageError 排除薄面板，回到 remote 显示 secureStorageError', async () => {
    loginHarness.loginResult = { ok: true, ticket: 'neo1.test-ticket', userId: 'user-1', email: 'lin@example.com' };
    let writeCalls = 0;
    loginHarness.recoverCalls = 0;
    loginHarness.failFirstRecover = true;
    const identity = createIdentity();
    const portsFailSecondWrite = (): PlatformPorts => ({
      preferences: { get: async () => null, set: async () => {} },
      appInfo: { read: async () => ({ version: '0.1.0', build: '35' }) },
      lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
      keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
      companion: {
        read: async () => JSON.stringify({
          version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
          binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] },
        }),
        // 第 1 次落盘（首次离网失败要记 loginReminded）成功；第 2 次起（登录成功后落账号）
        // 失败——模拟安全存储在两次写之间坏掉，不是一开始就坏（一开始就坏 loginPrompt 根本
        // 不会被置起，也就复现不出这条洞）。
        write: async () => { writeCalls += 1; if (writeCalls >= 2) throw new Error('SECURE_STORAGE_WRITE_FAILED'); },
        scan: async () => { throw new Error('unused'); }, post: async () => ({}),
      },
    });
    await act(async () => { render(<MobileRoot ports={portsFailSecondWrite()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.topbar strong')).toBeTruthy(); });
    fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
    fireEvent.click([...document.querySelectorAll('.drawer-functions button')].find(b => b.textContent === text.remote) as HTMLElement);
    // 先确认薄面板真的先出现过（loginPrompt 由此置真，第 1 次写盘成功）。
    await waitFor(() => { expect(document.querySelector('[data-testid="relay-login-go"]')).toBeTruthy(); });
    fireEvent.click(document.querySelector('[data-testid="relay-login-go"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-login"]')).toBeTruthy(); });
    fireEvent.change(document.getElementById('account-email')!, { target: { value: 'lin@example.com' } });
    fireEvent.change(document.getElementById('account-password')!, { target: { value: 'password12' } });
    fireEvent.click(document.querySelector('[data-testid="account-submit"]')!);
    // 落盘失败：AccountSheet 按「连不上账号服务」结算（R5②b），不是卡死或崩溃。
    await waitFor(() => { expect(document.querySelector('[data-testid="account-unreachable"]')).toBeTruthy(); });
    expect((document.querySelector('[data-testid="account-retry"]') as HTMLButtonElement).disabled).toBe(false);
    // 退回连接面：storageError 已经打起，薄面板必须让位给原失败面。
    fireEvent.click(document.querySelector('.sheet-header button[aria-label="返回上一级"]') as HTMLElement);
    await waitFor(() => { expect(currentPage()).toBe('remote'); });
    expect(document.querySelector('[data-testid="relay-login-prompt"]')).toBeNull();
    expect(document.querySelector('[data-testid="remote-unreachable"]')?.textContent).toContain(text.secureStorageError);
    expect(document.querySelector('[data-testid="remote-action-forget"]')).toBeTruthy();
  });
});

describe('R5②b AccountSheet：login() 抛异常也要把 busy 收回来（ai-review PR#1958 二轮 Important②）', () => {
  it('login 抛异常 ⇒ 按「连不上账号服务」结算，输入框/按钮恢复可用，不会永久冻结', async () => {
    const login = async (): Promise<AccountLoginOutcome> => { throw new Error('SECURE_STORAGE_WRITE_FAILED'); };
    render(<AccountSheet hostEmail={null} login={login} dismiss={() => {}} text={text} />);
    fireEvent.change(document.getElementById('account-email')!, { target: { value: 'lin@example.com' } });
    fireEvent.change(document.getElementById('account-password')!, { target: { value: 'password12' } });
    fireEvent.click(document.querySelector('[data-testid="account-submit"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-unreachable"]')).toBeTruthy(); });
    expect((document.querySelector('[data-testid="account-retry"]') as HTMLButtonElement).disabled).toBe(false);
    // 重试同样会抛，同样不能卡死；这次走的是 submit(unreachable) 那条重发路径。
    fireEvent.click(document.querySelector('[data-testid="account-retry"]')!);
    await waitFor(() => { expect((document.querySelector('[data-testid="account-retry"]') as HTMLButtonElement).disabled).toBe(false); });
  });
});

describe('守卫① 账号并进个人卡（SettingsPage）', () => {
  const noop = () => {};
  const base = {
    page: 'settings' as const, text, appearance: 'system' as const, nickname: '',
    profileDraft: '', appInfo: null, open: noop, chooseAppearance: noop, editProfile: noop, saveProfile: noop,
    // logout 是必填 prop（R6 ai-review Nit：!logout 死判据删掉了），这两条不碰退出登录，
    // 给个占位实现就行。
    logout: async () => true,
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

  it('已登录点个人卡进个人信息页，账号区有邮箱与「退出登录」按钮（N-COMPANION-ACCOUNT-CARD-POLISH：从文字链接改成按钮）', () => {
    render(<SettingsPage {...base} page="profile" profileDraft="小林" account={{ email: 'lin@example.com' }} logout={async () => true} />);
    const logoutButton = document.querySelector('[data-testid="account-logout"]') as HTMLElement;
    expect(logoutButton.textContent).toBe(text.accountLogout);
    expect(logoutButton.classList.contains('secondary')).toBe(true);
    expect(document.body.textContent).toContain('lin@example.com');
    // 主按钮仍是「保存」，退出不是主按钮（拍板④）。
    expect(document.querySelector('form button.primary')?.textContent).toBe(text.save);
    expect(logoutButton.classList.contains('primary')).toBe(false);
  });

  /**
   * ④（爸真机追加）：已登录且没设昵称时，个人卡不该再垫一句
   * 「手机在外面也能连回这台电脑。」（accountLoggedInHint，已从 i18n 删除，两条断言之一
   * 顺带钉住它真的没有消费方了）——主标题已经用邮箱顶替了昵称，副标题直接不渲染。
   */
  it('已登录且无昵称：不渲染副标题（.small 不出现，也不含旧的 accountLoggedInHint 文案）', () => {
    render(<SettingsPage {...base} account={{ email: 'lin@example.com' }} />);
    const card = document.querySelector('[data-testid="open-profile"]') as HTMLElement;
    expect(card.querySelector('.small')).toBeNull();
    expect(card.textContent).not.toContain('手机在外面也能连回这台电脑');
  });

  it('已登录且有昵称：副标题只放邮箱', () => {
    render(<SettingsPage {...base} nickname="小林" account={{ email: 'lin@example.com' }} />);
    const card = document.querySelector('[data-testid="open-profile"]') as HTMLElement;
    expect(card.querySelector('.small')?.textContent).toBe('lin@example.com');
  });
});

describe('R2 个人页退出登录判定：按 logout() 回传结果，不按渲染闭包里的旧 account', () => {
  const noop = () => {};
  const base = {
    page: 'profile' as const, text, appearance: 'system' as const, nickname: '',
    profileDraft: '小林', appInfo: null, open: noop, chooseAppearance: noop, editProfile: noop, saveProfile: noop,
  };

  // N-COMPANION-ACCOUNT-CARD-POLISH 之后「退出登录」多了一步二次确认：点按钮只出确认块，
  // 点确认块里的「退出登录」（testid account-logout-confirm）才真的调 logout()。下面两条
  // 沿用 R2 的判定逻辑，只是补上这一步点击——断言本身（回传结果决定成不成功）没有变。
  it('退出成功（logout 回传 true）：不出现「退出登录没有成功」；随后重新登录进个人页仍不出现', async () => {
    const { rerender } = render(<SettingsPage {...base} account={{ email: 'lin@example.com' }} logout={async () => true} />);
    fireEvent.click(document.querySelector('[data-testid="account-logout"]')!);
    fireEvent.click(document.querySelector('[data-testid="account-logout-confirm"]')!);
    await waitFor(() => { expect((document.querySelector('[data-testid="account-logout-confirm"]') as HTMLButtonElement | null)?.disabled).not.toBe(true); });
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
    fireEvent.click(document.querySelector('[data-testid="account-logout-confirm"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-logout-failed"]')).toBeTruthy(); });
    expect(document.querySelector('[data-testid="account-logout-failed"]')?.textContent).toBe(text.accountLogoutFailed);
  });
});

describe('N-COMPANION-LOGOUT-CONFIRM-DIALOG：退出登录二次确认改成模态弹窗（爸 build 57 真机拍板「退出应该是弹窗」）', () => {
  const noop = () => {};
  const base = {
    page: 'profile' as const, text, appearance: 'system' as const, nickname: '',
    profileDraft: '小林', appInfo: null, open: noop, chooseAppearance: noop, editProfile: noop, saveProfile: noop,
    account: { email: 'lin@example.com' },
  };

  it('点「退出登录」⇒ logout 未被调，弹窗出现（role=alertdialog，标题+确认按钮+取消按钮）', () => {
    const logout = vi.fn(async () => true);
    render(<SettingsPage {...base} logout={logout} />);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-testid="account-logout"]')!);
    expect(logout).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const confirmButton = document.querySelector('[data-testid="account-logout-confirm"]') as HTMLElement;
    expect(confirmButton).toBeTruthy();
    expect(confirmButton.textContent).toBe(text.accountLogout);
    expect(document.querySelector('[data-testid="account-logout-cancel"]')?.textContent).toBe(text.cancel);
    expect(dialog.textContent).toContain(text.accountLogoutConfirmTitle);
    expect(dialog.textContent).toContain(text.accountLogoutHint);
  });

  it('点「取消」⇒ 弹窗消失、回到按钮态，logout 未被调', () => {
    const logout = vi.fn(async () => true);
    render(<SettingsPage {...base} logout={logout} />);
    fireEvent.click(document.querySelector('[data-testid="account-logout"]')!);
    fireEvent.click(document.querySelector('[data-testid="account-logout-cancel"]')!);
    expect(logout).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="account-logout"]')).toBeTruthy();
  });

  it('点 scrim（弹窗外的遮罩）⇒ 弹窗消失、未调 logout；点卡片内部不冒泡关闭', () => {
    const logout = vi.fn(async () => true);
    render(<SettingsPage {...base} logout={logout} />);
    fireEvent.click(document.querySelector('[data-testid="account-logout"]')!);
    // 先点卡片内部（正文段落），不该关闭——事件不冒泡到 scrim 的 onClick。
    fireEvent.click(document.querySelector('[role="alertdialog"] p')!);
    expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    fireEvent.click(document.querySelector('[data-testid="confirm-dialog-scrim"]')!);
    expect(logout).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('Esc ⇒ 弹窗消失、未调 logout', () => {
    const logout = vi.fn(async () => true);
    render(<SettingsPage {...base} logout={logout} />);
    fireEvent.click(document.querySelector('[data-testid="account-logout"]')!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(logout).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('打开时焦点在取消按钮、关闭后焦点回到「退出登录」触发按钮', () => {
    const logout = vi.fn(async () => true);
    render(<SettingsPage {...base} logout={logout} />);
    const trigger = document.querySelector('[data-testid="account-logout"]') as HTMLElement;
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(document.querySelector('[data-testid="account-logout-cancel"]'));
    fireEvent.click(document.querySelector('[data-testid="account-logout-cancel"]')!);
    expect(document.activeElement).toBe(trigger);
  });

  it('点弹窗里的「退出登录」⇒ logout 调一次；父层同步 account=null 后卡片回未登录', () => {
    const logout = vi.fn(async () => true);
    const { rerender } = render(<SettingsPage {...base} logout={logout} />);
    fireEvent.click(document.querySelector('[data-testid="account-logout"]')!);
    fireEvent.click(document.querySelector('[data-testid="account-logout-confirm"]')!);
    expect(logout).toHaveBeenCalledTimes(1);
    // 退出成功后父层把 account 同步成 null（既有 R2 逻辑不动），设置页个人卡回到未登录。
    rerender(<SettingsPage {...{ ...base, account: null }} page="settings" logout={logout} />);
    const card = document.querySelector('[data-testid="open-profile"]') as HTMLElement;
    expect(card.textContent).toContain(text.accountNotLoggedIn);
  });
});

/**
 * ③（爸真机追加）：抽屉底部 .personal-bar 跟设置页个人卡同形态——未登录用通用头像图标+
 * 「未登录」，不再是「访客」；已登录用首字圆底+昵称/邮箱。数据来源与个人卡一致
 * （companion.account / state.preferences.nickname），右侧设置图标、testid、点击行为不变。
 */
describe('N-COMPANION-LOGOUT-CONFIRM-DIALOG ③ 抽屉个人入口跟个人卡同形态', () => {
  function portsUnauthenticated(): PlatformPorts {
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

  function portsAuthenticated(): PlatformPorts {
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
          account: { ticket: 'neo1.test-ticket', email: 'lin@example.com', userId: 'user-1' },
        }),
        write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}),
      },
    };
  }

  it('未登录：抽屉个人入口含通用头像图标与「未登录」，不含「访客」', async () => {
    await act(async () => { render(<MobileRoot ports={portsUnauthenticated()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.topbar strong')).toBeTruthy(); });
    fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
    const bar = document.querySelector('[data-testid="open-settings"]') as HTMLElement;
    expect(bar.querySelector('.avatar-generic')).toBeTruthy();
    expect(bar.textContent).toContain(text.accountNotLoggedIn);
    expect(bar.textContent).not.toContain(text.guest);
  });

  it('已登录：抽屉个人入口含邮箱（无昵称时用邮箱顶替）', async () => {
    await act(async () => { render(<MobileRoot ports={portsAuthenticated()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.topbar strong')).toBeTruthy(); });
    fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
    const bar = document.querySelector('[data-testid="open-settings"]') as HTMLElement;
    expect(bar.querySelector('.avatar-generic')).toBeNull();
    expect(bar.textContent).toContain('lin@example.com');
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
