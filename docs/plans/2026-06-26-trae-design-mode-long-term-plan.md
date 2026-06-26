# Trae Design Mode 调研到 Neo 长期计划

日期：2026-06-26  
状态：研究收口，进入长期路线规划  
范围：Trae Design Mode 本地包分析、公开信息搜索、Neo 当前 Design Mode 架构对照、后续产品和工程路线

> ## ⚠️ 交叉审计修正（2026-06-26 补，优先于下文旧框架）
>
> 本计划两条最高赌注方向（Preview QA、Work→Design→Code）已做竞品价值验证 + 多模对抗评审，结论见
> [`docs/competitive/preview-qa-handoff-借鉴清单.md`](../competitive/preview-qa-handoff-借鉴清单.md)（**该文为最新口径，与下文冲突时以它为准**）。四条关键修正：
>
> 1. **Preview QA 是真 P0，但要改造成「Artifact QA」并走截图分层**：性价比排序 = 确定性截图检测（免费，抓被验证缺口大头：空白/溢出/响应式断/缺主元素）＞ vision 判截图（只判主观视觉）＞ selector+vision 交互 QA（贵，功能产物才上）＞ **computer-use 坐标点击（缓）**。`browser-use`/`computer-use` 那条**别做成坐标点击 QA**——2026 仍演示级（OSWorld 61%、漏 toast、12 分钟/任务），且 Neo 自己产物有 DOM，交互 QA 用 selector 驱动即可，不需要坐标点击。
> 2. **design→code 不是伪需求，但只能走 B 模型**：区分 A（code 当交付物给开发者=IDE 叙事=伪需求）vs B（code 隐形底座、agent 用 Preview QA 自闭合保真、用户只判跑起来的产物=Neo 产物轴）。守**隐形原则**：谁消费 handoff=agent，谁补 20-40% 保真 gap=agent，不是用户。一旦给用户看 React diff / 拿代码质量当指标 / 导出源码给开发者，就漂成 A、就成 IDE 了。
> 3. **②实现依赖①Preview QA，是一条链不该拆**：没有 Preview QA，design→code 产坏页面非程序员修不了 → 退化成 Anima 式"给你 70% 自己补"。Neo「设计面+code agent+视觉 QA」三件齐是相对 Anima/v0 的结构性优势。
> 4. **handoff 的真内核不是 design→code 桥，是「Acceptance/Constraint Contract」（P0.5）**：验收标准+锁定区+品牌契约，在 B 模型里是**喂 agent 收敛**的结构化意图（非给开发者的规格），服务所有产物，核心价值「别把我确认过的改坏」。两条 as-built 纠错：ADR-026 **无**工作区隔离不变量（`useAgentIPC.ts:78` 只是 prompt 膨胀优化），HO 不该拆它而该加独立注入；PQ-2 复用 `artifactRepairGuard` 会撞 `isDesignDraftWorkingDir` 故意豁免（2026-06-25 死锁血教训），须单独立项。

## 结论

Trae 的 Design Mode 值得借鉴，但不值得继续把时间押在登录和地区绕过上。国际版 `TRAE SOLO.app` 的本地包里已经包含完整 Design Mode/Work 相关运行时代码，国内版 Trae CN 只有一部分共享字符串和组件痕迹，没有完整运行时。当前卡住的是服务端地区或账号策略，不是本机配置能稳定解决的问题。

对 Neo 来说，关键不是复制 Trae 的实现，而是把已经有的设计画布、参考图、变体历史、自动化提案和预览能力，升级成一条完整的 Design Agent 工作流：

1. 设计资产进入项目：Figma/MCP、截图、参考图、本地设计库都能变成可复用 Design Library。
2. 对话生成和修改设计：Design Mode 成为一等任务模式，能读项目、读画布、读设计库，再提出可审阅的设计操作。
3. Agent、Canvas、Preview 形成闭环：Agent 提案，Canvas ghost preview，用户确认，Preview 自动检查，结果进入历史。
4. Design 到 Code 有明确交接物：选中的设计变体、设计库、验收标准、截图回归和代码生成目标一起交给 Code Mode。
5. 所有过程可归档：设计来源、参考资产、生成成本、用户决策、预览结果、代码导出都能打包成 Design Archive。

