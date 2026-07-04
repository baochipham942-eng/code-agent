# Artifact Verification 架构

> 2026-07-04 当前口径：Game / Deck / Dashboard verifier + ArtifactIssue / EvalReplayQualityReport / Admin Review Queue + 评测侧 artifact_runnable 断言家族；旧 AcceptanceRunner / Delivery Review / Preview Feedback 已下线

## 目标

Artifact Verification 负责回答一个更产品化的问题：生成物是否真的能交付。当前系统不再维护旧的通用 Delivery Review 队列，验收能力优先落在具体 artifact runtime 上，用真实文件、浏览器 smoke 或运行时 contract 采证，再把产品级质量问题进入 release / admin review gate。

当前用户入口：

| 入口 | 作用 |
|------|------|
| Workspace Preview | 预览 artifact、查看 Design PPT / Prompt Apps / Gallery 等生成物资产 |
| TaskPanel task rail | 展示任务运行状态、产物和当前修复动作 |
| Admin Review Queue | 审查高风险 `ArtifactIssue`，做 `allow_release` 或 `request_changes` 决策 |

## 已下线的旧链路

5/7 曾接入过 `WorkspacePreviewItem -> DeliveryReviewService -> AcceptanceRunner -> ReviewQueueService(reason=delivery_review) -> PreviewFeedbackService`。这条线在 5/19 随 evaluation 子系统清理下线，相关 IPC、DB 表、Eval Center UI、Preview Feedback UI 都已删除。

旧 `AcceptanceRunner` 只做静态规则检查，缺少真实浏览器/运行时证据、自动修复和复验闭环，因此不再保留为 runtime 入口。

当前产品级质量链路：

```
Artifact / replay / eval evidence
  -> kind-specific verifier or eval adapter
  -> ArtifactIssue + ArtifactEvidenceRef
  -> ArtifactIssueRepository
  -> AdminReviewQueueItem
  -> allow_release / request_changes
  -> EvalReplayQualityReport gate
```

## 运行时分层

| 层 | 文件 | 职责 |
|----|------|------|
| Product quality contract | `src/shared/contract/productClosure.ts` | `ArtifactIssue`、`ArtifactEvidenceRef`、`EvalReplayQualityReport`、`AdminReviewQueueItem` |
| Persistence | `src/host/services/core/repositories/ArtifactIssueRepository.ts` | 持久化 issue、evidence、quality report 和 admin review 决策 |
| App-host review API | `src/web/routes/adminReviewQueue.ts` | list / upsert issue / apply decision |
| Eval adapter | `src/host/evaluation/experimentAdapter.ts` | replay-backed case 转成 quality report，并把 artifact issues 绑到 `UnifiedTraceIdentity` |
| Game verifier | `src/host/agent/runtime/game/*` | generated game subtype checker、runtime evidence 和 repair issue codes |
| Deck verifier | `src/host/agent/runtime/deck/DeckVerifier.ts` | deck schema / narrative probes |
| Dashboard verifier | `src/host/agent/runtime/dashboard/DashboardVerifier.ts` | HTML probes、browser visual smoke、interaction probes |
| Browser visual smoke | `src/host/agent/runtime/browser/visualSmoke.ts` | desktop/mobile viewport、console/page errors、canvas 非空、overflow |
| Repair guard | `src/host/agent/runtime/repair/*` | repair scope、monotonicity、prompt limit 和修复轮次限制 |

## Verifier Family

| Artifact kind | Verifier | 检查方式 | 说明 |
|------|----------|----------|------|
| game | `gameArtifactValidator.ts` + `runtime/game/*` | subtype checker + runtime evidence + repair codes | Platformer / Runner / Breakout 通过 registry 扩展；game skill loader 只按 subtype 暴露规则 |
| deck | `runtime/deck/DeckVerifier.ts` | schema probe + declarative / imperative narrative probes | 替代旧 `validateNarrative`，并接入 `pptGenerate` |
| dashboard / interactive app | `runtime/dashboard/*` + `GeneralDashboardChecker` | HTML probes + browser visual smoke + interaction probes | `state_change_on_click` 用来拦截只长得像可交互的假 dashboard |
| browser visual smoke | `runtime/browser/visualSmoke.ts` | desktop/mobile viewport、console/page errors、canvas 非空、overflow | 供 dashboard 和 game 共享真实浏览器证据 |

## 评测侧：artifact_runnable 断言家族

产品运行时验证器同样服务批量评测（"验收通过 ≠ 可玩"的接口层补齐）：`src/host/testing/artifactRunnableAdapter.ts` 把验证器包成无 IPC、无 App 运行时依赖的纯函数，供 `assertionEngine` 的 P1 expectations 调用，全部落 `deterministic_assertion` 桶。

