# DashboardVerifier 实施计划（Phase 4 后续）

**Date**: 2026-05-08（drafted 2026-05-07）
**Author**: 劳拉
**Status**: ready-to-implement，等爸开 session 起手
**前置依赖**: Phase 4 PR-1 / PR-2 / PR-3 / PR-1.5 已合并到 main（merge sha `fb31681f` / `4dc5308e` / `772c7c75` / `fe87e8fd`）
**相关文档**:
- [docs/audits/2026-05-07-game-acceptance-architecture.md](2026-05-07-game-acceptance-architecture.md) §4.1 / §4.2 / §6 Phase 4
- [docs/decisions/016-no-cross-kind-verifier-interface.md](../decisions/016-no-cross-kind-verifier-interface.md)

---

## 1. 为什么现在做这个

Phase 4 把 game 架构成功扩展到 deck（DeckVerifier 接进 pptGenerate.ts:584）。下一个 verifier 候选 3 个：DocVerifier / WorkbookVerifier / DashboardVerifier。**强烈推荐先做 DashboardVerifier**：

1. **价值最高**——AI Coding Agent（Claude Code / Cursor / v0 / Bolt / Replit Agent 3）生成的就是 interactive 产物，不是 docx/xlsx。这是跟竞品能力直接挂钩的能力面。
2. **底层基础设施已就绪**：
   - `BrowserVisualSmokeSummary` 已在 `gameArtifactValidator.ts:42` 抽出
   - `inferArtifactKind` 在 `gameArtifactValidator.ts:326-334` 已识别 'interactive_app'
   - Playwright 在 repo（platformer 端到端用）
3. **能解决 audit doc §4 反复推荐的 anti-Potemkin 问题**——Replit Agent 3 公开的核心问题就是 "interface 渲染了但事件没接"，game validator 的 `browserVisualSmoke` 只检查"画布非空"，是 Potemkin 级别。
4. **顺手给 game validator 减负**——`gameArtifactValidator.ts` 2058 行里有相当一部分是 browser smoke 相关，抽出来后 game 端会瘦下来。

DocVerifier / WorkbookVerifier 价值低于 DashboardVerifier（docx/xlsx 用户量小 + 跟 AI Coding Agent 主线弱相关），不在本计划范围。如未来真要做，再单开 plan。

---

## 2. 现状盘点（grep 实测）

### interactive_app 已有基础设施

| 位置 | 状态 |
|------|------|
| `gameArtifactValidator.ts:35` | `inferredKind: 'game' \| 'interactive_app' \| 'other'` 类型已声明 |
| `gameArtifactValidator.ts:326-334` | `inferArtifactKind` 已通过 `hasStrongInteractiveSignal` / `<canvas>` / `<script>` 推断 'interactive_app' |
| `gameArtifactValidator.ts:1688-1707` | 推断到 `interactive_app` 后，进入 `shouldValidate` 分支（包含 browser smoke）但**跳过** game-specific mechanics 检查 |
| `gameArtifactValidator.ts:1832-1851` | `runBrowserVisualSmoke` 真正跑 browser；返回 `BrowserVisualSmokeSummary` |
| `gameArtifactValidator.ts:42 / 109-136` | `BrowserVisualSmokeSummary` 类型 + `cloneBrowserVisualSmoke` helper 已抽出 |

**关键事实**：interactive_app 不是从零开始——browser smoke 已经能跑。但**没有独立 verifier 入口**，所有 interactive_app 走的都是 `validateGameArtifact` 函数，挂在 game 心智模型下。

### game validator 里跟 dashboard 强相关的代码

预估约 200-300 行（browser smoke 调度 + `BrowserVisualSmokeSummary` clone/return + interactive_app 分支处理）可以抽到独立模块。剩下的（mechanics / verb / runtime probe）才是 game-specific。

---

## 3. 关键设计决策

### 决策 1：解耦 `runBrowserVisualSmoke` → 独立模块