这条路应该分阶段做。P0 要保证没有 Figma 也能成立；P1 再接 Figma/MCP；P2 打通 Work 到 Design 到 Code；P3 再做更强的预览 QA、自主循环和归档协作。

## 已确认事实

### 本地包证据

| 对象 | 结论 | 证据 |
| --- | --- | --- |
| `/Applications/TRAE SOLO.app` 国际版 | 包内有完整 Design Mode/Work 运行时 | `product.json` 显示 `packageType=SOLO_I18N`、`runMode=solo-lite`、`applicationName=trae-solo`；`@byted-icube/solo-lite` 约 49M，存在 `dist/index.mjs` |
| 国际版 Design 代码痕迹 | Design Mode 不是营销壳，包内有真实业务链路 | `dist/index.mjs` 中出现 `vibe-design`、`DesignCanvasPage`、`Design Library`、`design archive`、`export-to-code`、`browser-use`、`computer-use` 等关键词 |
| `/Applications/Trae CN.app` 中国版 | 没有完整 Design Mode 运行时 | `product.json` 显示 `packageType=TRAE_CN`；`@byted-icube/solo-lite` 只有 4K 左右 stub，没有 `dist` |
| 中国版共享代码 | 有设计相关共享 UI/文案痕迹 | 能看到 `DesignCanvasPage`、`Design Library`、`export-to-code`、`design archive` 等字符串，但不足以说明完整功能可用 |
| 旧 `/Applications/Trae.app` | 没看到 Design Mode 主链路 | 没有国际版里那些完整 solo-lite 运行时痕迹 |

### 登录和地区门槛

国际版已经通过干净数据目录和强制代理启动，主进程也确实带上了代理参数：

```text
/Applications/TRAE SOLO.app/Contents/MacOS/Electron
--proxy-server=socks5://127.0.0.1:7897
--proxy-bypass-list=<-loopback>
```

但仍然停在：

```text
TRAE Work Unavailable
TRAE Work is currently not available in your region.
```

同时日志里能看到服务端侧识别结果和访问状态：

```text
TncRegionMainService region-changed: {"countryCode":"us","countryCodeSrc":"did"}
getStoreRegion {"region":"USTTP"}
https://icube-boot.trae.ai/extensions/api/-/skill/list -> 403 Forbidden
```

这说明当前问题更像服务端地区、账号、产品策略或 allowlist，不像本地安装包缺功能。公开搜索也没有找到可靠的稳定解法，只看到有人遇到同样的 “TRAE Work is currently not available in your region”。

## 仍未确认的部分

因为无法进入国际版真实 Design Mode，下面这些只能按本地包证据、公开信息和产品推断处理：

1. Trae 的 Design Library 文件结构、schema、增量更新规则。
2. Design Canvas 的真实数据模型，是 DOM/iframe、画布 AST、网页项目目录，还是多层混合。
3. `browser-use`、`computer-use` 在 Design Mode 里承担的是自动预览 QA、素材采集、网页操作，还是更广义的 agent 工具。
4. `export-to-code` 的真实输出质量、技术栈、约束条件。
5. `design archive` 是否是可 replay 的完整项目包，还是只是一组导出文件。

这些问题值得未来有账号权限后补测，但不应该阻塞 Neo 的长期路线。

## Neo 当前基线

Neo 已经不是从零开始做 Design Mode。当前已有基础主要在这些文档里：

