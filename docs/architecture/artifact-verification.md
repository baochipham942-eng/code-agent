# Artifact Verification 架构

> 2026-06-01 当前口径：checker-level verifier + ArtifactIssue / EvalReplayQualityReport / Admin Review Queue

## 目标

Artifact Verification 负责回答一个更产品化的问题：生成物是否真的能交付。它不只检查“文件是否存在”，还要按 artifact 类型跑结构化验收、生成可审计证据，并把质量问题进入 release / admin review gate。

当前用户入口有两个：

| 入口 | 作用 |
|------|------|
| Workspace Preview | 预览 artifact、查看生成结果、打开相关文件 |
| Admin Review Queue | 审查高风险 `ArtifactIssue`，做 `allow_release` 或 `request_changes` 决策 |

## 数据流

```
Artifact / replay / eval evidence
  -> checker-level verifier or eval adapter
  -> ArtifactIssue + ArtifactEvidenceRef
  -> ArtifactIssueRepository
  -> AdminReviewQueueItem
  -> allow_release / request_changes
  -> EvalReplayQualityReport gate
```

## 运行时分层

| 层 | 文件 | 职责 |
|----|------|------|
| Legacy checker contract | `src/shared/contract/scenarioAcceptance.ts` | 低层验收结果结构，保留给 checker / unit tests，不作为产品级 DB/UI 数据面 |
| Legacy checker runner | `src/main/agent/runtime/acceptance/AcceptanceRunner.ts` | frontend/admin/doc/research/deploy/game 等场景的规则检查器 |
| Scenario skills | `src/main/agent/runtime/acceptance/scenarioSkills.ts` | 每类交付的检查项、修复建议和 skill 映射 |
| Product quality contract | `src/shared/contract/productClosure.ts` | `ArtifactIssue`、`ArtifactEvidenceRef`、`EvalReplayQualityReport`、`AdminReviewQueueItem` |
| Persistence | `src/main/services/core/repositories/ArtifactIssueRepository.ts` | 持久化 issue、evidence、quality report 和 admin review 决策 |
| App-host review API | `src/web/routes/adminReviewQueue.ts` | list / upsert issue / apply decision |
| Eval adapter | `src/main/evaluation/experimentAdapter.ts` | replay-backed case 转成 quality report，并把 artifact issues 绑到 `UnifiedTraceIdentity` |

## Verifier Family

| Artifact kind | Verifier | 检查方式 | 说明 |
|------|----------|----------|------|
| game | `gameArtifactValidator.ts` + `runtime/game/*` | subtype checker + runtime evidence + repair codes | Platformer / Runner / Breakout 通过 registry 扩展；game skill loader 只按 subtype 暴露规则 |
| deck | `runtime/deck/DeckVerifier.ts` | schema probe + declarative / imperative narrative probes | 替代旧 `validateNarrative`，并接入 `pptGenerate` |
| dashboard / interactive app | `runtime/dashboard/*` + `GeneralDashboardChecker` | HTML probes + browser visual smoke + interaction probes | `state_change_on_click` 用来拦截只长得像可交互的假 dashboard |
| browser visual smoke | `runtime/browser/visualSmoke.ts` | desktop/mobile viewport、console/page errors、canvas 非空、overflow | 供 dashboard 和 game 共享真实浏览器证据 |

## Repair Guard

通用 repair toolkit 位于 `src/main/agent/runtime/repair/`：

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

等第三类 verifier 稳定跑通后，再考虑是否抽公共接口。现在公共层只放 checker runner、artifact issue contract、quality report、admin review queue 和 repair guard。

## 存储

| 表 / 存储 | 说明 |
|------|------|
| `artifact_issues` | 产品级质量问题，含 severity/status/source/trace identity/admin review |
| `artifact_issue_evidence` | issue 证据引用，指向 replay、文件、telemetry、manual feedback 等来源 |
| `eval_replay_quality_reports` | replay/eval 的产品级质量报告与 release gate 状态 |
| artifact files / preview metadata | 生成物和 UI preview item 的事实来源 |
| telemetry / replay | 审查过程与工具证据的复盘来源 |

## 边界

- `AcceptanceRunner` 仍是 checker-level 工具，不再承担产品级 review queue / release gate 数据面。
- 新的 release gate 只看 `ArtifactIssue` 和 `EvalReplayQualityReport`，旧 `ScenarioAcceptanceResult` 要先转换成 issue/evidence 才能进入 admin review。
- Workspace Preview 负责查看 artifact，不再假设有 DeliveryReviewService / PreviewFeedbackService 这条已下线链路。
