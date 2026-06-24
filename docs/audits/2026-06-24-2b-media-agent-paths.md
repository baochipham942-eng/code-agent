# 对抗审计 — 二期 2b 媒介 agent 路径（Slices A/C/D/E）

> 独立 context 反方 subagent（codex flaky 改用 subagent 当红队），范围 `b7f3ff476..HEAD`。
> 日期 2026-06-24。结论：**0 HIGH / 2 MED / 3 LOW**；核心不变量全部成立。

## 已核实成立的关键不变量
- **成本 fail-closed**：`confirmGenerationCost` 在 no-renderer / timeout / aborted / cancel / 任何非精确 label 答案下返回 false，绝不花钱（`确认 ¥X` vs `取消` 无字符串碰撞）。出钱只发生在确认 true 之后。
- **视频永不自主**：`useCanvasVideoRequest` 从不查 ADR-027 信封；独立 `CANVAS_VIDEO_ASK` 通道 + main 侧无条件先确认成本。无路由进自主。
- **属主闸对称**：`useCanvasVideoRequest` 闸与 `useCanvasProposalReview` 逐行一致，跨会话视频落地被 reject。
- **演示稿 estimate==actual**：估价与出图同走确定性 `buildSlidesOutline` + `selectIllustrationTargets`；单图失败不计费，actual ≤ estimate。
- **无双扣**：每次确认调用只生成一次；迟到/陈旧 IPC 响应是 no-op。
- **无路径穿越**：slides 路径强制落 Downloads（分隔符剥离）；renderer `openPreview` 只收 main 生成的路径。
- **无重复 ipcMain.handle**：USER_QUESTION_RESPONSE 仅 userQuestionPrompt 注册；CANVAS_VIDEO_RESPONSE 仅 proposeVideoOps；各 once-guard。

## MED（已处理）
- **M2 [已修] `WORKSPACE_OPEN_PREVIEW` 会话闸 fail-open**：`currentSessionId` 为 null 时背景会话产物仍开，抢前台焦点。修：抽纯函数 `shouldOpenPreview` fail-closed（带 sessionId 必须精确等于当前会话，current 为空也不开），加 4 单测锁定。影响有界（仅开 agent 生成的 Downloads 文件，非任意文件）。
- **M1 [文档化，2b 不可触发]** 演示稿配图若图像服务兜底换到更贵模型 → 实际超过已确认成本。当前图像服务**无 fallback**，actualModel===imageModel，estimate==actual，2b 不可触发。已在 `proposeSlidesOps.ts` 加成本不变量注释：2a 引入图像 fallback 后须保证实际不超已确认信封，否则二次确认，不得静默超额。

## LOW（接受/记录）
- **L1** AskUserQuestion delegate 新增 mid-wait abort 提前返回（原仅入口查一次）——是改进非回归；happy/no-renderer 输出 1:1，timeout 文案一致。
- **L2** 表单出视频 runDir 解析失败的错误文案由 `t.design.errResolveDir` 变为硬编码 `'无法解析设计目录'`（zh 默认正常，en 不翻译）。罕见路径，记录待后续 i18n（共享 gen 函数返码化）。
- **L3** abort listener 成功路径未显式 remove（`{once:true}` + 绑定本次 signal，无累积，post-settle no-op）。可加 finally 清理，非必需。