- [`docs/architecture/design-mode.md`](../architecture/design-mode.md)：顶层 Design Workspace，Web/Prototype、Image/Mockup、Slides、Video 四类媒体入口，统一历史、变体、参考图、品牌契约和导出。
- [`docs/decisions/026-agent-operated-design-canvas.md`](../decisions/026-agent-operated-design-canvas.md)：Agent 通过 renderer snapshot 理解画布，只提交结构化 canvas ops，renderer 做 ghost preview 和最终应用。
- [`docs/decisions/027-bounded-autonomy-design-canvas.md`](../decisions/027-bounded-autonomy-design-canvas.md)：有预算包络、人工预授权、变体 fan-out、人类选择作为 critic。
- [`docs/plans/design-unified-canvas-history.md`](design-unified-canvas-history.md)：参考图作为一等节点，输出节点独立，历史和画布统一。
- [`docs/competitive/opendesign-lovart-借鉴清单.md`](../competitive/opendesign-lovart-借鉴清单.md)：OpenDesign/Lovart 对照里已经沉淀了参考图、非破坏式变体、局部编辑、成本/撤销等方向。

因此后续不是“给 Neo 加一个 Design 页面”，而是把现有能力连成持续可用的设计工作流。

## 六条长期链路

### 1. Design Library：让设计资产变成项目能力

Trae 包里最值得重视的关键词是 `Design Library`。它暗示 Design Mode 不只是生成一次页面，而是会把某个 Figma 文件、网页、截图或项目风格整理成后续可复用的设计系统。

Neo 应该借鉴的不是单纯“接 Figma”，而是做一个分层 Design Library：

| 层级 | 输入 | 输出 | 是否依赖 Figma |
| --- | --- | --- | --- |
| Local Library | 截图、参考图、已有 HTML/CSS、Markdown 规范 | tokens、色彩、字体、组件描述、布局规则、参考资产索引 | 否 |
| Figma Library | Figma 文件、节点、组件、变量、样式 | 更高保真的 tokens、组件映射、设计源链接、Code Connect 映射 | 是 |
| Project Library | 当前 Neo 项目历史、用户选择、品牌 registry | 项目级设计记忆、偏好、禁止项、可复用 blocks | 否 |

P0 先做 Local/Project Library，避免没有 Figma 时 Design Mode 失效。P1 再通过 Figma MCP/API 做 Figma Library。

建议产物：

```text
.neo/design-library/
  manifest.json
  tokens.json
  components.json
  references/
  guidelines.md
  provenance.json
```

最小可用标准：

1. 用户上传参考图后，Neo 能提取并保存色彩、字体倾向、布局密度、组件风格。
2. 后续设计任务默认能引用当前项目 Design Library。
3. 用户可以要求“按这个 library 重做”“不要继承这个 library”“修复 library”。
4. Library 里所有资产有来源和时间，方便审计和回滚。

### 2. Design Agent Mode：把设计变成一等任务

Trae 公开表达是 Work Mode 到 Design Mode 到 Code Mode。国际包中 `vibe-design`、`DesignCanvasPage`、`project_name`、`auto_create_project` 这些痕迹说明它把设计作为独立模式处理。

Neo 应该把 Design Mode 的任务模型固定下来：

```text
DesignTask
  id
  projectId
  sourceMode: work | design | code | standalone
  intent: explore | refine | generate | repair | handoff
  libraryRefs[]
  canvasSnapshotRef
  previewRef
  outputTargets[]
  acceptanceCriteria[]
```

关键价值是让 Agent 每次设计动作都有上下文边界：

1. 它知道自己是在探索、细化、生成、修复还是交接。
2. 它知道当前应该读哪个 library、哪个画布快照、哪个预览。
3. 它输出的不是一段泛泛建议，而是可应用、可预览、可回滚的设计操作。

Neo 已有 `proposeCanvasOps` 和 renderer authority，这条链路应该继续沿用。Main process 只做调度和记录，不直接篡改画布。

### 3. Agent ↔ Canvas：从一次生成升级成可审阅操作

