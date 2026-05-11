# Artifact Verification 架构

> 2026-05-11 当前口径：AcceptanceRunner + Game / Deck / Dashboard verifier + Delivery Review + Preview Feedback

## 目标

Artifact Verification 负责回答一个更产品化的问题：生成物是否真的能交付。它不只检查“文件是否存在”，还要按 artifact 类型跑结构化验收、给出可修复反馈，并把失败项送回聊天主链路。

当前用户入口有两个：

| 入口 | 作用 |
|------|------|
| Workspace Preview | 预览 artifact、运行 Delivery Review、查看 Preview Feedback、把反馈 send back to chat |
| TaskPanel task rail | 展示验收状态、待审项、产物和当前修复动作 |

## 数据流

```
Artifact generated
  -> WorkspacePreviewItem
  -> DeliveryReviewService
  -> AcceptanceRunner / kind verifier
  -> ReviewQueueService(reason=delivery_review)
  -> PreviewFeedbackService
  -> Workspace Preview feedback sidebar
  -> send back to chat for repair
```

## 运行时分层

| 层 | 文件 | 职责 |
|----|------|------|
| Scenario acceptance | `src/shared/contract/scenarioAcceptance.ts` | 前后端共享验收 contract |
| Acceptance runner | `src/main/agent/runtime/acceptance/AcceptanceRunner.ts` | frontend/admin/doc/research/deploy/game 等交付场景的通用验收入口 |
| Scenario skills | `src/main/agent/runtime/acceptance/scenarioSkills.ts` | 每类交付的检查项、修复建议和 skill 映射 |
| Delivery review | `src/main/evaluation/deliveryReviewService.ts` | 运行审查，失败时入 review queue |
| Preview feedback | `src/main/evaluation/previewFeedbackService.ts` | 维护 UI 可操作反馈项 |
| Review queue | `src/main/evaluation/reviewQueueService.ts` | 保存 `delivery_review` reason 和结构化结果 |

## Verifier Family

| Artifact kind | Verifier | 检查方式 | 说明 |
|------|----------|----------|------|
| game | `gameArtifactValidator.ts` + `runtime/game/*` | subtype checker + runtime evidence + repair codes | Platformer / Runner / Breakout 通过 registry 扩展；game skill loader 只按 subtype 暴露规则 |
| deck | `runtime/deck/DeckVerifier.ts` | schema probe + declarative / imperative narrative probes | 替代旧 `validateNarrative`，并接入 `pptGenerate` |
| dashboard / interactive app | `runtime/dashboard/DashboardVerifier.ts` | HTML probes + browser visual smoke + interaction probes | `state_change_on_click` 用来拦截只长得像可交互的假 dashboard |
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

等第三类 verifier 稳定跑通后，再考虑是否抽公共接口。现在公共层只放 runner、feedback、review queue 和 repair guard。

## 存储

| 表 / 存储 | 说明 |
|------|------|
| `preview_feedback_items` | Workspace Preview feedback 侧栏的数据源 |
| `review_queue_items.delivery_review` | Delivery Review 未通过时进入 Review Queue |
| artifact files / preview metadata | 生成物和 UI preview item 的事实来源 |
| telemetry / replay | 审查过程与工具证据的复盘来源 |
