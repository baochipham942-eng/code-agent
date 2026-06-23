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
  ①′ 生成模型设置 tab ....... 🟡 待 PR/合并(IA 修正:配置迁设置页+自定义视频端点配置层)
  ④ 统一偏好记忆 ............ ⚠️ 暂缓·需重写(注入地基错位)

外圈 4 项（借鉴清单余项，未排期）:
  节点连线 / freeform 图解 ... ⬜ 借鉴(是 Agent 操作画布前置)
  Agent 操作画布(人审批) ..... ⬜ 借鉴(依赖节点连线)
  region-lock 升可选硬保证 ... ⬜ 自补强
  扩图/去水印成本补全 ........ ⬜ 自补强
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

### 外圈 4 项（借鉴清单 §模块表，未排期）
- **节点连线 / freeform 图解**：画布现仅 image/video 节点，无边/连线/形状。设计要梳理用户流/IA/流程图。中-高成本。**是 Agent 操作画布的前置。**
- **Agent 操作画布（人审批）**：现设计出图 renderer 直连"不经 agent"。给 agent 画布工具（读状态/提议/应用 op），人审批后落地（守"人主导"）。高成本，依赖节点连线。
- **region-lock 升可选硬保证**：现 region-lock 是 best-effort（sharp 不可用/gate 抛错降级）。升级为可选硬保证。低-中成本。
- **扩图/去水印成本补全**：现这两路只回 `{path}` 无 costCny。补全成本透明。低成本。

## 进度日志
- 2026-06-23：Alma 借鉴分析完成 → 借鉴清单归档 → agent-team 探索三地基 → codex+skeptic 审计 → **⑤ 实现并合 main(PR #267)** → ① 另起会话推进。
- 2026-06-23：**① 自定义生图模型合 main（PR #270）**（rebase 最新 main；Phase1-4 + codex 5 修订 + 独立 skeptic 抓 1 HIGH+1 MED 全修 + 真机 HTTP-IPC + Playwright；合并时补 renderer-capability-diff 漏登记的 3 capability）。
- 2026-06-23：**①′ 生成模型设置 tab 实现完成**（IA 修正：配置迁设置页+设计页只选；自定义视频端点配置层对称 image 但出片留空待接入），待 PR/合并（分支 feat/visual-models-settings-tab）。

## 索引
- 借鉴总纲：`docs/competitive/alma-借鉴清单.md`
- 三地基计划：`docs/plans/design-{canvas-undo-redo,custom-image-model,preference-memory}.md`