Trae Design Mode 值得借鉴的核心不是“生成漂亮图”，而是更像设计协作者。Neo 当前 ADR-026/027 已经有正确方向：

1. Renderer 提供 canvas snapshot。
2. Agent 基于 snapshot 提出 structured ops。
3. Canvas 展示 ghost preview。
4. 用户确认后才应用。
5. 所有动作进入历史，且可撤销。

长期要补的是操作颗粒度和审阅体验：

| 能力 | 当前意义 | 长期增强 |
| --- | --- | --- |
| `addNode` / `updateNode` / `removeNode` | 支持基础画布编辑 | 加入 design intent、来源、影响范围 |
| `createVariant` | 支持多方向探索 | 支持方向卡、对比维度、选择理由 |
| `applyStyleGuide` | 应用设计库 | 支持局部应用、冲突提示、回滚 |
| `repairLayout` | 修复重叠、溢出、错位 | 结合预览截图自动定位问题 |
| `lockRegion` | 保留用户指定区域 | 扩展为可继承的 edit constraints |

验收目标：

1. Agent 每次改画布前，用户能看懂它要改什么。
2. 用户能只接受一部分改动。
3. 每次改动都能解释来源：用户指令、library 规则、预览检查、代码约束。
4. 设计历史能支持“回到某个方向继续探索”。

### 4. Preview QA：让预览参与判断

国际包里出现 `browser-use`、`computer-use`，这条线非常重要。Design Mode 如果只有生成和画布，不足以形成真实生产链路。Preview 要成为验证者。

Neo 可以把 preview 分成三层：

| 层级 | 做什么 | 验收 |
| --- | --- | --- |
| Static Preview | 渲染设计结果，截图保存 | 页面不空白，主元素可见，无明显溢出 |
| Semantic Check | 检查按钮、导航、表单、关键文本 | 关键流程可点击，文案不被遮挡 |
| Visual Regression | 与参考图、上一版、选中变体比较 | 差异可解释，用户能批准或驳回 |

这条链路对 Neo 的价值很直接：

1. 减少“看起来生成了，但实际页面坏了”的情况。
2. 让 Agent 能基于真实预览修复，而不是只靠语言自评。
3. Design 到 Code 交接时，有截图和检查结果作为验收材料。

P0 可以先做基础 preview health check：

```text
render -> screenshot -> detect blank/overflow/overlap -> attach finding -> agent repair proposal
```

P2 再加入浏览器自动点击、移动端截图、关键路径录屏。

### 5. Work → Design → Code：把交接物做实

Trae 的公开叙事里，最完整的链路是 Work Mode 到 Design Mode 到 Code Mode。这个方向对 Neo 很有价值，因为 Neo 不是单独设计工具，它本来就是 agent/code/product 协作环境。

Neo 需要定义一个 Design Handoff Package：

```text
DesignHandoff
  taskId
  selectedVariantId
  designLibraryRefs[]
  previewSnapshots[]
  acceptedCanvasOps[]
  acceptanceCriteria[]
  targetStack
  generatedCodePlan
  knownRisks[]
```

交接物要解决三个问题：

1. Code Mode 为什么要这么实现。
2. 实现后怎么判断还原度足够。
3. 后续改动怎么避免破坏设计意图。

建议把 Code Mode 的输入从“请实现这个截图”升级成：

```text
请实现 selectedVariantId
使用 designLibraryRefs
满足 acceptanceCriteria
通过 previewSnapshots 对照
保持 locked regions
```

这样 Design Mode 产物才真正进入工程闭环。

### 6. Design Archive：把过程留成可复盘资产

Trae 包里出现 `design archive`，这说明它可能已经在做项目级设计归档。Neo 也应该补这个概念。

Design Archive 不只是导出图片，它应该包含：

