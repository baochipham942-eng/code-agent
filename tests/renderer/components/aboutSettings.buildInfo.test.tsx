// @vitest-environment jsdom
// ============================================================================
// Settings > About 第二行构建信息（FB-571）
// formatter 纯函数逐段判空 + 真组件渲染（zh/en），只 mock fetchWebBuildInfo 与 ipcService。
// 时间断言统一把 process.env.TZ 钉在 Asia/Shanghai（afterAll 还原），不依赖 CI 时区。
// ============================================================================
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const fetchWebBuildInfo = vi.hoisted(() => vi.fn());
const ipcInvoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/persistenceHealth', () => ({ fetchWebBuildInfo }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: ipcInvoke },
  invokeDomain,
}));

import { AboutSettings } from '../../../src/renderer/components/features/settings/tabs/AboutSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { formatBuildInfoDisplay } from '../../../src/renderer/utils/buildInfoDisplay';
import { languages, type Language } from '../../../src/renderer/i18n';
import type { BuildInfo } from '@shared/contract';

// dogfood 报告 FB-571 的原始夹具：branch 为 null，builtAt 是带毫秒的 ISO 串
const DOGFOOD_BUILD: BuildInfo = {
  appName: 'code-agent',
  branch: null,
  commit: '94dbd68f94dbd68f94dbd68f94dbd68f94dbd68f',
  commitShort: '94dbd68',
  dirty: false,
  worktree: null,
  builtAt: '2026-11-03T13:38:03.505Z',
};

const ZH = languages.zh;
const EN = languages.en;

let previousTZ: string | undefined;
beforeAll(() => {
  previousTZ = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  if (previousTZ === undefined) delete process.env.TZ;
  else process.env.TZ = previousTZ;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 渲染真组件，fetchWebBuildInfo 用可控 promise，settle 后所有 setState 均已 flush */
async function renderAboutWithBuild(build: BuildInfo | null, language: Language) {
  useAppStore.setState({ language });
  let resolveFetch!: (value: BuildInfo | null) => void;
  fetchWebBuildInfo.mockImplementation(
    () => new Promise<BuildInfo | null>((resolve) => { resolveFetch = resolve; }),
  );
  ipcInvoke.mockResolvedValue('9.9.9-test');
  const view = render(<AboutSettings />);
  await act(async () => {
    resolveFetch(build);
  });
  return view;
}

describe('formatBuildInfoDisplay（About 第二行格式化）', () => {
  it('branch=null 时整段丢弃 branch，只留带标签的 commit 和本地时间（FB-571 dogfood 夹具）', () => {
    expect(formatBuildInfoDisplay(DOGFOOD_BUILD, ZH)).toBe('构建 94dbd68 · 2026-11-03 21:38');
    expect(formatBuildInfoDisplay(DOGFOOD_BUILD, EN)).toBe('build 94dbd68 · 2026-11-03 21:38');
  });

  it('branch 有值时带 zh/en 标签', () => {
    const build: BuildInfo = { ...DOGFOOD_BUILD, branch: 'mq/about-buildinfo-plain' };
    expect(formatBuildInfoDisplay(build, ZH)).toBe(
      '分支 mq/about-buildinfo-plain · 构建 94dbd68 · 2026-11-03 21:38',
    );
    expect(formatBuildInfoDisplay(build, EN)).toBe(
      'branch mq/about-buildinfo-plain · build 94dbd68 · 2026-11-03 21:38',
    );
  });

  it('commitShort=null 时整段丢弃 commit', () => {
    const build: BuildInfo = { ...DOGFOOD_BUILD, branch: 'main', commitShort: null };
    expect(formatBuildInfoDisplay(build, ZH)).toBe('分支 main · 2026-11-03 21:38');
    expect(formatBuildInfoDisplay(build, EN)).toBe('branch main · 2026-11-03 21:38');
  });

  it('builtAt 不可解析时整段丢弃时间，且截掉秒与毫秒', () => {
    const invalid: BuildInfo = { ...DOGFOOD_BUILD, branch: 'main', builtAt: 'not-a-date' };
    expect(formatBuildInfoDisplay(invalid, ZH)).toBe('分支 main · 构建 94dbd68');
    expect(formatBuildInfoDisplay(invalid, EN)).toBe('branch main · build 94dbd68');

    const withSeconds: BuildInfo = { ...DOGFOOD_BUILD, branch: 'main', builtAt: '2026-11-03T13:38:59.999Z' };
    expect(formatBuildInfoDisplay(withSeconds, ZH)).toBe('分支 main · 构建 94dbd68 · 2026-11-03 21:38');
    expect(formatBuildInfoDisplay(withSeconds, EN)).toBe('branch main · build 94dbd68 · 2026-11-03 21:38');
  });

  it('三项全缺失/无效时返回 null（第二行整体不渲染），任何情况下不出现「未知」或空括号', () => {
    const empty: BuildInfo = { ...DOGFOOD_BUILD, branch: null, commitShort: null, builtAt: 'garbage' };
    expect(formatBuildInfoDisplay(empty, ZH)).toBeNull();
    expect(formatBuildInfoDisplay(empty, EN)).toBeNull();
    for (const t of [ZH, EN]) {
      const shown = formatBuildInfoDisplay(empty, t) ?? '';
      expect(shown).not.toMatch(/未知|unknown/);
      expect(shown).not.toMatch(/[（(]\s*[)）]/);
      expect(shown).not.toContain('@');
    }
  });
});

describe('AboutSettings 组件渲染（真组件，只 mock fetchWebBuildInfo 与 ipcService）', () => {
  it('zh：dogfood 夹具渲染出带标签的第二行，不再是「未知 @」+ 毫秒 ISO 串', async () => {
    const view = await renderAboutWithBuild(DOGFOOD_BUILD, 'zh');
    const raw = view.container.querySelector('p.font-mono')?.textContent ?? null;
    console.log('[evidence④] zh raw <p> text:', JSON.stringify(raw));
    expect(raw).toBe('构建 94dbd68 · 2026-11-03 21:38');
    expect(raw).not.toMatch(/未知|undefined|@|（|\)/);
  });

  it('en：dogfood 夹具渲染出带标签的第二行，时间同为本地 YYYY-MM-DD HH:mm', async () => {
    const view = await renderAboutWithBuild(DOGFOOD_BUILD, 'en');
    const raw = view.container.querySelector('p.font-mono')?.textContent ?? null;
    console.log('[evidence④] en raw <p> text:', JSON.stringify(raw));
    expect(raw).toBe('build 94dbd68 · 2026-11-03 21:38');
    expect(raw).not.toMatch(/unknown|undefined|@|\(|\)/);
  });

  it('branch/commitShort/builtAt 全缺失时第二行整体不渲染（无「未知」、无空括号、无游离分隔符）', async () => {
    const empty: BuildInfo = { ...DOGFOOD_BUILD, branch: null, commitShort: null, builtAt: 'garbage' };
    const view = await renderAboutWithBuild(empty, 'zh');
    expect(view.container.querySelector('p.font-mono')).toBeNull();
    expect(view.container.textContent).not.toMatch(/未知|unknown/);
  });
});
