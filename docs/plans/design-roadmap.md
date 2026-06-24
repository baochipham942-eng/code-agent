# 设计能力借鉴路线总锚（Alma 借鉴落地）

> **用途**：跨会话总进度锚。任何会话接手设计能力借鉴前先读这里，看"做到哪了、下一步是什么"，别以为做完某一项就收工。
> **来源**：竞品 Alma 借鉴分析（见 `docs/competitive/alma-借鉴清单.md`）。
> **定位铁律**：Agent Neo = cowork 人机协作产品（产物为主轴、对标 Manus），**不是编程 agent**；设计画布是其产物 surface 之一，人主导直接操作、AI 辅助。
> **最后更新**：2026-06-23

## 总路线（按依赖排序）

```
三地基（实施焦点）:
  ⑤ undo/redo ............... ✅ 已合 main (PR #267)
  ① 自定义生图模型 .......... ✅ 已合 main (PR #270)
  ①′ 生成模型设置 tab ....... ✅ 已合 main(IA 修正:配置迁设置页+自定义视频端点配置层)
  ④ 统一偏好记忆 ............ ⚠️ 暂缓·需重写(注入地基错位)

外圈 4 项（借鉴清单余项）:
  节点连线 / freeform 图解 ... 🟡 实现完成待 PR/合并(分支 feat/design-diagram-canvas)
  Agent 操作画布(人审批) ..... ✅ 一刀(只读提议)合 main #277；三刀(取舍/软删/恢复)+二刀(含付费生成)合 main #278(merge 40fe9ac31)
  region-lock 升可选硬保证 ... 🟡 实现完成待 PR/合并(分支 feat/design-region-lock-strict)
  扩图/去水印成本补全 ........ ✅ 折进节点连线刀(待同 PR 合并)
```

## 逐项状态

### ⑤ undo/redo — ✅ 已合 main（PR #267，2026-06-23）
画布编辑历史 Layer1 快照栈 + Cmd/Ctrl+Z 键盘绑定 + 生成成功后清栈。
TDD 247 单测 + skeptic 审计(2 HIGH+1 MED 全修) + Playwright 真机交互 E2E 通过。
计划：`docs/plans/design-canvas-undo-redo.md`。**暂缓子项**：Phase 5 编辑落盘存活重启（loadDoc/切 run 竞态，作单独一刀）。

### ① 自定义生图模型端点 — ✅ 已合 main（PR #270，2026-06-23）
让用户自填任意 OpenAI 兼容图像端点（yetone 推文被点赞的卖点）。第一刀只做 t2i。
计划：`docs/plans/design-custom-image-model.md`（架构=运行时叠加层）。worktree `code-agent-customimg` / 分支 `feat/design-custom-image-model`。
codex 修订 5 道坑全部落地并经实测验证：
- **参考图垫图守门**：custom 命中后参考图分支显式抛错（仅 t2i），IPC 单测覆盖。
- **付费探测护栏**：彻底**取消保存时的连通性探测**（无探测=无可反复触发的付费口），最稳解，对齐付费安全规矩。
- **SSRF**：新建 `ssrfGuard.ts` 单一真源（custom baseUrl=https 公网 / 裸下载 downloadFile=http(s) 公网 / 图片下载 isSafeImageUrl=https 公网 + redirect:manual 防跳转绕过）；守卫跑在 WHATWG URL 归一化之后，十/十六/八进制数字 IP 与 ::ffff: 映射地址均被中和（实测）。
- **静态枚举边界**：`imageEngineForModel` 对 custom/未知 id 显式抛错；三处调用点（t2i / annotEdit / slides）均「上游拦 custom」或「失败响亮」，绝不静默误路由。
- **返回契约兼容**：`listVisualImageModels` 合并 custom（provider:'custom'）仅扩 provider 取值，旧 renderer 只消费 id/label/available 自然兼容；key/baseUrl 绝不回传（实测无泄漏）。
独立 skeptic 复审（fresh context）抓 1 HIGH + 1 MED 全修（其余 4 修订 + key 处理 + 路径守卫确认无误）：
- **HIGH-1 SSRF-via-redirect**：守卫只校验初始 host，`generateImageOpenAICompat` 与 `handleDownloadFile` 两处 fetch 透明跟 3xx 跳转可绕过守卫打内网 → 均加 `redirect:manual` + 拒 3xx（与既有 downloadImageAsBase64 同源）。
- **MED-1 文件名路径穿越**：`handleDownloadFile` 的 payload.filename 未净化 → 加 `path.basename` 收窄 + 越界断言。
- **MED-2（文档）**：spec §数据流去掉已弃用的连通性探测描述。
验证：typecheck 净 + 322 media/security/ipc 测全绿（含 3 新对抗测：302 跳转被拒 + redirect:manual 实证 + 文件名 basename 落盘恒在目录内）+ 真机 webServer HTTP-IPC 集成（save/list/合并/delete/SSRF 三连拦/无 key 落盘）+ Playwright 渲染器接线（入口→弹窗→表单逐字段校验，零 console error）。

