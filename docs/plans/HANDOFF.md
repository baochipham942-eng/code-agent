# 交接 — 设计 Surface 会话化二期（2b 已落地，2a/2c/渲染统一 待续）

> 给接手会话的自包含上下文。日期 2026-06-25。分支 `feat/design-media-agent-paths`（worktree `code-agent-mediapath`），基于 `feat/design-conversational-surface`（PR #282 未合，是地基）。

## 定位锚点
Agent Neo = cowork 人机协作产品（产物为主轴、对标 Manus），不是 AI 编程助手品类；"code-agent" 只是仓库代号，用户默认非程序员。设计画布只是产物 surface 之一。

## 先读
- 记忆 `project_neo_design_conversational_surface.md`（2b 全过程 + 二期拍板 + 坑）
- `docs/plans/design-surface-conversational-redesign.md` §9（二期设计 4 岔路结论）
- `docs/plans/design-surface-conversational-impl-phase2b.md` §7.5（2b 进度 + B/F 下放 2c）
- `docs/plans/trace-rendering-unification.md`（执行轨迹渲染统一 spec，P0-P3）
- `docs/plans/design-roadmap.md` 末尾 2026-06-24/25 条目

## 已完成（2b，14 commit 本地，PR #283 旧版未含）
Slice A 会话内成本确认共享原语（`promptUserInChat`+`confirmGenerationCost` fail-closed）/ C `ProposeVideoOps`→画布视频节点（永不进 ADR-027 信封、属主闸）/ D `ProposeSlidesOps`→预览 tab（大纲免费/illustrate 付费会话确认）/ E 网页 affordance / **funnel**（设计会话停用通用 `image_generate`/`video_generate`/`image_annotate`，逼走画布工具）/ 真机 dogfood 修：视频播放（Blob URL + CSP `media-src 'self' blob: data:`）、视频封面（抽首帧 JPEG）、`Cmd+Shift+R` 解绑（曾误触重发偷花钱）、空态画布文案。对抗审计 0 HIGH/2 MED 已修。**真机验通：funnel→ProposeVideoOps→通义万相→会话区成本卡→落画布→能播放带封面；ProposeSlidesOps 真出 9 页配图 ¥0.98。**

## 待续 backlog（按优先级）
0. **先确认**：push 这 14 commit 上 PR #283（push 由林晨拍板，先问）。
1. **2a 鲁棒性（独立 PR）**
   - #3 图像 out-of-balance fallback：健康优先选型（只在已配 key 模型选默认）+ 单步兜底（分类 quota/auth/network→余额类自动换下一健康模型重试一次、非循环、真实累计成本回传）。billing 红线：最多+1 次不静默多扣。对接 `modelRouterPolicy`。
   - #4 会话草稿重复：`findReusableNewSessionDraft` 多路径竞态。**需现场 repro**（别盲改会话生命周期；让林晨复现时别刷新、opencli 抓 session 列表+currentSessionId 定位创建路径）。
   - #5 旧历史 affordance 污染迁移：`messages.content` 以 `<system-reminder kind="design-canvas-session">` 开头的剥离，复用 `migrations.ts`，幂等+事务+best-effort。先核实真实 marker + web/electron DB 落点。
2. **渲染统一（`trace-rendering-unification.md`，P0 最痛）**：P0 失败去噪（一个错误只在一处主渲染、humanize 扩展 429/401/超时/余额、error stripAnsi、API/额度错误 escalate banner、Bash 退出码标签矛盾修）→ P1 聚合一致 → P2 live-history timeline 持久化同源 → P3 MCP 健康 surface+subagent 折叠。
3. **2c 收口（2b 落地后开）**：表单退役（删 DesignWorkspace 直连）+ 布局收口（对话主轴+画布/预览 tab 列）+ god-file 拆分（DesignWorkspace 1056/DesignCanvas 1340，避开 diagram/annotation）+ 图像成本确认迁对话（Slice B：难点=会话成本原语在 main 而 ADR-027 信封态在 renderer，处理 dual-state，别复制信封态进 main）+ window.confirm 收尾（Slice F）+ 设计入口一等可发现性 + 空态画布专业化。

## 关键坑/纪律
- **dogfood bundle 铁坑**：webServer 优先 serve 云端热更新 bundle 盖本地构建。验本地必须 `CODE_AGENT_RENDERER_HOT_UPDATE=false CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE=true` + curl `/` 比对 `index-<hash>.js` + 换端口避 SW。
- **本机 node webServer 不稳**：会被 SIGKILL（~9min）、Supabase 启动慢（~2min 才 listen，且重启多次会被限流卡更久）。dogfood 服务别死磕，可在桌面 app 收尾；判断「死了」先 curl 端口。
- **视频播放**：必须 Blob URL（非 data URL，超浏览器 ~2MB 上限）+ CSP `media-src` 放行 `blob:`。
- 付费 dogfood 默认单跑一次、付费前向林晨确认具体命令。
- 工作纪律：独立 worktree、TDD、独立 context 对抗审计（codex 不稳用独立 subagent 当反方）修 HIGH/MED、CI/测试全绿不擅自合、更新 spec+roadmap、push/合并林晨拍板。
