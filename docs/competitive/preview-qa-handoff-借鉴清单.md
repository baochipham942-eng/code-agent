# Preview QA + Work→Design→Code Handoff 借鉴清单

> 来源：对艾克斯《Trae Design Mode 长期计划》中两条最高赌注方向做竞品价值验证
> 调研方式：6 路并行子 agent（4 路竞品去魅 + 用户声音，2 路 Neo as-built 核查）+ 主控亲自 grep 双核 + 多模对抗评审
> 生成日期：2026-06-26
> 我方产品：Agent Neo（cowork 人机协作产品，对标 Manus；设计画布是产物 surface 之一，仓库代号 code-agent）

---

## 一句话结论

两条方向的**价值都被竞品反向验证成立**，但成立方式相反：

- **Preview QA（视觉自动 QA）= 确凿的公开缺口**。v0/Bolt/Lovable 的自愈闭环全部止步于「代码层错误」（build/console/terminal），**没有一家做「渲染出来布局坏了→自动检测→自愈」的视觉层**。第三方实测：AI 生成应用平均 ~160 个问题、40-50% 是布局问题、空白/错误态「几乎从不生成」。这不是「追平别人」，是「填一个全行业空白」。
- **Work→Design→Code Handoff = 结构性空位，但差异化叙事必须收窄**。Figma/Anima/Locofy/Builder/v0 全部受限于「消费静态设计文件快照」，**没有一家捕获「协作过程意图」（选中变体/验收标准/锁定区）并传给自有 code agent**。但**别用「同时碰设计和代码两端」这种宽口径**——Builder.io Fusion 会被当反例打脸。真正的空白精确到一条链：**协作过程意图 → 自有 code agent**。

---

## Preview QA：竞品交叉验证

### 竞品自愈深度对照（去魅后）

| 产品 | 自动检测 | 纠错深度 | 视觉/布局层 QA | 判定 |
|---|---|---|---|---|
| Vercel v0 | 流式实时检测 | build + runtime/semantic（专训 auto-fixer 模型，称 93% error-free） | **无**（仅 links/ids inspector，DOM 层非布局） | 代码纠错 shipped 最深；视觉 QA = noop |
| Bolt.new | 终端错误自动检测（2025-01 shipped） | build/terminal 为主 | **无**（官方承认白屏 runtime「检测不到」） | 终端纠错 shipped 但浅；视觉 QA = noop |
| Lovable | 「Try to Fix」按钮（人点触发） | 扫 log + console/build error | **无**（官方明确让用户自己截图给 Edit 工具） | 半自动浅纠错；视觉 QA = noop |

**第三方系统测评（最硬证据）**：OverlayQA 测 Bolt/Lovable/Figma Make，平均每 app ~160 问题，40-50% 是布局问题；空白/错误态 AI builder「almost never generate」。根因原话：*"models are trained on code that compiles and renders, not code that passes a structured design review"*。`https://overlayqa.com/blog/ai-app-builders-visual-bugs/`

**用户声音（需求信号）**：
- v0：「preview 完美，部署即白屏」`community.vercel.com/t/deployed-site-is-completely-diff/16587`
- Bolt：「同一个错反复修反复修不好」`reddit.com/r/boltnewbuilders/comments/1h44h3b`
- Lovable：「Try to Fix 试两次不行就别试，得自己去查它不知道的信息」`reddit.com/r/lovable/comments/1m1h1lq`

### agent「看屏自纠」能力现状（去魅）：computer-use 仍演示级

- Anthropic computer-use：OSWorld 14.9%（2024）→ 61.4%（Sonnet 4.5, 2025-10），人类 72.4%。改个行距要 12 分钟；flipbook 性质**会漏短暂弹窗/toast**（恰是 QA 要抓的）；下拉框/滚动条弱。
- OpenAI Operator：独立产品 2025-08-31 关停并入 ChatGPT Agent；OSWorld 38.1%。
- Devin：有 screenshot-action 验证闭环，但自曝「模型倾向用 JS 假装点击而非真点 UI」「截图时机错过 toast」，靠人给判据兜底。

