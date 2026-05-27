# WS4 — Light Memory: session 判断 + consolidation 闭环

> 分支 `feat/memory-consolidation`（off main @ 450ea106，与 Sprint1 解耦）。
> worktree `.claude/worktrees/ws4-memory`（仅软链 node_modules，纯 TS 无 Rust）。
> 守 Light Memory 文件哲学，**不引入向量库**（有意识路线决策）。

## 已完成（2 commits）

### WS4-A — session 收尾 LLM 判断（commit 4bfbd484）
- 新 `src/main/lightMemory/conversationJudge.ts`：`judgeConversation()` 用 quick model（glm-4-flash）
  判 `worth / isMeeting / title / worthKnowledge`，返回严格 JSON，`withTimeout` 包住；
  quick model 不可用/失败/解析失败 → **优雅降级**回原截断启发式（永不丢摘要）。
- `runFinalizer.ts` 的 `extractAndSaveConversationSummary` 改为调 judge：`worth=false` 直接 skip
  （过滤"hi/ok/继续"类琐碎）；`worth=true` 用 LLM title（meeting 加 `[会议]` 前缀）+ worthKnowledge
  作 highlights，仍走原 `appendConversationSummary`（零新增存储）。保持 fire-and-forget 不阻塞收尾。
- 常量基座 `src/shared/constants/memory.ts`（`LIGHT_MEMORY` / `SESSION_JUDGE` / `MEMORY_CONSOLIDATION`），
  并把 indexLoader/lightMemoryIpc 里硬编码的 `200` 行预算收口到 `LIGHT_MEMORY.INDEX_MAX_LINES`。

### WS4-B — consolidation cron 闭环（commit 528bb399）
- 新 `src/main/lightMemory/consolidation.ts`：`consolidateLightMemory({ dryRun, force })`
  - **gate**：读 `getLightMemoryHealth()`，仅 INDEX 超预算 / 有重复 name|description / 文件数≥阈值(40) 才动 LLM；健康则 skip（零 token）。
  - **压缩**：`listMemoryFiles()` → quick model "compress WITHOUT losing information" → merge 计划。
  - **信息无损 guard**：只有"被某个 merge 吸收为 source"的文件可被删除；**孤立 delete 一律拒绝**（裸 delete 是信息丢失向量，见验证）。外加净删除上限闸（>max(3, 50%) 不应用）。
  - **落盘**：`writeLightMemoryFile`(合并产物) + `deleteMemoryFile`(source) + `rebuildLightMemoryIndex()`（INDEX 确定性重建，靠减文件数回到预算，不 LLM 改 INDEX）。
  - dry-run 只产 plan + before/after diff，不写盘。
- 新 cron action type `memory-consolidation`（`shared/contract/cron.ts` + cronService `normalizeAction`/`executeAction`），
  走 CronService（panel 可见 + 执行历史 + retry），用 quick model，不起完整 agent 会话。
- `initBackgroundServices.ts` 按 `JOB_TAG` 幂等注册内置周任务（`0 0 4 * * 1`），**默认 dry-run**（`MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT=true`）。

## 验证证据（隔离临时 HOME，绝不碰真实 memory）
- 真实代码路径跑通：`HOME=临时` + zhipu key → quickModel 经 bigmodel.cn 返回。
- 造冗余文件对（6 条可审计独立事实）：
  - dry-run：`before 2 → after 1`，merge 产物**6 条事实一条不少**，不落盘（文件仍 2 原件）。
  - apply：只剩 `merged-*.md` + 重建的 `INDEX.md`，source 已删，fact 审计全 ✓。
  - guard：模型曾回"裸 delete deploy-notes.md（声称被 merged-… 覆盖，但无对应 merge）"——若应用会丢 DMG/代理事实，**被 guard 拦下**，这是修 guard 的直接动机。
- 真实 `~/.code-agent/memory/` 只读 gate 判定：11 文件 / INDEX 93 行 / 无重复 → **gate 不触发**（保守，不会擅自动隐私文件）。

## 待办（交接）
1. **flip 真写**：dry-run 输出经 owner 签字后，把 `MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT` 改 `false`（已注册的内置 job 用了 dryRun 字段，改常量对**新注册**生效；已存在的 job 需删旧 tag 重注册或 IPC 更新 action）。
2. （可选）设置面板加"立即整理"按钮：调 `consolidateLightMemory({ force: true })`（force 已实现，IPC 未接）。
3. quick model 质量观察：glm-4-flash 合并质量在 dry-run telemetry 里看；不够则评估换 compact 模型（成本权衡）。

## 护栏遵守
worktree 绝对路径全程；未碰 WS1 文件（model/adapters、providers、inference.ts，只 import quickModel）；
每功能点 typecheck 绿 + 显式 pathspec 提交；未 push / 未 merge；无硬编码（全走 constants）；未上向量库。