把 browser smoke 相关逻辑从 `gameArtifactValidator.ts` 抽到新文件 `src/main/agent/runtime/browser/visualSmoke.ts`。两边都从这里 import：

- `gameArtifactValidator.ts` — game 路径继续用，行为零变化（红线 4 baseline）
- `DashboardVerifier.ts` — dashboard 路径用同一份实现

**这是 PR-A 单独的 commit**，跟 dashboard verifier 主体分开。先抽提，再加新功能。

### 决策 2：DashboardVerifier 用同步类形态（参考 DeckVerifier）

跟 DeckVerifier 同样 `class DashboardVerifier { validate(input) }` 形态。**input 是 file path**（不是 in-memory），因为 dashboard 验证需要真起 browser 跑产物，必须有文件落盘。

```ts
class DashboardVerifier {
  validate(filePath: string, options?: DashboardVerifyOptions): Promise<DashboardCheckResult>;
}
```

这跟 DeckVerifier 同步签名不同（async 因为 browser smoke 是 async），跟 ADR 016 不矛盾——ADR 016 明确说 "form mismatch 是接受的，不强求统一接口"。

### 决策 3：anti-Potemkin probe 用声明式

仿 DeckVerifier 的 declarative + imperative 双 mode。dashboard 大部分 probe 是 imperative（Playwright interaction），但**声明部分可以 declarative**：

```ts
interface DashboardProbeDeclaration {
  id: string;
  description: string;            // "filter changes list contents"
  setup?: PlaywrightSetup;        // 'wait for selector', 'route mock' 等
  trigger: PlaywrightAction;      // 'click selector', 'fill input', 'press Enter'
  assert: PlaywrightAssertion;    // 'DOM changed in selector', 'attribute changed'
}
```

这套 schema 让 probe 写起来像配置而不是代码，复用面广。

### 决策 4：跟 Replit Agent 3 reference

audit doc §4.1 说 Replit Verifier 在 REPL 跑 Playwright + DOM + ARIA，专门防 Potemkin。我们对齐这个模式但**不引 sub-agent**——单进程跑 Playwright 就够，不需要独立 verifier agent。

### 决策 5：MVP probe 集合

第一波 probe 不求多，5-7 个就够：

| Probe | 类型 | 验证 |
|-------|------|------|
| `html_complete` | declarative | `<html>` / `<body>` 存在 + 不截断 |
| `loads_no_error` | imperative | Playwright launch + console error count = 0 |
| `viewport_non_blank` | imperative | screenshot 非全黑/全白（已有 logic 在 game validator） |
| `interactive_handlers_attached` | imperative | 至少 1 个 `addEventListener` 实际挂载（伪 DOM 元素探针） |
| `state_change_on_click` | imperative | 任找 1 个 `<button>` / `[role=button]` → click → 100ms 后 DOM 真变了 |
| `no_lorem_ipsum` | declarative | content regex 不含 "lorem ipsum" / "TODO" / "Coming soon" |
| `consistent_styling` | declarative | 不同 component 的 font/spacing 不漂移（borrow 自 deck visualReview） |

`state_change_on_click` 是 **anti-Potemkin 核心**——其他都是基础健康检查。

---

## 4. 架构

```
src/main/agent/runtime/browser/
├── visualSmoke.ts                      ← PR-A: 从 gameArtifactValidator 抽出
└── types.ts                            ← BrowserVisualSmokeSummary 等类型

src/main/agent/runtime/dashboard/
├── types.ts                            ← DashboardArtifactInput / DashboardProbeDeclaration / 等
├── DashboardVerifier.ts                ← 顶层入口（仿 DeckVerifier）
├── registry.ts                         ← subtype registry（PR-MVP 只占位 'general'）
├── general/
│   ├── GeneralDashboardChecker.ts      ← 串联 5-7 个 probe
│   ├── htmlProbes.ts                   ← html_complete / no_lorem_ipsum (declarative)
│   ├── browserProbes.ts                ← loads_no_error / viewport_non_blank / etc (imperative)
│   └── interactionProbes.ts            ← state_change_on_click (anti-Potemkin)
└── __tests__/                          ← 见 tests/ 路径，vitest 不索引 src/

tests/unit/agent/runtime/dashboard/
├── htmlProbes.test.ts
├── browserProbes.test.ts               ← 用 mock browser 或 fixture HTML + headless mode
└── DashboardVerifier.test.ts
```