**总判断**：**别让模型「看坐标点屏幕」（演示级，押了翻车），让它「看截图下判断」、点击交给确定性引擎（Playwright selector）**。这一档是「半成熟可落地、需兜底」。成熟生产路线是 Applitools/Percy/Chromatic 式「确定性截图 diff + AI 降误报」，不是 computer-use。

### Neo as-built（主控亲自 grep 坐实）

| 块 | 现状 | 文件锚点 |
|---|---|---|
| Headless 截图 + 多模型视觉分析 | ✅ 产品运行时 | `src/main/tools/vision/screenshot.ts`、`visionAnalysisService.ts`、`BrowserTool.ts` |
| render→检测→repairSpec→agent 修复**闭环** | ✅ 但**仅游戏 canvas** | `src/main/agent/runtime/browser/visualSmoke.ts`（检测逻辑全绑 `<canvas>`/playfield，非通用）、`gameArtifactValidator.ts`、`artifactRepairGuard.ts` |
| 设计预览的健康检测 | ❌ **缺口** | `WorkspacePreviewPanel.tsx` 纯展示，无空白/溢出/缺主元素检测 |

> **as-built 铁律核查**：`visualSmoke.ts` 我逐行看过，检测项是 "constrain the canvas to viewport / fit the playfield"，绑死游戏 canvas，**不是**通用 HTML 布局检测器。"设计系统无 QA 闭环" 这个缺口判断成立（非子 agent 误判）。

### Preview QA 借鉴动作

| # | 借鉴动作 | 目标文件 | 改造成本 | 优先级 |
|---|---|---|---|---|
| PQ-1 | 把游戏的 visualSmoke 模式泛化成**通用设计预览 health check**（空白态/主元素缺失/文本溢出/按钮不可见），复用现有 headless+vision 基建 | 新建 `src/main/agent/runtime/browser/designPreviewSmoke.ts`（对标 visualSmoke）；接 `visionAnalysisService` | **中**（基建全在，是泛化不是新建） | **✅ P0 第一档** |
| PQ-2 | 检测结果走现成 repairSpec 注入回 agent | 复用 `artifactRepairGuard`/`artifactRepairSpec` 链路，扩 design artifact 类型 | **低-中** | ✅ P0 |
| PQ-3 | 「看截图下判断」而非「坐标点屏」——交互 QA 用 Playwright selector 驱动 + vision 判定屏，**不押 computer-use 坐标点击** | `BrowserTool`/`ComputerTool` 编排约束 | **低**（纪律约束，非新功能） | ✅ P0 原则 |
| PQ-4 | 自动点击关键流程 / 移动端截图 / 检测遮挡弹窗 | 同上扩展 | **高**（且 vision 判定需兜底：失败重试 + 截图时机控制，防 Devin 自曝的「假装点过」） | 🟡 P2-P3 |

---

## Work→Design→Code Handoff：竞品交叉验证

### 竞品「握两端」三层拆解

| 工具 | 握设计协作面 | 握代码迭代 | 捕获过程意图（变体/锁定区/验收标准） | 保真天花板 |
|---|---|---|---|---|
| Anima | 静态读取 | ✗ | ✗ | 65-70%，需大量手改 |
| Locofy | 静态读取 + 用户打标注（半个意图层） | ✗（转交 Cursor/Claude） | 仅组件类型/prop，无变体/锁定/验收 | 75-80%（最佳），打标 30-60min |
| Builder.io Fusion | 静态读取 | **✓ 映射真实 codebase 组件** | ✗ 无任何过程意图入口 | 70-75%，最强工程化 |
| v0 | ✗（Figma 外部、常导入失败） | **✓ conversational code agent** | ✗ | Figma 路径弱附属、demo 级 |
| Figma Dev Mode / Code Connect | 设计源 | 组件身份映射（人工建+人工养） | ✗（annotation 是自由文本非结构化验收） | GA 但映射维护是核心负担 |
| Figma Make | 设计源 + AI 重生成 | 每次重新猜意图 | ✗ | GA 但实测早期、「改 radio 直接换成 select」 |

**保真度的三层物理瓶颈**（行业共识，非某家 bug）：
1. 范式不匹配：Figma 自由画布 vs 代码精确盒模型 → 绝对定位必出 div soup。
2. 元数据两难：要保真就得补结构化元数据，补了又拖垮设计体验。
3. 有损往返：每次 design↔code 往返丢信息，「business logic, state, API calls disappear」，要反复 re-inference。

