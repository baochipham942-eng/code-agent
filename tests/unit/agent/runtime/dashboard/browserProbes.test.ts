// ============================================================================
// BROWSER_VISUAL_SMOKE_PROBE unit tests — PR-D.
//
// 用 vi.mock 替换 runBrowserVisualSmoke，让 unit test 不真 launch browser
// （快、稳、不依赖 Playwright 环境）。覆盖 transform / failure 拼接 / skipped
// fallback / throw 防御 4 个路径。
//
// 真 browser launch 的 e2e 验证留给 acceptance test（plan §6 风险 1：本地
// 跑 npm run acceptance:platformer-gameplay-validate 那条路径已经覆盖
// runBrowserVisualSmoke 自己；dashboard 没专门的 acceptance 脚本，依靠 PR-D
// transform 单测 + integration smoke 验证 wiring 正确）。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserVisualSmokeSummary } from '../../../../../src/main/agent/runtime/browser/types';

// vi.mock factory 是 hoisted 到文件顶部的 — 直接引用 outer 变量会报
// "Cannot access X before initialization"。用 vi.hoisted 让 mock fn 跟着
// vi.mock 一起 hoist。
const { runBrowserVisualSmokeMock } = vi.hoisted(() => ({
  runBrowserVisualSmokeMock: vi.fn(),
}));

vi.mock('../../../../../src/main/agent/runtime/browser/visualSmoke', () => ({
  runBrowserVisualSmoke: runBrowserVisualSmokeMock,
  DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS: 10000,
}));

import { BROWSER_VISUAL_SMOKE_PROBE, BROWSER_PROBES } from '../../../../../src/main/agent/runtime/dashboard/general/browserProbes';

const DUMMY_INPUT = { filePath: '/tmp/whatever.html' };

beforeEach(() => {
  runBrowserVisualSmokeMock.mockReset();
});

describe('BROWSER_PROBES set', () => {
  it('exports browser_visual_smoke single imperative probe', () => {
    expect(BROWSER_PROBES.map((p) => p.id)).toEqual(['browser_visual_smoke']);
  });

  it('all probes are imperative (require browser launch)', () => {
    expect(BROWSER_PROBES.every((p) => p.kind === 'imperative')).toBe(true);
  });
});

describe('browser_visual_smoke probe — passed path', () => {
  it('passes when summary.passed=true with no failures', async () => {
    const summary: BrowserVisualSmokeSummary = {
      attempted: true,
      passed: true,
      failures: [],
      checks: ['browser visual smoke passed via Playwright bundled Chromium'],
    };
    runBrowserVisualSmokeMock.mockResolvedValueOnce(summary);

    const result = await BROWSER_VISUAL_SMOKE_PROBE.evaluate(DUMMY_INPUT);

    expect(result.probe).toBe('browser_visual_smoke');
    expect(result.passed).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.diagnostics?.browserVisualSmoke).toEqual(summary);
  });

  it('forwards summary diagnostics into probe diagnostics', async () => {
    const summary: BrowserVisualSmokeSummary = {
      attempted: true,
      passed: true,
      failures: [],
      checks: [],
      diagnostics: {
        title: 'OK',
        canvasCount: 1,
        nonblankCanvasCount: 1,
        consoleErrors: [],
      },
    };
    runBrowserVisualSmokeMock.mockResolvedValueOnce(summary);

    const result = await BROWSER_VISUAL_SMOKE_PROBE.evaluate(DUMMY_INPUT);

    expect(result.diagnostics?.title).toBe('OK');
    expect(result.diagnostics?.canvasCount).toBe(1);
    expect(result.diagnostics?.browserVisualSmoke).toEqual(summary);
  });
});

describe('browser_visual_smoke probe — failure path', () => {
  it('fails when summary.passed=false; joins all failure messages with " | "', async () => {
    const summary: BrowserVisualSmokeSummary = {
      attempted: true,
      passed: false,
      failures: [
        'browser visual smoke saw console errors: TypeError x is undefined',
        'desktop visual smoke found no canvas and too little visible DOM content.',
      ],
      checks: [],
    };
    runBrowserVisualSmokeMock.mockResolvedValueOnce(summary);

    const result = await BROWSER_VISUAL_SMOKE_PROBE.evaluate(DUMMY_INPUT);

    expect(result.passed).toBe(false);
    expect(result.failure).toContain('console errors');
    expect(result.failure).toContain('no canvas and too little visible DOM');
    expect(result.failure).toContain(' | ');
  });
});

describe('browser_visual_smoke probe — skipped path', () => {
  it('treats skipped=true as pass with skipped marker in diagnostics', async () => {
    // System Chrome unavailable / browser provider degraded — runBrowserVisualSmoke
    // returns skipped=true。无法验证不该判定为 fail。
    const summary: BrowserVisualSmokeSummary = {
      attempted: false,
      skipped: true,
      passed: true,
      failures: [],
      checks: ['browser visual smoke skipped: System Chrome executable is missing.'],
    };
    runBrowserVisualSmokeMock.mockResolvedValueOnce(summary);

    const result = await BROWSER_VISUAL_SMOKE_PROBE.evaluate(DUMMY_INPUT);

    expect(result.passed).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.diagnostics?.skipped).toBe(true);
  });
});

describe('browser_visual_smoke probe — throw defense', () => {
  it('returns failed result when runBrowserVisualSmoke throws unexpectedly', async () => {
    runBrowserVisualSmokeMock.mockRejectedValueOnce(new Error('provider resolve crashed'));

    const result = await BROWSER_VISUAL_SMOKE_PROBE.evaluate(DUMMY_INPUT);

    expect(result.passed).toBe(false);
    expect(result.failure).toContain('启动失败');
    expect(result.failure).toContain('provider resolve crashed');
  });
});
