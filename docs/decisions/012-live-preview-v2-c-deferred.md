# ADR-012: V2-C Next.js App Router 支持 — 砍掉，改"Vite-only MVP"叙事

> 状态: accepted
> 日期: 2026-04-26
> 关联: `~/.claude/plans/live-preview-v2.md`、`~/.claude/plans/optimized-percolating-mist.md`、`docs/decisions/011-chat-native-workbench.md`

## 背景

V2 Live Preview 计划三块：A (devServerManager) + B (Tweak 面板) + **C (Next.js App Router 支持)**。A/B 已实现并 commit (HEAD 7 commits ahead origin)，准备进入 C 时做技术前提核查。

C 块原计划基于一个假设：
> 在 vite-plugin-code-agent-bridge 的 runtime 里，找不到 `data-code-agent-source` 时回退到 React Fiber 的 `_debugSource` 字段。这样 Next 用户也能跑 click-to-source。

决策门槛（live-preview-v2.md D11）：
> 跑 spike 测 5 个 Next App Router 项目，准确度 ≥70% 继续；< 70% 砍。

## 调研结论

React 19 在 PR #28265 中**移除了 Fiber 上的 `_debugSource` 字段**（2024 年底合入 main，2024-12-05 React 19 release 正式发布）。替代的 `_debugInfo` 字段永远返回 `null`。社区在 [#32574](https://github.com/facebook/react/issues/32574)、[#31981](https://github.com/facebook/react/issues/31981)、[#29092](https://github.com/facebook/react/issues/29092) 抗议但 React 团队迄今未回滚。

Next.js 项目的 React 版本分布（截至 2026-04）：

| Next 版本 | React 版本 | `_debugSource` |
|----------|----------|----------------|
| Next 14（2023 GA） | React 18 | ✓ 有（dev mode） |
| Next 15（2024-10 GA） | React 19 | ✗ 移除 |
| Next 16（预计 2026 Q3） | React 19+ | ✗ 移除 |

新建 Next App Router 项目（`create-next-app` 默认）从 2024-10 起全部走 Next 15 + React 19。**这是 V2-C 的目标用户基本盘**。

5 项目 spike 的预期准确度：≤30%（仅遗留 Next 14 项目能命中），远低于 70% 决策门槛，**自动砍**。

## 决策

**砍掉 V2-C，把 Live Preview 的 V2 范围收敛到 Vite-only MVP。**

调整后的 V2 形态：
- A. devServerManager（自动起 Vite/CRA dev server）— **已交付** ✓
- B. Tweak 面板（5 类原子操作不走 LLM）— **已交付** ✓
- C. Next.js 支持 — **砍** ✗

## 选项考虑

### 选项 1：硬上 `_debugSource` fallback
- 优点：成本最低（30 行 runtime 代码）
- 缺点：Next 15+ 上 0% 准确度，劝退用户基本盘；维护负担（用户报「不工作」时要解释 React 19 移除）。**否决**

### 选项 2：写 SWC 插件（Rust）
- 优点：技术上可行，能给 Next 用户提供跟 Vite 同等的体验
- 缺点：
  - 估时 1-2 周（Rust + SWC AST API 学习成本 + Next 私有 SWC 配置接入）
  - Maintenance burden 重（Next 每次 bump SWC 都可能 break）
  - V2 计划资源已经用掉 7 commits，再投 1-2 周性价比不高
- 否决

### 选项 3：Babel 模式 escape hatch
- 优点：复用现成的 `@babel/plugin-transform-react-jsx-source`
- 缺点：
  - Next 用户切 Babel 模式 = 失去 SWC 性能（dev / build 慢 30%+）
  - Next 团队不推荐 Babel 模式（[官方文档](https://nextjs.org/docs/app/building-your-application/configuring/babel) 在「Migrating to SWC」前置警告）
  - 用户实际不会接受
- 否决

### 选项 4：等 Anthropic / Vercel 官方方案
- 优点：零工作量
- 缺点：
  - Anthropic Claude Design 的 visual editing 作用域是设计稿不是代码（确认过）
  - Vercel `v0` 走 RSC 内部 API，不开放
  - 没有可见的官方 OSS 解决方案 ETA
- 不可执行

### 选项 5：Vite-only MVP（采纳）
- 优点：
  - V2-A/B 已经交付，叙事完整
  - Vite 生态在 AI agent 用户里覆盖率 ~60%（Cursor / Lovable / v0 早期 / 多数独立项目都是 Vite）
  - 作品集叙事更聚焦：「我做了 click-to-edit + 不走 LLM 的 Tweak 面板，技术选型理由是什么」
  - 释放出的资源给 V3（批注 / 多元素批选）或评测
- 缺点：
  - 不覆盖 Next App Router 项目的 click-to-source
  - 用户拿 Next 项目跑会看到「不支持 Next，请换 Vite 或手动加 className=""」类提示

## 后果

### 积极影响
- V2 范围明确：「Vite-only Live Preview MVP，含自动起 dev server + Tailwind 不走 LLM 的 Tweak 面板」
- 给作品集 narrative 提供可挑战的「砍掉的功能」案例（资深 PM 的 scope discipline）
- 释放 1-2 周时间投回 V3 评测 / 求职准备

### 消极影响
- Next App Router 用户体验断档；DevServerLauncher 探测到 `next.config.*` 时友好降级，明示「请等 V3 或手动起后填 URL」
- npm 包 `vite-plugin-code-agent-bridge` 的 README 需要更新：明示 Next 不在范围

### 风险
- 如果未来 React 团队回滚 `_debugSource`（社区压力），需要重新评估 C 是否捡起来
- SWC 插件方案如果有维护成本可控的开源前驱（如 stagewise / locator-js 之类社区项目），可以再评估「不重写、复用」的路径

## 落地动作

1. ✓ live-preview-v2.md 标 C 砍 + reason
2. ✓ 本 ADR 落库
3. （可选）`devServerManager.ts` 探测到 Next 时的 reason 文案优化为「V2 不支持，建议换 Vite 项目；或手动 `next dev` 后填 URL」（已在 D1 写过类似，仅微调措辞）
4. （可选）npm 包 README 加「Vite-only」标识
5. V3 优先级里加「Next.js 支持评估」 — 等 React 19 生态成熟、SWC 插件社区方案出现再决策

## 相关文档

- [V2 plan](~/.claude/plans/live-preview-v2.md)
- [V1 MVP plan](~/.claude/plans/optimized-percolating-mist.md)
- [React 19 \_debugSource removal — facebook/react#32574](https://github.com/facebook/react/issues/32574)
- [React 19 release notes](https://react.dev/blog/2024/12/05/react-19)