**用户声音**：「Anima/Locofy 静态 UI 能到 60-70%，一遇响应式/动态数据/干净 React 就崩」`reddit.com/r/FigmaDesign/comments/1s0tyb5`；「No tool produces production-ready code; expect 20-40% refinement」（多篇横评一致）。

### 差异化判断验证：成立，但**必须收窄措辞**

- ✅ **没有任何竞品**同时握住「设计协作过程意图 + 自有 code agent」这条链。四者输入端无一例外是**静态 Figma 文件/截图**，官方文档全部确认无 acceptance criteria / locked regions / variant selection 通道。
- ⚠️ **两个部分反例必须诚实承认**：① Locofy 的 tagging 是唯一「在静态设计上叠加用户结构化意图」的机制（但是导出器内注解，无变体/锁定/验收语义）；② Builder.io Fusion 是唯一「同时接 Figma + 真实 codebase」（但握的是代码组件资产，不是协作过程意图）。
- **结论**：差异化叙事**精确表述为**「捕获设计协作过程的结构化意图（选中变体 + 验收标准 + 锁定区）→ 作为结构化 handoff 传给自有 code agent」。**别说「没人同时碰设计和代码」**（Builder/Fusion 反例）。

### Neo as-built（主控亲自 grep 坐实）

| 需要的块 | 现状 | 文件锚点 |
|---|---|---|
| 变体选择（chosen 标记） | ✅ 能产生 + 能进 design-agent 快照 | `designCanvasStore.ts`、`buildCanvasSnapshot.ts`、`canvasProposal.ts` |
| 跨工作区传给 code agent | ❌ **被 guard 挡死** | `src/renderer/hooks/agent/useAgentIPC.ts:78` — `if (workspaceMode !== 'design') return context;` |
| 验收标准 acceptance criteria | ❌ **全仓 0 命中** | （grep 坐实，概念都无；只有 `requirement`/`designBrief` 文本） |
| 区域锁约束 | ⚠️ 有但是**图像编辑内部用** | `imageConsistency.ts` 是 inpaint 像素一致性，**与 handoff 无关** |
| 品牌契约 brandTheme | ✅ 但只注入 PPT/设计 prompt | `brandTheme.ts`、`brandRegistry.ts` — code agent 无法消费 |
| design→code 桥 | ❌ **完全无** | grep `designToCode`/`DesignHandoff` 全空；两工作区 `workspaceModeStore` 切换、数据隔离 |
| canvas op 元信息 | ❌ 纯 structural | `proposeCanvasOps.schema.ts` 仅 batch 级 `rationale`，无 per-op intent/source |

> **as-built 铁律核查**：`useAgentIPC.ts:78` 的 guard、`acceptanceCriteria` 全仓 0、`DesignHandoff` 全空，三项均主控亲自 grep 坐实。结论：Neo「同时握设计面+代码 agent」为真（同一应用），但当前是**平行隔离两个工作区，零 handoff 数据流**——差异化是「结构性可能」，不是「已实现优势」。

### Handoff 借鉴动作

| # | 借鉴动作 | 目标文件 | 改造成本 | 优先级 |
|---|---|---|---|---|
| HO-1 | 定义 **DesignHandoff 数据模型**（selectedVariantId + acceptanceCriteria + lockedRegions + brandRefs + previewSnapshots） | 新建 `src/shared/contract/designHandoff.ts` | **中** | 🟡 P2（战略奖品，需 ADR） |
| HO-2 | 打通**设计→code agent 数据流**：拆掉/旁路 `useAgentIPC.ts:78` 的 design-only guard，让 code 模式能消费 handoff context | `useAgentIPC.ts`、`buildWorkbenchTurnSystemContext` | **中-高**（动 ADR-026 隔离假设，需谨慎） | 🟡 P2 |
| HO-3 | canvas op 加 per-op intent/source 元信息 | `proposeCanvasOps.schema.ts` | **低-中** | ✅ P0（独立有用，给 ghost preview 解释力） |
| HO-4 | 把现有 brandTheme + 区域锁概念**升级为 handoff 约束**（不是图像内部，而是交接给实现的约束） | `brandContract.ts` + 新 handoff 字段 | **中** | 🟡 P2 |

