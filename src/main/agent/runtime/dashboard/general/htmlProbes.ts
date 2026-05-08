/**
 * HTML-level declarative probes — Phase 4 Dashboard PR-C.
 *
 * 这些 probe 评估 raw HTML 文本（regex 层面），不 launch browser，不 parse DOM。
 * 跟 PR-D 的 imperative browser probe（loads_no_error / viewport_non_blank）
 * 互补：declarative 抓静态语法/内容问题，imperative 抓运行时问题。
 *
 * MVP 集合：
 * - html_complete:   <html> + <body> 标签存在且 </html> 闭合（防截断）
 * - no_lorem_ipsum:  内容不含占位文本（lorem ipsum / TODO / Coming soon / 占位）
 *
 * consistent_styling（plan §3 决策 5 列的第 3 个 declarative）**故意延后**：
 * 它需要 cross-element CSS 比较，不适合 simple regex predicate。等 PR-D
 * imperative browser probe 接入后再设计成 imperative 模式。
 */

import type {
  DashboardDeclarativeProbe,
  DashboardProbeDeclaration,
} from '../types';

/**
 * html_complete — HTML 文档结构完整。
 *
 * 匹配条件：必须同时存在 <html...> 开标签、<body...> 开标签、</body> 闭合、
 * </html> 闭合。截断的 LLM 输出（半截 <body> 没 </html>）会被这里捕获。
 *
 * 不要求 `<!DOCTYPE>` — Replit Agent 3 / v0 输出经常省略 doctype，但浏览器
 * 仍能渲染。把 doctype 加进必检列表会误伤太多 case。
 */
export const HTML_COMPLETE_PROBE: DashboardDeclarativeProbe = {
  id: 'html_complete',
  kind: 'declarative',
  description: 'HTML 文档结构完整（含 <html> / <body> 开闭标签且未截断）',
  predicate: {
    op: 'html-content-matches',
    pattern: '<html[^>]*>[\\s\\S]*<body[^>]*>[\\s\\S]*</body>[\\s\\S]*</html>',
    flags: 'i',
  },
  expectation: 'expect-true',
  failureMessage: 'HTML 文档结构不完整：缺少 <html> 或 <body> 标签，或被截断未闭合 </html>。',
};

/**
 * no_lorem_ipsum — 内容不含明显的占位文本。
 *
 * 命中触发器：lorem ipsum / TODO / Coming soon / placeholder / 占位 /
 * 待补充 / 此处填写。这些都是 AI Coding Agent 生成产物里常见的"演示稿后忘记
 * 替换"症状。匹配大小写不敏感。
 *
 * 误伤风险：合法字符串（如 "// TODO: this is intentional"）也会被命中。
 * 当前接受这个 false-positive 率，让 LLM repair prompt 看到这个 failure
 * 后自己判断是否需要替换。如果实际项目里有合法 TODO，PR-C 之后可以加
 * exclusion list（但不在 MVP scope）。
 */
export const NO_LOREM_IPSUM_PROBE: DashboardDeclarativeProbe = {
  id: 'no_lorem_ipsum',
  kind: 'declarative',
  description: 'HTML 内容不含 placeholder / lorem ipsum / TODO / Coming soon / 占位文本',
  predicate: {
    op: 'html-content-not-matches',
    pattern: 'lorem ipsum|coming soon|\\bTODO\\b|placeholder|占位|待补充|此处填写',
    flags: 'i',
  },
  expectation: 'expect-true',
  failureMessage: '页面残留占位文本（lorem ipsum / TODO / Coming soon / placeholder / 占位 等），需替换为真实内容。',
};

/**
 * 集合导出 — GeneralDashboardChecker 把这个数组合到 probes 里。
 * 顺序：html_complete 在前（更基础的语法检查），no_lorem_ipsum 在后。
 * 顺序不影响判定（aggregation 只看 passed/failed），但保留对调试输出更直观。
 */
export const HTML_PROBES: readonly DashboardProbeDeclaration[] = [
  HTML_COMPLETE_PROBE,
  NO_LOREM_IPSUM_PROBE,
];