1. 原始输入：prompt、参考图、Figma 节点、项目文件。
2. 中间过程：Agent 提案、用户批准、变体树、预算消耗。
3. 输出结果：画布 JSON、预览截图、生成代码、PPT/PDF。
4. 验证证据：预览检查、视觉 diff、人工选择理由。
5. 复现信息：模型、provider、seed、工具版本、Neo 版本。

建议结构：

```text
.neo/design-archives/
  2026-06-26-homepage-redesign/
    archive.json
    canvas.json
    library/
    previews/
    exports/
    decisions.jsonl
    costs.json
```

长期价值：

1. PM 可以复盘为什么选这个方向。
2. 设计和代码可以共享同一份证据。
3. 失败的设计探索也能成为后续参考。
4. 团队协作时不依赖某个会话还活着。

## Figma/MCP 的位置

Figma 很重要，但不能成为 Design Mode 的唯一入口。

需要 Figma/MCP 才能高质量完成的事：

1. 读取 Figma 文件、节点、组件、变量和样式。
2. 把 Figma component 映射到代码组件。
3. 做 Code Connect 或类似绑定。
4. 从真实设计系统同步 tokens 和 assets。
5. 在 Figma 文件与 Neo Design Library 之间建立双向来源关系。

不应该依赖 Figma 的事：

1. 用参考图生成页面。
2. 用截图建立项目风格。
3. 在 Neo 画布里做变体探索。
4. 预览和 QA。
5. Design 到 Code 的 handoff。
6. 设计归档。

产品原则：

```text
有 Figma 时，Design Mode 更准；
没有 Figma 时，Design Mode 仍然完整可用。
```

## 分阶段路线

### P0：不用 Figma 也能跑通的 Design Agent 闭环

目标：把 Neo 现有 Design Mode 能力整理成一条可反复使用的工作流。

范围：

1. Project Design Library v0
   - 从参考图、当前画布、用户选择中沉淀 tokens、guidelines、assets。
   - 写入 `.neo/design-library/`。
   - 在新设计任务中自动作为上下文。

2. DesignTask 模型
   - 明确 `explore/refine/generate/repair/handoff` 五类 intent。
   - 每个任务绑定 library、canvas snapshot、preview、acceptance criteria。

3. Canvas Ops 审阅增强
   - 每个 op 带 intent、source、affected nodes。
   - ghost preview 支持部分接受。
   - 用户选择写入 decisions log。

4. Preview Health Check v0
   - 自动截图。
   - 检查空白、主内容缺失、明显文本溢出、按钮不可见。
   - 问题回写给 Agent 生成修复提案。

5. Design Handoff v0
   - 支持从选中变体生成 handoff package。
   - Code Mode 能读取 selected variant、library、preview、acceptance criteria。

P0 验收：

1. 用户不连接 Figma，只用参考图和文字，也能完成一次从探索到交接的设计任务。
2. 所有设计修改都可预览、可撤销、可审计。
3. Code Mode 能拿到结构化 handoff，不再只靠截图猜。

### P1：Figma/MCP Design Library

目标：让专业设计资产进入 Neo，并且能与本地设计库共存。

范围：

1. Figma import
   - 读取文件、页面、frame、component、variables、styles。
   - 生成 FigmaLibrary snapshot。
   - 保留 Figma node URL 和版本信息。

2. Token extraction
   - 色彩、字体、spacing、radius、shadow、grid。
   - 与本地 tokens 合并，冲突时保留来源。

3. Component mapping
   - Figma component 到代码组件候选映射。
   - 支持人工确认和修正。

4. Library repair
   - 检测缺资产、坏引用、冲突 token。
   - Agent 提出修复方案。

P1 验收：

1. 能从一个 Figma 文件生成可用 Design Library。
2. 生成设计时能稳定引用 Figma 样式和组件约束。
3. 没有 Figma 权限时，已有本地 library 不受影响。

### P2：Work → Design → Code 主链路

目标：把 Design Mode 放回 Neo 的完整 agent 工作流中。

范围：