---

## PM 三档分类（经多模对抗评审，见末尾修订）

- **✅ 第一档·立刻做（P0，高 ROI + 地基已具备 + 风险低）**：
  - **PQ-1/PQ-2 设计预览 health check**——填全行业公开缺口，且是把游戏 visualSmoke 闭环泛化到设计（基建全在）。这是两条方向里**性价比最高、最该先做**的。
  - PQ-3「看截图判断、点击交给确定性引擎」原则——零成本纪律，立刻立。
  - HO-3 canvas op 元信息——独立有用，给审阅体验加解释力。
- **🟡 第二档·待讨论（需 ADR / 押注型）**：
  - **HO-1/HO-2/HO-4 结构化 handoff**——战略奖品，Neo 结构独占，但要动 ADR-026 的「设计/代码工作区隔离」假设，需立 ADR 拍板。保真天花板风险真实（全行业 65-80% + 20-40% 手改），验收必须拿**含绝对定位/复杂交互**的真实设计端到端测，别只测 auto-layout 干净 landing（那是所有工具的甜区）。
- **❌ 第三档·缓**：
  - PQ-4 computer-use 自动点击 QA——2026 仍演示级，押了翻车，等坐标点击能力成熟或仅在确定性 selector 兜底下做。

---

## 反面教材（明确不学）

- **别抄 computer-use 坐标点击做 QA**：OSWorld 61%、单任务 12 分钟、漏 toast、下拉滚动条弱。Operator 半年关停证明押单一不成熟能力会被官方推翻。
- **别用「同时碰设计和代码两端」做差异化口径**：Builder.io Fusion 反例。收窄到「协作过程意图 → 自有 code agent」。
- **别把 handoff 验收测在甜区**：所有工具都能过 auto-layout 干净 landing；要测绝对定位 + 动态数据 + 交互状态。

---

## 阶段 5 · 多模对抗评审修订（艾克斯 + Claude skeptic 双核）

两位独立 context 评审者**强收敛**到同一修正，主控亲自 grep 坐实两条新证据后采纳：

### 修订 1（最重要·经二次纠偏）：design→code 桥不是伪需求，「把 code 当交付物给开发者」才是

阶段 5 评审一度把 design→code 整条判成 Trae-继承的伪需求。**复盘后这是过头了**——评审把两种本质不同的 design→code 混成一件：

| | A 模型（伪需求） | B 模型（Neo 产物轴） |
|---|---|---|
| code 是什么 | **交付物**：一坨 React 源码，给开发者读/改/接进仓库 | **隐形底座**：用户永不看代码，产物是「一个真能用的东西」 |
| 谁补那 20-40% 保真 gap | **用户**自己手改 → 非程序员 = 0 可用 | **agent**用 Preview QA 自闭合 → 用户全程不碰代码 |
| 谁判成功 | 代码质量 | 跑起来的产物 |
| 像谁 | Figma/Anima/Locofy/Trae handoff = IDE 叙事 | Manus = cowork 产物轴 |

- **结论**：Neo 作为 cowork 产物为主轴的产品，design→code 的目的天然是 **B（实现：把选中设计+约束变成真能用的产物）**，不是 A。一个 cowork 产品相对纯设计工具的全部意义，就在于产物不是静态 mockup 而是真能用的东西。`DesignOutputType` 里 `prototype` 已是可交付 HTML 网页——B 模型是把这条推到"含真实表单/数据/交互的功能产物"。
- **真正要守的是一条设计原则（区分 A/B 的唯一标准）**：
  > **code 永远隐形；agent 用 Preview QA 自闭合保真 gap；用户只判跑起来的产物。** 谁消费 handoff = agent 自己（不是用户）；谁补保真 = agent（不是用户）。守住=产物轴；一旦给用户看 React diff / 拿"代码质量"当成功指标 / 把"导出源码给开发者"做成主路径 / 让用户去修那 20-40%——就漂成 A，就真成 IDE 了。
