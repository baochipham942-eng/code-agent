# 二期 PR 2b 实施计划 — 媒介 agent 路径 + 成本确认搬进对话

> 主轴 PR。目标：设计会话里 agent 能产出**视频/演示稿/网页**，落到对的 surface；付费生成的成本确认从画布/`window.confirm` 搬进**会话内交互卡**。**表单原样保留**（兜底，2c 再退）。
> 分支 `feat/design-media-agent-paths`（worktree `code-agent-mediapath`）基于 `feat/design-conversational-surface`（PR #282 未合，是地基）。
> 上位 spec：`design-surface-conversational-redesign.md` §9。

## 0. 前置 / 地基核实（写码前先做，不产代码）
- [ ] node_modules symlink 指向带 konva 的树（记忆：`code-agent-variant`），E2E 跑 worktree 须 `E2E_WEB_PORT` 强制新构建。
- [ ] **核实 file:line**（探子结论复核，避免照抄）：`ProposeCanvasOps`(`src/main/tools/modules/design/proposeCanvasOps.ts`) 桥接 / `videoGenerationService` / `slidesGenerator` / `AskUserQuestion`(`src/main/tools/modules/planning/askUserQuestion.ts` + `.schema.ts`) round-trip / `CanvasProposalReviewBar` 成本计算 / `useDesignCanvasGeneration.ts` 视频 `window.confirm` / `DesignCanvas.tsx` 标注 `window.confirm` / 工具注册表 `src/main/tools/modules/index.ts` CORE/DEFERRED。
- [ ] 核实真实 affordance 注入文件 `src/shared/design/canvasSessionReminder.ts` 现有引导文案（要扩展，不要新造重复）。

## 1. Slice A — 会话内成本确认共享原语（地基，三媒介共用）
**目标**：抽一个 tool 内部可调的「问用户一个选择并阻塞」服务，复用 `AskUserQuestion` 已有的 `USER_QUESTION_ASK/RESPONSE` round-trip + 对话流卡片渲染（双模式已通），不新造 UI。

- [ ] **TDD**：先写 `requestUserChoiceInChat(ctx, { title, costCny, detail, options })` 的单测——返回用户选择、超时语义、cancel 默认安全（超时/无 window = 视为取消，不花钱）。
- [ ] 实现：从 `askUserQuestion.ts` 抽出阻塞 round-trip 为可复用 service（`requestUserChoiceInChat`），`AskUserQuestion` 工具改为薄封装调它（零行为变化，回归测试守住）。
- [ ] 成本卡 helper：`confirmGenerationCost(ctx, { mediaLabel, model, qty/durationSec, estCny })` → 内部调 `requestUserChoiceInChat`，渲染「本次生成将消耗 ¥X（模型/数量/时长），是否继续？[确认 ¥X][取消]」。¥ 取自共享 `imageCost`/`videoCost`/slides 价表（禁硬编码价）。
- [ ] **验证**：单测绿；electron IPC + web SSE 两条 round-trip 各一条集成测试（确认/取消各一）。

## 2. Slice B — 图像成本确认迁进对话（改已发行为，回归守严）
**目标**：`ProposeCanvasOps` 的**花钱确认**从 `CanvasProposalReviewBar` 搬进 Slice A 的对话卡；画布保留 ghost 预览（被动视觉，不抢焦点），不再用审批条做花钱决策。

- [ ] **TDD**：proposeCanvasOps 出图前调用 `confirmGenerationCost` 一次；取消→不调生成、工具返回「用户取消」；确认→照旧生成 + 落画布。
- [ ] 改造：generateImage op 在 spend 前走对话卡；`CanvasProposalReviewBar` 降为「ghost 预览 + 非破坏 apply」，移除其成本闸语义（或整条隐藏，留 audit 定）。
- [ ] **billing 守恒**：真实 `costCny` 仍如实回传账本/审批结果（与 ADR-026 不变）。
- [ ] **验证**：design 全量测 + ProposeCanvasOps 既有测零回归；headless 走一遍（确认/取消）。

## 3. Slice C — 视频 agent 工具 `ProposeVideoOps`（→ 画布节点）
**目标**：agent 能在会话里提议出视频，落 `KonvaVideoNode`；成本确认走对话卡；**永不进 ADR-027 自主信封**。