1. Work Mode 发起 Design Task
   - 从需求、PRD、聊天上下文创建 design brief。
   - 自动带入项目代码、品牌、已有页面约束。

2. Design Mode 产出可选方向
   - 多方向探索。
   - 方向卡展示差异：视觉风格、信息架构、风险、实现成本。

3. Code Mode 接收 handoff
   - 生成实现计划。
   - 绑定 acceptance criteria。
   - 实现后跑 preview regression。

4. 回流 Design Mode
   - 代码实现偏离设计时，能生成修复任务。
   - 用户可选择改代码或改设计。

P2 验收：

1. 从一个产品需求到一个可运行页面，中间有可追踪的设计决策。
2. Code Mode 实现完成后能用 Design Mode 的预览证据验收。
3. 用户能看到偏差来源：设计变了、代码没还原、还是需求改变。

### P3：更强的自动预览、归档和协作

目标：让 Design Mode 从个人工具升级成可复盘、可协作的生产链路。

范围：

1. Browser-use / computer-use preview QA
   - 自动点击关键流程。
   - 移动端和桌面端截图。
   - 检测遮挡、滚动、弹窗、表单状态。

2. Visual diff
   - 对比参考图、上一版本、目标变体。
   - 高亮差异并分类：可接受变化、布局问题、内容缺失。

3. Design Archive v1
   - 一键打包设计过程、资产、预览、成本、代码。
   - 支持重新打开、继续探索、给别人审阅。

4. Multi-agent design review
   - 一个 agent 做生成，一个 agent 做 critique，一个 agent 做实现可行性检查。
   - 人类仍然是最终选择者。

P3 验收：

1. 一次复杂设计任务完成后，可以导出可复盘 archive。
2. Preview QA 能真实发现问题，而不是只生成空泛建议。
3. 多 agent 产出的分歧能帮助用户选择方向，不制造噪音。

### P4：更远期能力

这些先不排入近期主线，但保留方向：

1. 团队共享 Design Library。
2. Design Library marketplace 或模板库。
3. Figma 双向同步。
4. 设计评审评论系统。
5. 跨项目品牌治理。
6. 从真实产品 analytics 反向驱动设计改版。

## 具体 Backlog

| 优先级 | 事项 | 目标文件/模块 | 验收 |
| --- | --- | --- | --- |
| P0 | 定义 `DesignTask` schema | Design Mode domain types | 能表达 explore/refine/generate/repair/handoff |
| P0 | 落 `.neo/design-library/manifest.json` | project persistence | 能保存 project library v0 |
| P0 | 从参考图沉淀 library notes | reference image pipeline | 新任务能引用上一轮参考风格 |
| P0 | Canvas ops 增加 source/intent/affected nodes | `proposeCanvasOps` 链路 | ghost preview 能解释每个改动 |
| P0 | decisions log | design history | 用户接受/拒绝/选择变体都有记录 |
| P0 | preview health check v0 | live preview / browser tools | 能识别空白、主元素缺失、明显溢出 |
| P0 | handoff package v0 | Design to Code bridge | Code Mode 能读 selected variant 和验收标准 |
| P1 | Figma file import | Figma MCP adapter | 能生成 FigmaLibrary snapshot |
| P1 | token conflict resolver | Design Library merge | 来源冲突可见，可人工选择 |
| P1 | component mapping draft | Code Connect / component registry | 能把 Figma component 映射到候选代码组件 |
| P2 | Work Mode 创建 DesignTask | agent router | 需求能进入 Design Mode |
| P2 | Code Mode 消费 handoff | code agent context | 实现计划引用设计证据 |
| P2 | implementation preview regression | preview QA | 代码实现后能对照设计截图 |
| P3 | Design Archive export/import | project archive | 可打包、恢复、继续探索 |
| P3 | multi-agent design review | agent team | 生成、critique、实现可行性分工明确 |

## 决策门槛

### Gate 1：Figma 是否值得做成 P1 主线

进入 P1 前要确认：