### ①′ 生成模型设置 tab — 🟡 待 PR/合并（IA 修正）
合 ① 后林晨指出 IA 错位：自定义模型的**配置/管理**被我放进了设计页，应归**设置页**——设计页只「选择」已配置模型。生视频同理（生图生视频都是当前功能，走对称方案）。
分支 `feat/visual-models-settings-tab`（基于已合 ① 的 main）。
- **新设置 tab「生成模型」**（settingsTabs `visualModels`，basics 组，model tab 旁）：生图段=内置只读+key 状态 + 自定义生图端点 CRUD（从设计页搬来，出片已通）；生视频段=内置只读 + 自定义视频端点 CRUD。
- **自定义视频端点=配置层 only**（林晨拍板）：视频无 OpenAI 兼容统一标准（DashScope/海螺各家协议异），出片协议留空待接入真实目标——只做填表/落盘/管理，**不接生成、不并入 VideoModelPicker**，UI 明示「出片能力接入中」。`customVideoModelRegistry` 与 image 对称（复用 ssrfGuard + SecureStorage `custom-video:` slot）。
- **设计页瘦身**：删自定义管理按钮+弹窗，只留 picker；`CustomImageModelManager` 退化为纯 View，容器逻辑由 `VisualModelsSettings` 的 generic `CustomEndpointManager` 接管（同一 View 驱动 image/video 两套）。
验证：typecheck 净 + 36 新单测 + 86 media/ipc 回归全绿 + 真机 HTTP-IPC（video save/list/delete/SSRF 拦/无 key 落盘/custom 不入 picker）+ Playwright（设置页 tab 真挂载，两段+出片待接入提示+表单校验）。

### ④ 统一偏好记忆 — ⚠️ 暂缓·需重写
**不能按原蓝图直接做**：实地调查证实注入地基错位——`enrichDesignBriefForPrompt` 只服务通用 chat，设计三条生成路径（原型 `buildPrototypePrompt` / 画布出图 `buildImagePrompt` / 演示稿 `resolveTheme`）**全绕过它**。须按"三条各自落点"重写注入设计，且范围缩到轻量偏好（主题/模型/风格），别假装能统一注入品牌契约。
计划：`docs/plans/design-preference-memory.md`（已含三线注入地图 + 10 条审计修订）。

### 外圈 4 项（借鉴清单 §模块表）

#### 节点连线 / freeform 图解 — 🟡 实现完成待 PR/合并
画布从"贴图墙"升级为图解/用户流 surface：节点↔节点连线（实时锚点跟随、可文字 label）+ freeform 形状
（矩形/椭圆/线/文字/便签），统一进 Cmd/Ctrl+Z 撤销栈。**Agent 操作画布的前置地基。**
计划：`docs/plans/design-node-connectors.md`。worktree `code-agent-diagram` / 分支 `feat/design-diagram-canvas`。
- **数据模型加法**（`CANVAS_DOC_VERSION` 维持 1，老档零破坏）：`designDiagramTypes.ts` connector/shape 模型 +
  归一化 + 悬空连线过滤；`designCanvasTypes` 序列化仅非空落盘。
- **纯逻辑 TDD**：`diagramReducer`（形状绘制归约器）+ `connectorGeometry`（两端中心连线与边框交点作锚点）。
- **undo 重构**为快照帧 `{nodes,connectors,shapes}`（节点 reconcile 原样保留，图解层整帧还原）；store API 不变。
- **UI**：`DiagramLayer`（渲染+选中+连接 hit-rect）+ `DiagramToolbar`（模式/调色板/删除）+ 绘制走 Stage
  处理器（能在节点之上起笔）+ 文字内联编辑 + Delete 键 + i18n(zh/en)。**配置/管理不进画布**（消费 surface 只放工具选择）。
