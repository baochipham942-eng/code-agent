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
  Agent 操作画布(人审批) ..... 🟦 ADR-026 已采纳，待实现(D1-B/D2-A/D3-B,MVP 加/排布/连线/标注)
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

#### 仅剩一项 · Agent 操作画布（人审批） — 🟦 ADR-026 已采纳，待实现
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

## 索引
- 借鉴总纲：`docs/competitive/alma-借鉴清单.md`
- 三地基计划：`docs/plans/design-{canvas-undo-redo,custom-image-model,preference-memory}.md`
