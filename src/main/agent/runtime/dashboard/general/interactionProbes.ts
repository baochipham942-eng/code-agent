/**
 * Anti-Potemkin interaction probes — Phase 4 Dashboard PR-E.
 *
 * 这是 dashboard verifier 链路里**最有价值的 probe**——其他 probe（HTML 完
 * 整性 / console errors / viewport 非空）都只检查"页面渲染了"，但 Replit
 * Agent 3 / v0 / Claude Code 的核心问题是 "interface 渲染了但事件没接"。
 *
 * 实现：launch headless browser → 找第一个 <button> 或 <a> → click → 在
 * MutationObserver 上等 100ms → 看是否有 meaningful DOM mutation。Potemkin
 * 模式（noop handler / broken handler / CSS-only :hover）都不会产生 DOM
 * mutation 或会被 handler error capture 抓到。
 *
 * 五个 mode：
 *   pass         — click 后有 meaningful DOM mutation
 *   no-target    — 页面找不到 <button> / <a>，无法验证（fail）
 *   no-mutation  — click 后 100ms DOM 无 mutation（核心 Potemkin signal）
 *   handler-error- listener 抛错被 window.onerror 捕获
 *   launch-error - browser launch / navigate 失败（环境问题）
 *
 * Plan §6 风险 3 / 4 已规避：
 *   - 风险 3 (selector 选错): 第一波只 <button> + <a[href]>，不试 [role=button]
 *   - 风险 4 (DOM diff 算法): 用 MutationObserver；忽略 class / style /
 *     data-* / aria-* 属性变化（:focus / :active / hover 衍生）
 *
 * 真跑 launch + interaction 的实现拆到 interactionProbeRunner.ts，让 vi.mock
 * 在测试时能替换 runStateChangeProbe（ES module 闭包绑定不允许替换同文件内
 * 部 reference）。
 */

import type {
  DashboardArtifactInput,
  DashboardImperativeProbe,
  DashboardProbeDeclaration,
  DashboardProbeResult,
} from '../types';
import { runStateChangeProbe } from './interactionProbeRunner';

export const STATE_CHANGE_ON_CLICK_PROBE: DashboardImperativeProbe = {
  id: 'state_change_on_click',
  kind: 'imperative',
  description: 'Click 第一个 <button> / <a>，验证 100ms 内 DOM 有 meaningful mutation（anti-Potemkin）',
  async evaluate(input: DashboardArtifactInput): Promise<DashboardProbeResult> {
    const r = await runStateChangeProbe(input.filePath);

    switch (r.mode) {
      case 'pass':
        return {
          probe: 'state_change_on_click',
          passed: true,
          diagnostics: { selector: r.selector, mutations: r.mutations },
        };
      case 'no-target':
        return {
          probe: 'state_change_on_click',
          passed: false,
          failure: '页面找不到 <button> 或 <a> 元素，无法验证交互（dashboard 至少应有一个交互入口）。',
        };
      case 'no-mutation':
        return {
          probe: 'state_change_on_click',
          passed: false,
          failure: `点击 ${r.selector} 后 100ms 内 DOM 无 meaningful mutation — 疑似 Potemkin：interface 渲染了但 event listener 没接，或仅 :hover/:focus CSS 视觉变化。`,
          diagnostics: { selector: r.selector, mutations: 0 },
        };
      case 'handler-error':
        return {
          probe: 'state_change_on_click',
          passed: false,
          failure: `点击 ${r.selector} 时 handler 抛错: ${r.errorMessage}`,
          diagnostics: { selector: r.selector, handlerError: r.errorMessage },
        };
      case 'launch-error':
        return {
          probe: 'state_change_on_click',
          passed: false,
          failure: `state_change_on_click 启动失败: ${r.errorMessage}`,
        };
    }
  },
};

export const INTERACTION_PROBES: readonly DashboardProbeDeclaration[] = [STATE_CHANGE_ON_CLICK_PROBE];