- **②(实现) 依赖 ①(Preview QA)，是一条链不该拆**：没有 Preview QA，design→code 产出坏页面非程序员修不了 → 退化成 Anima 式"给你 70% 你自己补"；有 Preview QA，agent 渲染→检测→修复直到产物真能用。这正是 Neo「同时握设计面 + 代码 agent + 视觉 QA」三件套的结构性优势，Anima 只有导出、v0 只有 code agent、没人三件齐。
- **档位（B 模型下依然成立）**：
  - **HO-1（acceptanceCriteria）/ HO-4（约束/品牌契约）升档 → P0.5**：在 B 模型里它们是**喂给 agent 让它收敛**的结构化意图（不是给开发者看的规格），核心价值「别把我确认过的东西改坏」，服务所有产物。
  - **HO-2（打通 design→agent 数据流）→ P2**：走 B 模型、守隐形原则、与 Preview QA 链路化；机制是加独立 `withHandoffContext()` 注入（见修订 2），**不是**拆 guard、**不是**给开发者交源码。

### 修订 2（Claude skeptic·坐实）：我给 ADR-026 安了个不存在的风险

- 清单原写 HO-2「动 ADR-026 的设计/代码工作区隔离假设、需谨慎、中-高成本」。**实地核 `useAgentIPC.ts:73-78` 注释 = 「ADR-026 D1-B…避免无谓 prompt 膨胀」**——它是 prompt 膨胀优化，gate 的是 canvasSnapshot，**ADR-026 全篇无「工作区数据隔离」决策**（其不变量是 Main 永不 mutate 画布 / Agent 只提议 / 历史顺序 / 付费前置）。
- **修订**：HO-2 技术风险**被高估**（ADR-026 隔离假设是虚构的），战略风险**被漏掉**（Trae-DNA 伪需求）。真要做也**不该拆这条 guard**，而是加一条独立 `withHandoffContext()` 注入，与 canvasSnapshot 井水不犯河水。

### 修订 3（Claude skeptic·坐实）：PQ-2 撞一条带血的故意豁免，成本严重低估

- 清单原写 PQ-2「复用 artifactRepairGuard 扩 design 类型，成本低-中」。**实地核 `artifactRepairGuard.ts:7-10,139-141`**：现有代码用 `isDesignDraftWorkingDir` **故意把设计会话整条踢出 artifact repair**，因为 2026-06-25 dogfood 实测 repair 状态持久化进 DB 后**跨会话死锁拦截所有 Write**（CSDN 链接触发无限死锁）。
- **修订**：PQ-2 **不是 additive 扩枚举，是要反转一条血教训**。须单独立项，在设计里显式回答「如何不重蹈该死锁」，**不能挂 artifactRepairGuard 顺手扩**。成本由「低-中」上调，且**依赖 PQ-1 先把误报率打稳**（健康检查不准时自动 repair 会「越修越偏」黑箱）——PQ-1、PQ-2 不该同档，PQ-1 先行。

### 修订 4（Claude skeptic·坐实，对 PQ-1 反而利好）：基建比清单说的更现成

- 实地核 `visualSmoke.ts`：扫描骨架本身**通用**（`horizontalOverflow = scrollWidth > viewport.width` 文档级溢出、`visibleElements` 通用计数、`canvasCount===0 && bodyTextLength===0` 已有一条**通用空白页分支**、console/page error 通用捕获）；真正绑 canvas 的只是**告警阈值**。
- **修订**：PQ-1「基建全在」比原文更成立。真实成本驱动从「搭 headless 基建」（已有）**改写为「新增设计缺陷启发式 + vision prompt 调参防误报」**——后者才是新活。方向不变，仍 P0 第一档。

### 修订后净排序（替代正文三档）

