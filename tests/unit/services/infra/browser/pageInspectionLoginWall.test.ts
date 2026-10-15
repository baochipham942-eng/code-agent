import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import type { BrowserTab } from '../../../../../src/host/services/infra/browser/types';
import { getBrowserPageContent } from '../../../../../src/host/services/infra/browser/pageInspectionHelpers';
import { isBrowserLoginWall } from '../../../../../src/shared/utils/browserLoginWall';

// ---------------------------------------------------------------------------
// 页内表单证据的最小 DOM 形状：只实现 getBrowserPageContent 的页内求值函数
// 真正会碰到的属性/方法，保证序列化 + 分类整条链路被测到（N-CRON-LOGINWALL-STOP r2）。
// ---------------------------------------------------------------------------

interface FakeInputSpec {
  type: string;
  autocomplete?: string | null;
}

interface FakeSubmitSpec {
  text?: string;
  value?: string | null;
  ariaLabel?: string | null;
  title?: string | null;
}

interface FakeFormSpec {
  role?: string | null;
  action?: string | null;
  inputs?: FakeInputSpec[];
  submits?: FakeSubmitSpec[];
}

function fakeForm(spec: FakeFormSpec) {
  const inputs = (spec.inputs ?? []).map((input) => ({
    type: input.type,
    getAttribute: (name: string) => (name === 'autocomplete' ? input.autocomplete ?? null : null),
  }));
  const submits = (spec.submits ?? []).map((submit) => ({
    textContent: submit.text ?? null,
    getAttribute: (name: string) => {
      if (name === 'value') return submit.value ?? null;
      if (name === 'aria-label') return submit.ariaLabel ?? null;
      if (name === 'title') return submit.title ?? null;
      return null;
    },
  }));
  return {
    getAttribute: (name: string) => {
      if (name === 'role') return spec.role ?? null;
      if (name === 'action') return spec.action ?? null;
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === 'input') return inputs;
      if (selector === 'button, input[type="submit"], input[type="button"]') return submits;
      return [];
    },
  };
}

function fakeTab(options: {
  url?: string;
  title?: string;
  text?: string;
  passwordCount?: number;
  forms?: FakeFormSpec[];
}): BrowserTab {
  const forms = (options.forms ?? []).map(fakeForm);
  const page = {
    url: () => options.url ?? 'http://127.0.0.1:4000/',
    title: async () => options.title ?? '',
    innerText: async () => options.text ?? '',
    $$eval: async (_selector: string, pageFunction: (elements: unknown[]) => unknown) =>
      pageFunction(_selector === 'form' ? forms : []),
    locator: (selector: string) => ({
      count: async () => {
        if (selector === 'form') return forms.length;
        if (selector.includes('password')) return options.passwordCount ?? 0;
        return 0;
      },
    }),
  } as unknown as Page;
  return { id: 'tab-1', page, url: options.url ?? 'http://127.0.0.1:4000/', title: options.title ?? '' };
}

async function loginWall(tab: BrowserTab): Promise<boolean> {
  const content = await getBrowserPageContent(tab);
  return isBrowserLoginWall({
    title: content.title,
    visibleText: content.text,
    passwordInputPresent: content.passwordInputPresent === true,
    loginFormPresent: content.loginFormPresent === true,
  });
}

describe('getBrowserPageContent login-form evidence (N-CRON-LOGINWALL-STOP r2)', () => {
  it('「你好，请登录」头 + 搜索表单不是登录墙', async () => {
    const tab = fakeTab({
      url: 'https://shop.example/home',
      title: '商城首页',
      text: '你好，请登录 免费注册 我的订单 搜索 iPhone 15 热销',
      forms: [{
        role: 'search',
        action: 'https://search.example/Search',
        inputs: [{ type: 'text' }],
        submits: [{ text: '搜索' }],
      }],
    });
    const content = await getBrowserPageContent(tab);
    expect(content.passwordInputPresent).toBe(false);
    expect(content.loginFormPresent).toBe(false);
    expect(await loginWall(tab)).toBe(false);
  });

  it('无 role/action 提示的纯搜索框（单文本输入 + 非登录提交）也不算', async () => {
    const tab = fakeTab({
      url: 'https://shop.example/home',
      title: '首页',
      text: '亲，请登录，购物车 3 件 全站搜索商品',
      forms: [{
        inputs: [{ type: 'text', autocomplete: 'off' }],
        submits: [{ ariaLabel: 'Magnifier' }],
      }],
    });
    expect(await loginWall(tab)).toBe(false);
  });

  it('「Please sign in」+ password 字段是登录墙', async () => {
    const tab = fakeTab({
      url: 'http://127.0.0.1:4123/login.html',
      title: 'Please sign in to continue',
      text: 'Please sign in to continue Email Password',
      passwordCount: 1,
      forms: [{
        action: '/login',
        inputs: [{ type: 'email' }, { type: 'password', autocomplete: 'current-password' }],
        submits: [{ text: 'Sign in' }],
      }],
    });
    const content = await getBrowserPageContent(tab);
    expect(content.passwordInputPresent).toBe(true);
    expect(content.loginFormPresent).toBe(true);
    expect(await loginWall(tab)).toBe(true);
  });

  it('手机号验证码登录表单（autocomplete=tel + 登录提交）算登录表单', async () => {
    const tab = fakeTab({
      url: 'https://example.test/login',
      title: '请登录',
      text: '请登录后继续浏览',
      forms: [{
        inputs: [{ type: 'text', autocomplete: 'tel' }],
        submits: [{ text: '登录 / 注册' }],
      }],
    });
    const content = await getBrowserPageContent(tab);
    expect(content.loginFormPresent).toBe(true);
    expect(await loginWall(tab)).toBe(true);
  });

  it('autocomplete=username 的文本输入 + Sign in 提交算登录表单', async () => {
    const tab = fakeTab({
      url: 'https://example.test/session/new',
      title: 'Log in',
      text: 'login required to view this page',
      forms: [{
        inputs: [{ type: 'text', autocomplete: 'username' }],
        submits: [{ value: 'Log in' }],
      }],
    });
    expect(await loginWall(tab)).toBe(true);
  });

  it('搜索输入框在表单里时不因提交文案误判（type=search 守卫）', async () => {
    const tab = fakeTab({
      url: 'https://example.test/home',
      title: '首页',
      text: '请登录享受会员价',
      forms: [{
        inputs: [{ type: 'search' }],
        submits: [{ text: 'login 提交' }],
      }],
    });
    expect(await loginWall(tab)).toBe(false);
  });
});