- **skeptic 审计**（独立 context 当反方）抓 1 HIGH（redo 删除失效，base #267 埋下，加 `reconcileRedoFrame` 修正）
  + 2 MED（connect 源残留 / 文字 Enter+blur 双提交）+ 2 LOW 全修，回归测试覆盖。
- **验证**：typecheck 净 + 316 design 测全绿（67 新纯逻辑/store 测 + 5 toolbar SSR）+ renderer 真实构建过。
  **未做完整 konva 真机 E2E**（prod E2E 构建缺 dev 钩子、本机无 node-canvas/headless）——konva 渲染是声明式薄层，
  其输入（几何/归约器/store）已被纯逻辑测穷尽覆盖。

#### 扩图/去水印成本补全 — ✅ 折进节点连线刀（待同 PR 合并）
扩图/去水印是真实付费 wanx imageedit 调用，但 handler 此前只回 `{path}` 不进成本面板。补全：service 回 actualModel、
handler 回 `{path,actualModel,costCny}`、renderer `landResultAsVariant` 挂 costCny 到回灌节点（与出图/编辑对称）。

#### region-lock 升可选硬保证 — 🟡 实现完成待 PR/合并
局部重绘一致性闸原本两处静默漏洞（sharp 不可用 / 闸内部抛错 → 降级写模型原图，未选区可能被偷改而用户无感）补成**可选硬保证**。新增「严格模式」开关（设置页·生成模型 tab「图像编辑一致性」段，默认关，落 `<config>/design/design-settings.json`）：
- **关（默认）**：维持 best-effort，不阻断编辑。
- **开**：region-lock 无法强制执行时响亮失败——sharp 不可用在**付费生成前**拦截（不浪费一次付费调用）；闸内部抛错则拒绝写未保证产物（模型原图不落盘）。
- 落点：`imageConsistency.ts` 抽 `ensureRegionLockEnforceable`/`onRegionLockGateError` 两纯函数（可单测）；`designSettings.ts` 新建轻量行为偏好存储（原子写+串行锁+容损读）；`handleEditDesignImage` 付费前预检 + 闸错按严格分流；新增 `get/updateDesignSettings` IPC（shellCapabilities 注册）；`VisualModelsSettings` 新增段 + 开关 + i18n。
- 验证：TDD（designSettings 8 + 严格守卫 5 + IPC dispatch 4）+ typecheck 净 + capability-diff/scanner 门绿 + 真机 headless E2E（设置 tab 真挂载、开关 false→true 翻转、i18n 解析、控制台仅后端缺席错）+ 独立 skeptic 当反方抓 1 MED（硬编码默认值）已修。**已合 main（PR #275，merge 5912ff5f；CI 6 绿 0 红）。**