| 序 | 事项 | 档位 | 关键约束 |
|---|---|---|---|
| 1 | **Artifact QA**（PQ-1 泛化：产物能否被非程序员交付/展示/复用，不止「设计预览」） | **P0** | 贵在启发式+vision 调参，非基建 |
| 2 | **Acceptance / Constraint Contract**（HO-1+HO-4：验收标准+锁定+品牌，服务所有产物，「别改坏我确认的」） | **P0.5** | 这是 HO 的真内核，非 design→code |
| 3 | canvas op per-op intent（HO-3） | P1 | 依赖 #2 的 contract schema 才有承接，原 P0 偏高 |
| 4 | Artifact 自动 repair（PQ-2） | P1-P2 | **先解 `isDesignDraftWorkingDir` 豁免 + Bug B 死锁**，依赖 #1 误报率 |
| 5 | design→code 桥（HO-2，**B 模型**：产物实现/code 隐形） | P2 | 守隐形原则 + 与 Preview QA 链路化；机制=加独立注入非拆 guard；**避免漂成 A 模型**（给开发者交源码） |
| 6 | computer-use 坐标点击 QA（PQ-4） | 缓 | 2026 仍演示级，且 Neo 自己产物有 DOM 不需要（见下「QA 分层性价比」） |

**一句话**：两条方向里，**Preview QA 改造成 Artifact QA 是真 P0**（填全行业空白 + 基建现成）；**design→code 桥不是伪需求，但只能走 B 模型**（code 隐形、agent 用 Preview QA 自闭合保真、用户判跑起来的产物）——它和 Preview QA 是一条链，守住隐形原则就是产物轴，漂向"给开发者交源码"才是被 Trae 带偏成 IDE。

---

## QA 分层性价比（PQ 落地口径）

结论先行：**截图 QA 是性价比最高的一条，但它本身要分两层，贵的层只在便宜的层够不着时才上。** 排序：

> 确定性截图检测（免费，抓缺口大头）＞ vision 判截图（只判主观视觉）＞ selector+vision 交互 QA（贵，功能产物才上）＞ computer-use 坐标点击（缓）

**为什么截图 QA 最值**：被验证缺口的大头是**静态可见**的——OverlayQA 实测 ~160 问题/app、40-50% 是布局问题（溢出/错位/断点崩/响应式坏）、空白/错误态"几乎从不生成"，**这些一张截图就看得出，不用点任何东西**。坐标点击那套（慢/贵/61%/漏 toast）是为了够"点了才知道"的少数问题，却把成本和风险拉满，本末倒置。

**截图 QA 的两层（省钱纪律）**：

| 层 | 抓什么 | 成本 | 可靠性 | Neo 现成件 |
|---|---|---|---|---|
| **A·确定性检测**（无 LLM） | 空白(`bodyText===0`)、溢出(`scrollWidth>viewport`)、console error、断图(`naturalWidth=0`)、主元素缺失、多视口抓响应式断裂 | 近乎零 | 100% 确定 | `visualSmoke.ts` 扫描骨架本就通用，松绑即用 |
| **B·vision 判截图** | 规则编码不出来的：排版美感、层级乱、遮挡、品牌不一致、"看着没做完" | 一次 vision 调用 | 概率性，需校准防误报 | `visionAnalysisService` |

铁律：**客观/二值的全压 A 层免费抓，只有主观视觉质量才花 vision token 给 B 层**。用 vision 判"是不是空白"是浪费（一行规则免费抓）；"排版丑/层级乱"写不成规则，才上 vision。各干各擅长的。

**为什么 computer-use 坐标点击缓（精确对象）**：缓的不是"agent 看渲染屏"（那是 P0），是**靠看屏幕坐标自主点击**这层实现。五条理由——① 61% 可靠性当不了 QA 裁判（点失败分不清"页面坏"还是"它没点对"，是假信号）；② 改个行距 12 分钟 + 每步喂大图，规模化不了；③ flipbook 性质漏短暂 toast/弹窗/表单态闪现，正砸 QA 命门；④ 模型"用 JS 假装点过"，给你虚假的绿比没 QA 更危险；⑤ Operator 半年关停，押单一不稳能力会被推翻。**而且 Neo 自己产的网页产物 DOM 全在手上，交互 QA 用 selector 驱动 + vision 判结果屏就够，根本不需要坐标点击**——坐标点击只在"拿不到 DOM"（canvas app/原生界面/不控的第三方流）才被迫上，那些场景它又演示级。两头不讨好，才缓。

