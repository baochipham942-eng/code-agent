# Artifact Verification 架构

> 2026-06-01 当前口径：Game / Deck / Dashboard verifier + ArtifactIssue / EvalReplayQualityReport / Admin Review Queue；旧 AcceptanceRunner / Delivery Review / Preview Feedback 已下线

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