#### 仅剩一项 · Agent 操作画布（人审批） — 🟡 第一刀实现完成待 PR
**第一刀（只读提议闭环，Layer1-only 无付费）实现完成**（分支 `feat/agent-canvas-propose`，6 commit）：
- 提议引擎地基：shared 契约（自包含 op：moveNode/addConnector/addShape/renameNode + 校验，破坏性 op 不在白名单）+ 纯应用引擎 `computeProposalResult`（stale-target 防御）+ store `applyProposalBatch`（D3-B 整批=一个原子撤销单元）。
- `proposeCanvasOps` 阻塞工具（复刻 askUserQuestion 往返）+ CANVAS_PROPOSAL_ASK/RESPONSE IPC；无交互 renderer 走 fallback 不假装已应用。
- D1-B 画布快照上下文注入（design 模式发轮附带，排除 discarded + 限长截断，注入 `<design_canvas>` 块）。
- ghost 预览 UI（Konva 蓝色虚影）+ 审批条（应用/拒绝/意见）+ i18n。
- 独立 skeptic 当反方审计抓 2 HIGH（abort 泄漏 / busy 永不复位）+ 4 MED（无 op 上限/连线截断无提示/color 无上限/get-set 并发漂移）全修。
- 验证：TDD（契约 23 + 引擎 12 + store 4 + 工具 11 + 控制器 6 + 快照 11 + 注入 glue 2 + 审计回归 5 ≈ 74 新测）+ typecheck 净 + capability/ipc/shared 门绿 + 真机 headless E2E（提议→ghost→应用→连线落库+节点移动+单次 undo 撤整批，零相关错误）。
ADR：`docs/decisions/026-agent-operated-design-canvas.md`（2026-06-23 林晨拍板「按推荐全要」）。核心立场=**agent 只提议、不直接落地**，真正改 store 的永远是 renderer（守"人主导"）。四项决策：
- **D1-B 每轮注入画布快照**（renderer `store.toDoc()` 注入 agent 上下文，含限长裁剪；否决读 canvas.json 陈旧态/请求响应桥过重）。
- **D2-A askUserQuestion 式阻塞工具 + ghost 预览**（`proposeCanvasOps` 阻塞等审批 + Konva 叠层画提议虚影 + Apply/Reject）。
- **D3-B 整批=原子撤销 + 混批顺序写死**（Layer1 先于 Layer2、Layer2 后 `clearEditHistory`，防跨生成 undo 删节点）。
- **横切红线**：付费前置审批（含付费生成的提议，审批在付费前）+ MVP 只给 加/排布/连线/标注（不给删除/discard 破坏性 op）+ main 永不直接 mutate 画布。
实施切分：①只读提议闭环（Layer1-only，无付费）②含生成提议（付费前置 + Layer2 混批）③按需 per-op 取舍/破坏性 op 硬审批。