- [ ] **TDD（schema + handler）**：入参 `{ mode:t2v|i2v, prompt?, baseImagePath?, model, durationSec }`；handler 调 `videoGenerationService`；spend 前 `confirmGenerationCost`（取消=不花钱）；返回 resultPath/actualModel/costCny/durationSec。
- [ ] 桥接：复用 ProposeCanvasOps 同款 tool→IPC→落节点（新增 video 提议 IPC 或扩 canvas 提议契约，**契约带 sessionId**）。
- [ ] **接线四件**：① 注册进 DEFERRED + designCanvasActive 提进基础表（`index.ts`）+ TOOL_ALIASES ② `executionIntent` 透传（web `agent.ts`→CLIConfig→RuntimeContext 那条单独接）③ `canvasSessionReminder` 加「要视频→ProposeVideoOps」引导 ④ 写路径过 `ownerSessionId` 属主闸 fail-closed（H2-R2 教训，跨会话 reject）。
- [ ] **硬约束测试**：autonomy 路由对 video 提议必走逐次审批、绝不进信封自动出。
- [ ] **验证**：单测 + typecheck + headless（mock 服务）落 video 节点。

## 4. Slice D — 演示稿 agent 工具 `ProposeSlidesOps`（→ 预览 tab）
**目标**：agent 能在会话里产出演示稿，落专属 workbench 预览 tab（非画布）。

- [ ] **TDD（schema + handler）**：入参 `{ topic?, slides?, slidesCount?, theme?, illustrate?, imageModel? }`；调 `slidesGenerator`（buildOutline + generateDeck）；**大纲免费**直接出，**illustrate=true 出图付费**才走 `confirmGenerationCost`；产物 pptx 路径 + 预览。
- [ ] 预览 tab：定预览形态——pptx 不能 iframe，复用记忆里的 LibreOffice 像素预览 / frontend-slides HTML 预览（impl 时二选一，倾向已有像素预览）。落专属 `WorkbenchTabId`（对齐一期 design-canvas tab 做法，非 file-backed `preview:`）。
- [ ] **接线四件**：同 Slice C（注册/意图透传/affordance/属主闸；slides 落 tab 也要按 session 隔离）。
- [ ] **验证**：单测 + headless 出大纲→出 deck→预览 tab 渲染非空。

## 5. Slice E — 网页会话化通路确认（→ 预览 tab）
**目标**：会话里说「做个落地页」，agent 写 HTML→开预览 tab，不依赖表单。离会话化最近（已 `dispatchToRun`），本 slice 验证 + 少量接线为主。

- [ ] 核实：设计会话里 agent 直接写 HTML 文件能否被现有 iframe 预览 tab 接住（不经表单 `dispatchToRun`）。
- [ ] `canvasSessionReminder` 加「要网页/落地页/原型→写 HTML 文件并开预览」引导。
- [ ] **验证**：headless 设计会话→自然语言要落地页→出 HTML→预览 tab 显示。**若发现缺口**（预览 tab 接不住自由写的 HTML），记为 slice E2 补接线。

## 6. Slice F — `window.confirm` 收尾迁移（一致性小尾巴）
- [ ] 视频/标注重绘的 `window.confirm`（`useDesignCanvasGeneration.ts` / `DesignCanvas.tsx`）：agent 发起的路径已走对话卡；**用户主动画布操作**的残留 `window.confirm` 同口径换 Slice A 卡（标注是画布用户操作，优先级低，audit 后定是否本期做或留 2c）。

## 7. 验收闸（按 spec §8 工作纪律）
- [ ] `npm run typecheck` 净 + 受影响模块 targeted 测全绿 + design/hooks 全量零回归。
- [ ] **独立 context 对抗审计**（codex 不稳就独立 subagent 当反方，见 `infra_codex_exec_cli_flakiness`）：重点查 ① 三条新写路径属主闸对称（H2-R2 教训：读写生命周期三类逐个查）② 成本卡取消路径绝不花钱 ③ 视频永不进信封 ④ web HTTP 路径意图透传不漏。修 HIGH/MED 到收敛。报告落 `docs/audits/`。
- [ ] **真付费 dogfood**（默认单跑一次、**付费前找林晨确认**）：视频 1 条 + 演示稿带图 1 套，走真 agent→对话成本卡确认→出片落画布/预览 tab。**dogfood 必带** `CODE_AGENT_RENDERER_HOT_UPDATE=false CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE=true` + 换端口避 SW + curl 比对 bundle hash（记忆铁坑）。
- [ ] 更新 spec §9 + roadmap 进度；PR 开但 CI/测试全绿前不擅自合（#282 仓库无 CI workflow，合并信号靠测试证据 + dogfood）。

## 8. 显式不做（YAGNI / 留后期）
- 表单退役、布局收口、god-file 拆分 → **2c**。
- 出图健康优先/单步兜底、草稿去重、历史污染迁移 → **2a**。
- ADR-027 自主信封覆盖视频 → 永不做（成本红线）。
- 演示稿/网页上画布（Lovart 式）→ 已拍板走预览 tab，不做。