**截图 QA 的天花板（诚实）**：判不了"能不能用"（按钮点了真提交吗/多步流程断没断）。静态产物（海报/信息图/slides/mockup）→ 截图 QA 就是全部 QA；功能产物（可交互原型/web app）→ 截图 QA 覆盖"长得对不对"，"跑得对不对"留给 selector+vision 交互 QA（更贵、放后面、功能产物才上）。

**对标含义**：先做 A+B 两层截图 QA，就已超过 v0/Bolt/Lovable 那条"只接 build/console error、视觉层全空"的纠错线，且成本更低——因为大头用免费的确定性规则，不是模型。

### 评审者端点说明
- 艾克斯（codex exec）：正常返回，主攻战略向「伪需求 + 依赖陷阱」。
- Claude skeptic（独立 context + 实地 grep）：核穿 4 锚点真伪 + 挖出 `isDesignDraftWorkingDir` 反向决策。
- 两条新证据（豁免 + guard 注释）主控亲自 grep 二次坐实后才落。

---

## 真模型 in-app browser dogfood 验收（2026-06-26，主控独立核过）

艾克斯实现 feat/design-qa-handoff（8 commit），先 dry-run 6 阶段（确定性层 0 处 LLM/vision 层只收 4 类主观项/repair 另起 designPreviewRepair 不碰 isDesignDraftWorkingDir 死锁豁免/HO-2 走独立 withHandoffContext 不拆 guard/ADR-028 守隐形原则/66 单测绿 + typecheck EXIT=0），再补一次**真模型 + 产品内浏览器**端到端，补上 dry-run 被 mock 的两块（Phase 6 code agent + Phase 2 vision）：

- **真 code agent 生成**：webServer `/api/run` 真 AgentLoop，code model = MiniMax-M2.7，主生成 11 call + repair 4 call，估算 ¥1.26（token 估算非 MiniMax 真账单，价表无 M2.7）。
- **真 vision 判图**：provider = mimo-v2-omni 真单次调用，无 fallback，findings 空无误报，配额内 ¥0。
- **真 repair**：MiniMax-M2.7 对真生成的硬设计（含绝对定位 + 真交互）真修一次 → 主控核 diff 实锤修了 3 处：菜单 class mismatch（`menu--open`→`profile-menu--open`，菜单打不开）+ 2 个外链断图 picsum→内联 SVG，**精确命中 pre-repair 的「2 断图 + 1 菜单不可见」**。post-repair 确定性 findingCount=0。
- **真交互**：桌面表单 selector 提交成功 toast 出现、桌面+移动菜单 selector 点击可见。
- **主控独立核验**：生成/repaired HTML 真存在且 diff 自洽；worktree 干净未误 commit dogfood 产物；8 commit 未推；webServer 已停（8220/8180/3000 零监听）。

**一条 as-built nuance（艾克斯诚实标，需知道）**：本次 in-app browser QA 路径是为 dogfood 手工拼的——BrowserTool 拒 `file://` 故走 webServer `/api/workspace/file` 打开 artifact，且只复用了 `runArtifactPreviewHealth` 的 evaluator，render/diagnostics 采样来自 BrowserTool；产品默认 QA 路径仍是自起 Chrome。两条路 evaluator 同源、render 来源不同。**「in-app browser 真路径可行」已证，但它还不是产品接线好的默认路径**——若要统一走 in-app browser 是个小 follow-up。

**结论**：整条链（handoff→真 code agent 生成→in-app browser render→确定性+真 vision QA→真 repair→重验→真交互验收）闭环，达可合并质量。

---

## 源索引

- 竞品去魅：OverlayQA 视觉 bug 测评、Fireworks v0 技术博客、Bolt support 文档、Lovable docs、Figma dev-mode/Code Connect/Make GA 博文、LogRocket Figma Make 实测、Anthropic computer-use news、OSWorld-Human 论文(arXiv 2506.16042)、Builder.io Visual Copilot 博客、dev.to 30 天横评
- 用户声音：r/boltnewbuilders、r/lovable、r/FigmaDesign、r/UXDesign、r/Frontend、community.vercel.com
- Neo as-built 对照文件：见上各表锚点，主控亲自 grep 坐实四个缺口
- 背景：`docs/plans/2026-06-26-trae-design-mode-long-term-plan.md`（艾克斯长期计划，已交叉审计）