| ExpectationType | 包装的验证器 | 判定口径 |
|------|----------|----------|
| `game_smoke` | `runLightPlayabilitySmoke`（默认 light）/ `runRuntimeSmoke`（`contract: full`） | light=启动+首帧+无未捕获异常+canvas 非全程空白；full=goal 验收级机制证据契约（对非 goal 产物几乎必红，仅回归标本类 case 显式选用） |
| `html_renders` | `runSelfStartedArtifactPreviewHealth`（自启动 Chrome 路径，绕开 in-app 路由） | 仅 `page_error` / `console_error` / `blank_body_text` 硬信号判 not_runnable；布局质量 finding（`missing_main_element` 等）记 informational——canvas 游戏没有 `<main>`，照搬整体 passed 会误杀全部游戏产物 |
| `pptx_opens` | jszip 最小解包校验 | zip 容器 + `[Content_Types].xml` + `ppt/presentation.xml` + ≥1 slide；无浏览器依赖 |

case 参数：`path`（相对 eval workingDirectory）、`expected_verdict`（默认 `runnable`；回归标本 pin `not_runnable`，即"探测器必须抓红"= case 绿，探测能力退化时 case 转红）、`timeout_ms`、`contract`（仅 game_smoke）。参数校验 fail-loud：拼错的 `expected_verdict`/`contract`、漏写 `path`、非法 `timeout_ms` 一律显式 fail，不做静默 fallback（防回归标本因配置笔误失效）。

环境与缺失语义：浏览器/Playwright（或 jszip）不可用时 adapter 返回 `skipped`，断言**显式 fail** 并注明环境原因——不假绿、不进 `infra_excluded` 桶（分母口径不动）。产物文件缺失返回独立的 `file_missing` verdict，永远 fail、不匹配任何 `expected_verdict` 极性（文件缺失 ≠ 探测器抓红）。断言 evidence 携带环境指纹（平台/node/浏览器 provider），headless 平台差异先按 mac 本机口径。

回归锚点套件：`.claude/test-cases/artifact-runnable/`（GAIA 式外部套件，loader 不递归、默认能力套件不含它），fixtures 为 2026-07-03 dogfood 实锤的真实坏游戏标本两具 + 已知好产物 + pptxgenjs 真实 deck。运行：`npm run eval -- --scope smoke --case-dir .claude/test-cases/artifact-runnable`。

## Repair Guard

通用 repair toolkit 位于 `src/host/agent/runtime/repair/`：

| 模块 | 作用 |
|------|------|
| `scopeGuards.ts` | 避免 repair LLM 改无关代码 |
| `platformerScopeGuards.ts` | platformer-specific guard 自注册 |
| `monotonicityTracker.ts` | 跟踪 patch 是否单调变好 |
| repair constants / prompt limits | 限制 repair prompt 长度和最多修复轮次 |

当前 repair 策略是 Best-of-N + repair cap + monotonicity gate。超过上限后应该换策略：升模型、问用户、或退回模板，而不是继续盲修。

## ADR 边界

ADR-016 明确不提前抽 `ArtifactKindVerifier` 顶层接口。原因是各类 artifact 的输入输出形态不同：

| Kind | 输入形态 |
|------|----------|
| deck | in-memory deck artifact |
| dashboard | file path + browser runtime |
| game | generated HTML + runtime evidence + subtype checker |

等第三类 verifier 稳定跑通后，再考虑是否抽公共接口。当前公共层只保留 repair guard、真实证据采集工具、artifact issue contract、quality report 和 admin review queue，不再保留通用 Delivery Review runner。

## 存储

| 表 / 存储 | 说明 |
|------|------|
| `artifact_issues` | 产品级质量问题，含 severity/status/source/trace identity/admin review |
| `artifact_issue_evidence` | issue 证据引用，指向 replay、文件、telemetry、manual feedback 等来源 |
| `eval_replay_quality_reports` | replay/eval 的产品级质量报告与 release gate 状态 |
| artifact files / preview metadata | 生成物和 UI preview item 的事实来源 |
| telemetry / replay | 审查过程与工具证据的复盘来源 |

## 边界

- `AcceptanceRunner` / `scenarioAcceptance` 已下线，不再作为当前 artifact runtime 或产品级 review queue 数据面。
- 新的 release gate 只看 `ArtifactIssue` 和 `EvalReplayQualityReport`。
- Workspace Preview 负责查看 artifact，不再假设有 DeliveryReviewService / PreviewFeedbackService 这条已下线链路。