---

## 5. PR 拆分

5 个 stacked PR（参考 Phase 4 节奏）：

### PR-A: 抽 browser visual smoke 到独立模块（preparatory refactor）

- 新建 `src/main/agent/runtime/browser/{types.ts, visualSmoke.ts}`
- 把 `gameArtifactValidator.ts` 里 `BrowserVisualSmokeSummary` 类型 + `cloneBrowserVisualSmoke` + `runBrowserVisualSmoke` 全部移过去
- `gameArtifactValidator.ts` 改成 `import { ... } from '../browser/visualSmoke'`
- **零行为变化**——grep 全仓 `runBrowserVisualSmoke` / `BrowserVisualSmokeSummary` 调用点，全部改 import 路径
- **必须跑** `npm run acceptance:platformer-gameplay-validate` 确认 game 行为零变化（红线 4）
- 单 commit，~200 行 move + ~30 行 import 改动

### PR-B: DashboardVerifier 骨架 + types

- 新建 `src/main/agent/runtime/dashboard/{types.ts, registry.ts, DashboardVerifier.ts, general/GeneralDashboardChecker.ts}`
- 仿 PR-2 DeckVerifier 模式
- `general/GeneralDashboardChecker.probes` 是 readonly 数组（占位空 `[]`）
- 不接任何调用方
- 单测：dispatch smoke 4 case
- ~300 行新代码

### PR-C: declarative probes（html / no_lorem / consistent_styling）

- 新建 `general/htmlProbes.ts`：3 个 declarative probe
- 集成进 `GeneralDashboardChecker.probes`
- 单测覆盖每个 probe pass/fail case
- ~200 行新代码

### PR-D: imperative browser probes

- 新建 `general/browserProbes.ts`：`loads_no_error` / `viewport_non_blank`
- 复用 `runBrowserVisualSmoke`（PR-A 抽出的）
- 集成 + 测试（用 fixture HTML）
- **关键风险**：Playwright headless flakey；测试要有重试或 timeout 设置
- ~250 行

### PR-E: anti-Potemkin `state_change_on_click`

- 新建 `general/interactionProbes.ts`：核心交互探针
- 实现：launch browser → 找第一个 button-like → click → 等待 100ms → diff DOM
- 测试用 4 个 fixture HTML：
  - `correct.html` - button 真改 DOM
  - `potemkin-noop.html` - button 没接 event listener
  - `potemkin-broken-handler.html` - listener 抛错
  - `potemkin-css-only.html` - 只有 :hover 视觉变化但 DOM 不变
- ~350 行
- **这是最有价值的 commit**——其他 4 个都是脚手架，这个真正解决 Replit anti-Potemkin

### 可选 PR-F: 接进 toolExecutionEngine

- `gameArtifactValidator.ts` 的 `inferArtifactKind` 推断到 'interactive_app' 时，调用方（toolExecutionEngine 4 处）改成走 DashboardVerifier
- **需要 game validator 的 4 个调用点都协调**——这是最容易踩 v8 platformer 抽奖坑的部分
- 慎重，可能延后到 PR-G 或独立 PR

总计 ~1100-1300 行新代码 + ~300 行测试。比 Phase 4 PR-1+2+3 总和略小。预估 2-3 天工作量。

---

## 6. 风险与缓解

### 风险 1：Playwright headless flakey

**症状**：CI 上 browser launch 偶尔失败 / DOM 等待超时 / screenshot 抓不到。

**缓解**：
- PR-D / PR-E 测试加 `vi.retry(2)`
- timeout 默认 30s，可通过 env 调
- CI 跑 dashboard verifier 测试单独打 tag，主流水线失败不阻塞主 merge（参考 platformer 端到端的 CI 配置）