## 进度日志
- 2026-06-23：Alma 借鉴分析完成 → 借鉴清单归档 → agent-team 探索三地基 → codex+skeptic 审计 → **⑤ 实现并合 main(PR #267)** → ① 另起会话推进。
- 2026-06-23：**① 自定义生图模型合 main（PR #270）**（rebase 最新 main；Phase1-4 + codex 5 修订 + 独立 skeptic 抓 1 HIGH+1 MED 全修 + 真机 HTTP-IPC + Playwright；合并时补 renderer-capability-diff 漏登记的 3 capability）。
- 2026-06-23：**①′ 生成模型设置 tab 合 main**（IA 修正：配置迁设置页+设计页只选；自定义视频端点配置层对称 image 但出片留空待接入）。
- 2026-06-23：**节点连线 / freeform 图解实现完成**（外圈 keystone，解锁 Agent 操作画布前置）+ **扩图/去水印成本补全折进同刀**。Phase1-3 TDD（数据模型加法/形状归约器/连线几何/undo 快照重构/store/DiagramLayer+Toolbar/i18n）+ 独立 skeptic 抓 1 HIGH+2 MED+2 LOW 全修 + 316 design 测全绿 + 真实 renderer 构建。待 PR/合并（分支 `feat/design-diagram-canvas`，计划 `docs/plans/design-node-connectors.md`）。
- 2026-06-23：**region-lock 升可选硬保证合 main（PR #275，merge 5912ff5f，CI 6 绿 0 红）**（外圈自补强）。新增严格模式开关（设置页·生成模型 tab，默认关）：sharp 不可用付费前拦截 / 闸错拒写未保证产物。TDD（17 新测）+ typecheck 净 + capability 门绿 + 真机 headless E2E（开关挂载/翻转/i18n）+ 独立 skeptic 抓 1 MED（硬编码默认值）已修。
- 2026-06-23：**ADR-026 Agent 操作画布（人审批）已采纳**（外圈最后一项，林晨拍板「按推荐全要」）。三路探查（agent/tool 系统 + 主→渲染推送通道 / 画布状态模型 + 编辑历史不变量 / 现成审批原语）定地基 → D1-B 每轮注入画布快照 + D2-A askUserQuestion 式阻塞 + ghost 预览 + D3-B 整批原子撤销 + MVP 加/排布/连线/标注不给删除。待起第一刀实现（只读提议闭环，Layer1-only 无付费）。
- 2026-06-23：**ADR-026 第一刀（只读提议闭环 Layer1）实现完成**（分支 `feat/agent-canvas-propose`，6 commit）。提议引擎地基（契约+stale-target 引擎+D3-B 整批原子撤销）+ proposeCanvasOps 阻塞工具+IPC + D1-B 画布快照注入 + ghost 预览/审批 UI + i18n。独立 skeptic 抓 2 HIGH+4 MED 全修。~74 新测 + typecheck 净 + capability/ipc/shared 门绿 + 真机 E2E（提议→应用→单次 undo 撤整批，零相关错误）。**已合 main（PR #277，merge f686c4b2，CI 6 绿）**。
- 2026-06-23：**ADR-026 三刀（per-op 取舍 + discardNode 软删 + 恢复入口）实现完成**（分支 `feat/agent-canvas-cut3`，2 commit）。审批条逐 op 勾选取舍；契约加 discardNode（白名单内，硬删 deleteNode 仍挡外）走 store.discardNode 软删（Layer2 非破坏不进 Cmd+Z，与人类淘汰一致）；新建 restoreNode + 「已淘汰 N·恢复」托盘补上画布软删本缺的找回路径（人类也受益）；controller 拆 Layer1 原子批与 discard。独立 skeptic 抓 2 HIGH（重复 nodeId 多计/勾选不随新提议重置）+1 MED（整槽淘汰恢复留无主版槽）+1 LOW（取消勾选不回报）全修。~16 新测 + typecheck 净 + capability 门绿 + 真机 E2E（取消勾选连线→只应用移动+淘汰、淘汰红 ghost、恢复找回，零相关错误）。待 PR。
- 2026-06-23：**ADR-026 二刀（含付费生成提议）实现完成**（同分支 `feat/agent-canvas-cut3`，1 feat + 3 audit-fix commit）。林晨拍板「按推荐全要」后写 ADR 增补（增补-D1 异步 applyProposalBatch 双相 / 增补-D2 Layer2 混批顺序写死 / 增补-D3 付费前置审批）→ 实现：契约加 `generateImage` op + normalizer + schema；控制器双相化（Phase A Layer1 同步快照 → discard → Phase B 串行付费出图 → 条件 clearHistory，全失败保 Layer1 undo，回灌真实合计花费）；出图核 `designProposedImageGen`（复用 generateDesignImage IPC，红线② model 白名单回退表单默认，红线③ 落位 renderer 定）；审批面板付费闸（每张+合计预估 ¥，仅算勾选项）；阻塞超时按生成数抬升。**独立反方对抗审计 4 轮收敛**（Codex exec 截断 fallback Gemini/antigravity；R1 2H/3M/1L → R2 0H/2M/1L → R3 1H/2M/1L → R4 converged）：修 3 HIGH（ensureRunDir 抛错挂死 agent / 单次 save 丢已付费产物 / 双击 Apply 双付费+useRef 重挂丢锁）+ 6 MED（孤儿提议后点 Apply 真付费→CANCEL IPC / 付费期间画布不锁→忙态遮罩绑 applying / 并发提议互相误清→clearIfStill 按 requestId / racing CANCEL 中途撤 UI）+ 3 LOW，缓办 1 MED（不回具体哪条被否，三刀既定计数口径）。根因贯穿=长时异步付费 × 同步 React 态的并发编排，R3 把锁上移 store 级按 requestId 在每个边界校验闭环。405 测绿 + typecheck 净。审计报告 `docs/audits/2026-06-23-ee7a93c44-design-cut2-paid-generation.md`。**真 key 付费 dogfood✅过**（林晨授权单跑一次，¥0.14）：webServer.cjs + POST generateDesignImage 走二刀 generateProposedImage 请求形状（prompt+model wanx-t2i+aspectRatio+outputPath 无参考图），真 wanx 返回 success/actualModel=wanx2.1-t2i-turbo/costCny=0.14，真 PNG 1024×1024 落盘；**实际成本 0.14 == 审批面板 estimateImageCostCny 预估，付费前置审批账诚实**。**待 PR**——三刀+二刀同分支一并提。
- 2026-06-24：**ADR-027 设计画布有界自主（预算信封 + 人挑收敛）实现完成**（分支 `feat/design-autonomous-canvas`，worktree `code-agent-autonomy`，10 commit）。ADR-026 的自然下一刀：把「每个出图提议都阻塞等人点头」升级为「人一次性批预算信封{maxVariants,maxCny} → AI 信封内自主出 N 个**发散变体**（不再逐张问）→ 人挑一个（人挑=唯一质量信号，绕开不靠谱 vision-critic）」。三 reframe：付费闸没破只从「逐张」上移到「信封」/ 并行在人眼里不在执行里（串行复用二刀 Phase B）/ 人挑=critic。5 D + 6 红线（破坏性 op 永远逐步 break out、视频/高价不进自主、自主只在 brief 清晰后启动、main 永不直接 mutate/付费、降级、abort 作废信封）。**6 slice TDD**：信封预算账纯逻辑 / `RequestDesignAutonomy` 阻塞审批工具 + IPC / 放行判断 `decideProposalHandling` + 预算闸 `makeBudgetedGenerate` + 自动应用 `autonomousApply` / 变体分组 + 人挑回灌（快照 `chosen` 标记 + `planUnpickedDiscards`） / 信封审批 UI + 进度/停止 + i18n + 生命周期。**独立反方对抗审计 2 轮收敛**（R1 抓 2 HIGH[¥天花板被自定义模型绕过→同源计价 est==actual / 孤儿信封无人复批付费→绑 sessionId+run 终态作废]+2 MED+2 LOW → R2 确认 R1 主路径都对 + 抓 2 新 MED[resurrection 回流→await 后重读信封 / fail-open→单价快照进信封]+1 LOW 全修；报告 `docs/audits/2026-06-24-adr027-bounded-autonomy.md`）。144 自主测 + 437 design 测全绿 + typecheck 净 + build:web 通过。**真 key 付费 dogfood✅**（林晨授权单跑一次，¥0.42）：隔离端口真烧 wanx 3 张 t2i 全 costCny=0.14，真实成本喂进预算账本——3 张吃满信封 ¥0.5 后第 4 张被预算闸硬停（**est==actual + 不超花，红线①成立**）。**已合 main（PR #281，merge `d93e26f93`，2026-06-24）**。
- 2026-06-24：**设计 Surface 会话化改造启动**（分支 `feat/design-conversational-surface`，worktree `code-agent-convsurface`，基线 `d93e26f93` 含 ADR-026+027）。命题=设计 surface 退回「填表→点生成」与 Neo cowork agent 定位打架，竞品 Lovart/OpenDesign 均「常驻对话+画布」。**挖出触发缺口物理根源**：设计模式全屏覆盖层 composer 是表单（`onGenerate` 直连出图绕开 agent loop），设计模式下压根没 agent 会话在跑——ADR-026/027 画布能力全建好却无入口。林晨拍板 5 决策（表单彻底退役/会话主轴+画布预览列/注入闸按 session 设计激活/分期/一期切会话布局托画布）。**一期（加法零回归）**：R1 注入闸按 session + R2 画布进专属 workbench tab + 聊天内「打开设计画布」入口，表单覆盖层保留（仍兜网页/演示稿/视频，二期再退役）。spec `docs/plans/design-surface-conversational-redesign.md`、计划 `design-surface-conversational-impl-phase1.md`。**✅ 实现完成（feat/design-conversational-surface，9 commit，HEAD 217e21ef2，未推未合）**：5 feat/test commit（per-session 激活标记 / 注入闸按 session / 画布进 tab / 入口+标签 / E2E）+ 4 fix commit（三轮对抗审计）。**对抗审计 3 轮收敛**（codex flaky→独立 context 反方 subagent，报告 `docs/audits/2026-06-24-217e21ef2-*.md`）：Round 1 抓 HIGH 跨会话画布**读**泄漏（全局单例画布 vs per-session 激活标记维度错配）+ 3 MED；Round 2 symmetric application 抓 HIGH 写路径缺口（proposeCanvasOps/autonomy 两条 IPC 无属主闸）+ MED claim 重置丢数据；Round 3 converged。修法=画布 store 加 `ownerSessionId`（读闸+写闸双向 fail-closed + 持久化 + 无损 claim）。typecheck 净 + 全量 design/hooks 测绿 + E2E 1/1。
- 2026-06-24：**真机 dogfood 收口（一期+部分二期，HEAD c3ae5b5c4，22 commit）**。林晨真机连测挖出并修一串深层 bug + 体验问题：
  - **真付费 e2e 通过**（headless DeepSeek 调 ProposeCanvasOps→审批条→真 wanx 出图落画布，¥0.14）。
  - **3 个根因 bug**（光接线不够，dogfood 才暴露）：①画布工具 `ProposeCanvasOps`/`RequestDesignAutonomy` 注册了但**不在 CORE/DEFERRED**→agent 调不到→注册进 DEFERRED + designCanvasActive 时提进基础表（`84cb91d6e`/`33a59076e`）②`executionIntent.designCanvasActive` 在 **web HTTP 路径**没透传到 RuntimeContext（web 不走 agentAppService，createAgentLoop 的 CLIConfig 漏接）→补全 renderer→CLIConfig→AgentLoop 链（`0f064c715`）③affordance 工具名小写错 + 加 TOOL_ALIASES。
  - **shell 硬控**：设计会话拒绝代码画图(PIL/imagemagick/pip 装图形库)重定向 ProposeCanvasOps（`a2db55b92`，gate on designCanvasActive，普通会话零影响）。
  - **意图驱动**：画布工具注册 DEFERRED + agent 首次调画布即自动认领激活（无主+当前会话）+ 自动开画布 tab，去掉「必须先手动点画布」摩擦（`33a59076e`/`d70c04e8d`）。
  - **设计模式收口**：切右上角「设计」即激活会话画布+开 tab+**不弹全屏表单**（表单降级为画布工具条按需入口，保网页/演示稿/视频）；TitleBar mount effect 兜底持久化 design 模式重开即激活（`f01400f91`/`2ea4a58ea`）。
  - **体验修**：应用按钮「生成中…」loading + 出图后 fit-to-view 居中 + 对话范式空态文案（`34f682369`）；点应用**秒关审批条**+画布忙态指示出图+失败 toast（`44997b9b4`）；**修历史会话提示词污染**=affordance 从 prepend 用户 content 改服务端按轮注入（web=systemPrompt/electron=turnSystemContext，`c3ae5b5c4`）。
  - **dogfood 大坑**：webServer 优先 serve 云端热更新 bundle(renderer-cache/active=index-v2.js) 盖住本地构建，且后台热更新不断拉回——林晨一直加载旧版导致「修了看不到」。绕法=`CODE_AGENT_RENDERER_HOT_UPDATE=false CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE=true` + 换端口(WEB_PORT=8190 避 SW scope)。
  - **待办（下一刀/二期）**：①网页/演示稿/视频补 agent 路径→表单彻底退役 ②god-file DesignWorkspace(1056)/DesignCanvas(1340) 瘦身 ③会话草稿重复(pre-existing web `findReusableNewSessionDraft`)清理 ④默认/选中图像模型 out-of-balance 时 agent 自动 fallback（智谱没余额会乱试一圈）⑤旧历史会话已污染的提示词数据迁移清理 ⑥布局 chat主轴+画布预览列 视觉打磨。
  - 待 push 更新 PR #281→实为新分支，开/更新 PR；CI 全绿不擅自合。
- 2026-06-24：**设计 Surface 会话化二期设计拍板**（spec §9 `design-surface-conversational-redesign.md`）。林晨拍板 4 岔路 + 1 追加：①拆 3 PR 先做主轴 ②文档型产物（网页/演示稿）落预览 tab、图/视频落画布节点（贴 OpenDesign）③出图失衡=健康优先选型+单步兜底（billing 红线最多+1 次/真实成本回传/不静默多扣）④表单先降级、dogfood 实证后再删 ⑤**追加：付费生成的成本确认从画布审批条/`window.confirm` 搬进会话内交互卡**（复用 `AskUserQuestion` 阻塞 round-trip，双模式已通；产物仍落画布/预览 tab、不抢焦点）。**3 PR 分期**：**2b 媒介 agent 路径（主轴，先做）**=`ProposeVideoOps`→画布节点 + `ProposeSlidesOps`→预览 tab + 网页会话化通路 + 成本确认共享原语；表单原样保留。**2a 鲁棒性**=出图健康优先+单步兜底 / 草稿去重(`findReusableNewSessionDraft`) / 历史污染 strip 迁移。**2c 收口**=表单退役 + 布局收口 + DesignWorkspace(1056)/DesignCanvas(1340) god-file 拆分 + 入口可发现性。worktree `code-agent-mediapath` 分支 `feat/design-media-agent-paths` 基于 `feat/design-conversational-surface`（#282 未合是地基）。2b 详细计划 `design-surface-conversational-impl-phase2b.md`。

## 索引
- 借鉴总纲：`docs/competitive/alma-借鉴清单.md`
- 三地基计划：`docs/plans/design-{canvas-undo-redo,custom-image-model,preference-memory}.md`