1. 用户真实任务里 Figma 输入占比足够高。
2. Figma MCP/API 能稳定拿到组件、变量和样式。
3. 本地 Design Library 已经证明有价值。

如果这些不成立，P1 应该延后，继续强化参考图、截图、代码反推 library。

### Gate 2：Design Library 是否真的提升质量

不要只看“生成更好看”。要看：

1. 是否减少重复 prompt。
2. 是否减少风格漂移。
3. 是否让 Code Mode 更容易还原。
4. 是否能跨任务复用。

### Gate 3：Preview QA 是否发现真实问题

Preview QA 不能停留在“截图成功”。要统计：

1. 发现了多少空白、遮挡、溢出、断链。
2. 修复提案有多少被用户接受。
3. 代码实现后的回归检查是否减少返工。

### Gate 4：Work → Design → Code 是否减少重写

这条链路最终价值要看：

1. 从需求到实现的来回次数是否下降。
2. 设计决策是否能被工程读懂。
3. 代码偏离设计时，定位是否更快。

## 不做的事

1. 不把 Design Mode 绑定到 Figma 登录。Figma 是增强层，不是前置条件。
2. 不让 main process 直接改画布。画布状态仍由 renderer 管。
3. 不做隐藏的付费自主循环。预算、次数、成本必须显式。
4. 不把 Trae 包当成依赖，也不依赖地区绕过。
5. 不为了追 Trae 名词重写现有 Neo Design Mode。先补链路，再考虑 UI 命名。

## 风险

| 风险 | 表现 | 缓解 |
| --- | --- | --- |
| Design Library 过早复杂化 | schema 很大，但用户感知不明显 | P0 只做 manifest/tokens/guidelines/references/provenance |
| Figma 依赖过重 | 没 token 或权限时功能瘫痪 | Figma 只做 P1 增强层 |
| Agent 改画布不可控 | 用户看不懂改了什么 | 继续坚持 ghost preview 和人工 apply |
| Preview QA 空泛 | 只输出建议，不发现真实问题 | 先做可检测问题：空白、溢出、遮挡、缺主元素 |
| Code handoff 变成文档摆设 | Code Mode 不消费结构化字段 | handoff 必须进入 code agent context |
| Archive 体积膨胀 | 图片、视频、预览堆太多 | archive manifest 做引用和裁剪策略 |

## 推荐排期

近期 2 到 3 周：

1. DesignTask schema。
2. Project Design Library v0。
3. Canvas ops source/intent 增强。
4. Preview health check v0。
5. DesignHandoff v0。

中期 1 到 2 个月：

1. Figma import spike。
2. token/component mapping。
3. Work Mode 创建 DesignTask。
4. Code Mode 消费 handoff。
5. implementation preview regression。

长期 1 个季度以上：

1. Design Archive。
2. browser-use/computer-use preview QA。
3. visual diff。
4. multi-agent design review。
5. 团队共享 design library。

## 最小可交付切片

最值得先做的切片是：

```text
参考图/当前画布
-> 生成 Project Design Library v0
-> Design Agent 创建 3 个方向
-> Canvas ghost preview
-> 用户选择一个方向
-> Preview health check
-> DesignHandoff v0
-> Code Mode 实现并对照预览
```

这个切片能证明 Trae Design Mode 最核心的价值：设计不是一次性生成结果，而是一条能被审阅、验证、交接和复盘的链路。

## 后续探索清单

未来如果重新拿到 Trae Work 可用账号，再补测这些点：

1. Design Library 文件结构和修复流程。
2. Design Canvas 的真实数据模型。
3. `browser-use`、`computer-use` 在设计链路里的调用时机。
4. `export-to-code` 输出栈和质量。
5. `design archive` 是否可恢复、可继续编辑。
6. Work Mode 到 Design Mode 到 Code Mode 的真实交接字段。

这些结果可以更新本计划，但不影响 P0 启动。