### 风险 2：抽 browser smoke 时误改 game 行为

**症状**：PR-A 完成后 platformer 测试退化，触发红线 4。

**缓解**：
- PR-A 必须跑 `npm run acceptance:platformer-gameplay-validate` 比对 baseline
- PR-A 是纯 file move + import 改 path，不改函数体
- `runBrowserVisualSmoke` 跨文件移动后用 `git diff -M50%` 检查是否被 git 识别为 rename（如果是，diff 会变小很多）

### 风险 3：anti-Potemkin probe 选 button 不准

**症状**：fixture HTML 里有多个 button，probe 选错的那个，false-positive 或 false-negative。

**缓解**：
- 第一波只选 `<button>` 和 `<a>` 两种最 canonical 的；不试 `[role=button]` 等更宽的
- probe 内部记录"试了哪个 selector"，给 debug 用
- 接受 false-positive 率 5%，纳入 PR-E 测试

### 风险 4：`state_change_on_click` DOM diff 算法

**症状**：DOM 总有副作用变化（如 `:focus` 状态、自动 scroll），probe 误判 DOM "变了"。

**缓解**：
- DOM diff 限定在 click 目标的最近兄弟/父节点子树（不全局 diff）
- 忽略 `data-*` 属性、`class` 中的 `:focus` / `:active` 衍生类
- 真要严格的话用 MutationObserver 而不是事后 diff

### 风险 5：scope 蔓延

**症状**：写着写着想改 `inferArtifactKind` 让推断更准 / 想给 game validator 减负更多。

**缓解**：
- 严格按 PR-A 到 PR-E 拆分，不跨 PR
- "顺手改"放 follow-up TODO

---

## 7. 启动 session 时的第一步

爸开新 session 后，agent 应当：

1. **先读这个文档**（路径：`docs/audits/2026-05-08-dashboard-verifier-plan.md`）
2. **再读 audit doc §4.1**（`docs/audits/2026-05-07-game-acceptance-architecture.md` § Replit Agent 3 部分）— 5 分钟，理解 anti-Potemkin 模式
3. **跑 `git log --oneline -10`** 确认 main 上 4 个 PR 已合（fb31681f / 4dc5308e / 772c7c75 / fe87e8fd）
4. **跑 `npm run acceptance:deck` + `npm run acceptance:platformer-gameplay-validate`** 确认 baseline 干净
5. **第一句开场建议**："读完 plan，确认 baseline 干净，可以开 PR-A 抽 browser smoke 模块。先 grep 全仓 `runBrowserVisualSmoke` / `BrowserVisualSmokeSummary` 调用点，列出影响面再开干。"

第一天的目标：**完成 PR-A**（refactor only，零行为变化）。这一步如果能在 1 小时内合到 main，剩下 PR-B 到 PR-E 可以稳步推进。

---

## 8. 不在本计划范围

- **DocVerifier / WorkbookVerifier**：价值低于 dashboard，先不做。如果未来真要起，单开 plan。
- **抽顶层 `ArtifactKindVerifier`**：触发条件是"3 个 verifier 跑通"。完成 dashboard 后才到 ADR 016 触发条件，**届时是 PR-G 的话题**，不在本计划范围。
- **interactive_app 的 subtype 分流**（dashboard / form-app / data-viz / etc）：MVP 只占位 'general'，先不区分。

---

## 9. 决策记录

如果实施过程中跟本 plan 决策不一致，**写新 ADR**，不要默默偏离。重大偏离的例子：
- 改用 sub-agent 模式（违反决策 4）
- 不抽 browser/visualSmoke（违反决策 1）
- 跳过 anti-Potemkin 直接做 schema-only（违反决策 5）

如果发现 audit doc §4.1 / Phase 4 ADR 016 跟实情不符，**优先信代码现状**（CLAUDE.md memory-discipline 规则）。
