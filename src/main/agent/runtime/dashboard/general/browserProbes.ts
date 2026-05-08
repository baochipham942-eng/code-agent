/**
 * Imperative browser probes — Phase 4 Dashboard PR-D.
 *
 * 这些 probe launch 真 browser（Playwright headless 或 system Chrome CDP），
 * 跑 navigate → DOM probe → screenshot 检查。复用 PR-A 抽出来的
 * runBrowserVisualSmoke 实现，dashboard 与 game 共用同一份 browser launch
 * 逻辑（plan §3 决策 1）。
 *
 * Plan §3 决策 5 列了 loads_no_error + viewport_non_blank 两个 ID，但实现
 * 上**合并为单 imperative probe**：两件事都依赖一次 browser launch + 一次
 * navigate + 一次 page.evaluate，拆开会浪费一次 launch (~5s)。失败时根因
 * 仍可从 failure message 区分（"saw console errors..." vs "no canvas and
 * too little visible DOM..."）。
 *
 * Plan §6 风险 1 (Playwright headless flakey) 由 runBrowserVisualSmoke
 * 内部已有的 timeout / skipped fallback 兜底；本 probe 只做 transform，
 * 不重试。
 */

import type {
  DashboardArtifactInput,
  DashboardImperativeProbe,
  DashboardProbeDeclaration,
  DashboardProbeResult,
} from '../types';
import {
  runBrowserVisualSmoke,
  DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS,
} from '../../browser/visualSmoke';

/**
 * browser_visual_smoke — launch browser，覆盖 loads_no_error 和
 * viewport_non_blank 两件事：
 * - console / page errors（loads_no_error）
 * - canvas 可见性 + body 可见 DOM（viewport_non_blank）
 *
 * Skipped path：runBrowserVisualSmoke 在 system Chrome 不可用时返回
 * skipped=true，这里把 skipped 当作 pass（无法验证 ≠ 验证失败）。
 */
export const BROWSER_VISUAL_SMOKE_PROBE: DashboardImperativeProbe = {
  id: 'browser_visual_smoke',
  kind: 'imperative',
  description: 'Launch headless browser，验证页面无 console error 且至少一个 viewport 渲染出非空内容',
  async evaluate(input: DashboardArtifactInput): Promise<DashboardProbeResult> {
    let summary;
    try {
      summary = await runBrowserVisualSmoke(input.filePath, DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS);
    } catch (err) {
      // runBrowserVisualSmoke 内部已 try/catch 返回 result，这里只为防御
      // 万一 launch 前置（e.g. provider resolve）抛错。
      return {
        probe: 'browser_visual_smoke',
        passed: false,
        failure: `browser visual smoke 启动失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (summary.skipped) {
      return {
        probe: 'browser_visual_smoke',
        passed: true,
        diagnostics: {
          skipped: true,
          browserVisualSmoke: summary,
          ...(summary.diagnostics ?? {}),
        },
      };
    }

    return {
      probe: 'browser_visual_smoke',
      passed: summary.passed,
      failure: summary.passed ? undefined : summary.failures.join(' | '),
      diagnostics: {
        browserVisualSmoke: summary,
        ...(summary.diagnostics ?? {}),
      },
    };
  },
};

/**
 * 集合导出 — GeneralDashboardChecker 把这个数组合到 probes 里。
 *
 * 顺序：declarative HTML 类（cheap）在前，imperative browser 类（贵，~5-10s）
 * 在后。Imperative probe 多了之后 (PR-E state_change_on_click) 也按类似策略
 * 排在末尾。
 */
export const BROWSER_PROBES: readonly DashboardProbeDeclaration[] = [
  BROWSER_VISUAL_SMOKE_PROBE,
];
