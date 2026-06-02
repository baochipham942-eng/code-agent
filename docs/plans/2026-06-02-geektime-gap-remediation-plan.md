# 极客时间课程差距修复计划

> 创建日期：2026-06-02
> 依据报告：[docs/research/2026-06-02-geektime-course-gap-analysis.md](../research/2026-06-02-geektime-course-gap-analysis.md)
> 状态：已确认（阶段 1-3 原案通过；阶段 4 按修正版执行——skill 自动蒸馏降级为半自动确认制）

## 阶段总览

| 阶段 | 主题 | 包含 GAP | 分支 | 状态 |
|------|------|---------|------|------|
| 一 | 拆假护栏（安全） | 002, 001, 007, 003 | `fix/geektime-gap-phase1-guardrails` | **MERGED** (PR #192, 236cd71e) |
| 二 | 上下文经济 | 008, 009, 010 | `feat/geektime-gap-phase2-context-economy` | **MERGED** (PR #194, 52aef229) |
| 三 | 质量闭环 | 006+014, 013, 004, 016, 012+015, **023(阶段二 E2E 新增)** | `feat/geektime-gap-phase3-quality-loops` | **MERGED** (PR #196, 95c9c3de) |
| 四 | 经验沉淀（修正版） | 005(仅 Failure Journal + 半自动 skill 草稿), 011, 017 | `feat/geektime-gap-phase4-experience` | **DONE**（4 commits 待 PR） |
| 出局 | — | 018(等阶段三基建), 019, 020, 021, 022 | — | WONT_DO（现阶段） |

## 排序逻辑

作者四方向（安全/上下文经济/质量/经验沉淀）+ 修复型排序：假护栏（以为有保护实际没有）风险最高且改动最小，先拆；成本回归每天都在烧钱，次之；质量闭环是结构性改进；经验沉淀是 feature 级投入，最后。

## 执行约定

1. 每阶段一个分支、一个 PR；阶段内每个 GAP 完成立即 commit（不积攒）
2. 每个功能点：修改 → `npm run typecheck` → 测试 → commit
3. 每阶段结束跑 E2E 验收（见各阶段验收标准）+ eval 对比留档
4. 不主动 push / 不开 PR，由林晨确认后操作

## 阶段一验收标准（拆假护栏）

- [ ] 红队 case：只读 skill（allowed-tools 只有 Read/Grep）在 inline 模式调用 Write/Bash 被拦截
- [ ] policy.toml 写 denied_path 后，Edit 该路径被硬拦，DecisionTrace 出现 policy_enforcer 层
- [ ] 配置文件写未知字段（如 `alowed-tools` typo），日志出现 warning
- [ ] 同一会话跑 10 轮，AI SDK 路径的 API 返回 cache_read_input_tokens > 0

## 阶段二验收标准（上下文经济）

- [x] 接入 ≥2 个 MCP server 后，系统提示词中 MCP 工具只有名字索引，schema 按需加载
  - E2E：6 个 MCP server（memory-kv/code-index/context7/firecrawl/deepwiki/exa）的名字索引被 glm-5 逐字引用；tool_schema_snapshot 仅 17 个 core 工具 schema
- [x] 工具输出超阈值时落盘到 session 临时目录，上下文只留摘要+路径，agent 可用 Read 回查
  - E2E：`seq 1 20000`（108KB）→ `~/.code-agent/tmp/<session>/tool-results/` 完整 20000 行落盘，模型逐字引用回查路径
- [x] env block 包含当前分支、最近 commit、working tree dirty 状态
  - E2E：glm-5 逐字引用分支名 / clean 状态 / 全部 5 条 commit oneline

### 阶段二 E2E 发现的额外问题

1. **compressToolResult 吞落盘提示**（已修，commit 8f175859d）：messageProcessor 压缩层 truncate 策略尾部预算 ~30 token，带长路径的落盘提示行整体被丢。修复 = 压缩前抽出提示行、压缩后拼回尾部（与反爬 hint 豁免同一模式）。
2. **system prompt budget 6000 token 太小**（未修，pre-existing）：用户记忆注入大时 deferred-tools/skills/plugins/recent-conversations 块全被静默丢弃——deferred 工具发现机制在重记忆环境下实际失效。验收时用 `CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS=16000` 绕过。**建议列为下期 GAP-023 候选。**
3. **promptRegression 测试 2 个 pre-existing 失败**（未修，main HEAD 上同样失败）：`src/main/prompts/rules/taskManagement.ts` 含 `task_create` 旧工具名 + `nudgeManager.ts` 措辞与测试期望不符。

## 阶段三验收标准（质量闭环）

- [x] Stop hook 返回 block 时 agent 继续工作（最多重试 1 次的安全阀生效）
  - E2E（webServer headless + glm-5 + 真实 project hooks）：Stop hook 首次 `block` → 日志 "Stop prevented by user hook" → agent 继续干活 → 第二次 Stop 时 `HOOK_STOP_HOOK_ACTIVE=true` → hook 放行 → `agent_complete` 正常结束。安全阀（持续 block 达上限放行）由单测覆盖
- [x] PostToolUse hook 的输出能注入下一轮上下文（写文件 → lint 失败 → agent 自动修）
  - E2E：agent 写 note.txt → PostToolUse hook 返回 CC 格式 `hookSpecificOutput.additionalContext`（"第一行必须是 E2E-FIXED"）→ agent 下一轮自动改写文件 → 最终文件第一行 = `E2E-FIXED`，闭环坐实
- [x] workflow stage 失败达到 maxRetries 后走回退路由而非死循环；circuit breaker 跳闸通知用户
  - 单测覆盖（6 个 anti-loop 测试）：默认/自定义 maxRetries 重试、onFailureRoute 回退重跑上游、总回退超限跳闸 + emit notification + 剩余阶段 skipped、无效路由降级
- [x] MiMo text-first 死循环 case 复现测试通过（不再卡死）
  - text-first 整套绕障已在 main 全删（commit 29ac3019），防回归测试 `toolArtifactValidationLifecycle.plainArtifact.test.ts` 2/2 通过
- [x] GAP-023：重记忆环境下 deferred-tools 块仍进 system prompt，被丢弃的块在 context health 可见
  - E2E（默认配置、不带 `CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS`）：glm-5 确认 `<deferred-tools>` 在 system prompt 中并逐字引用真实工具名（notebook_edit/lsp/Task/Explore），budget skip 日志为零
  - 注意：仅排序+可见化不够（这个环境 base prompt 本身 ≥6000），补了报告建议 1（budget 动态化：max(6000, 模型窗口×10%)，glm-5→12800）才达成
  - 丢弃可见化：SSE reasoning 流出现 `[runtime] 上下文预算跳过 ...` + ContextHealthState.droppedPromptBlocks 流向 UI 面板

### 阶段三 E2E 发现的额外问题

1. **contextAssembly.test.ts 整个 suite 在 main 上静默加载失败**（已修，随 GAP-023 commit）：阶段二 GAP-009 给 tokenOptimizer 加 `TOOL_RESULT_SPILL` import 后，该测试文件的 shared/constants mock 未同步 → suite 加载即失败。rtk 压缩输出把 suite 级失败掩盖成 "PASS (0)"，跑测试时需用 `rtk proxy npx vitest run` 看原始输出。
2. **4 个 pre-existing 测试文件失败**（未修，与 origin/main 基线完全一致）：runtimeAssetsManifestSigning（4）/ agentDefinition（4）/ promptRegression（2，阶段二已记录）/ toolExecutor.mcpDirect（2）。

## 阶段四验收标准（经验沉淀，修正版）

- [x] 同一错误模式出现 ≥3 次后，Light Memory 出现 failure journal 条目
  - E2E（webServer headless + glm-5）：agent 连续 Read 三个不存在的文件（路径仅数字不同）→ 三次失败被归一化为同一模式 → session 结束 learningPipeline 自动写入 `~/.code-agent/memory/failure-journal.md`（count=3）+ INDEX.md 条目 + `memory_learned` 事件出现在 run SSE 流
- [x] 下一个 session 遇到同类操作时，journal 条目被注入上下文且 agent 未重复踩坑（eval 可测）
  - E2E：新 sessionId 发起 run → 模型逐字引用 system prompt 中的 `<failure_journal>` 块（含 "Read (unknown, 3次): File not found: /tmp/gapN-missing-N.txt"），跨会话注入坐实
- [x] 重复成功模式 ≥3 次后生成 skill 草稿并弹用户确认（不自动入库）
  - E2E：agent 执行 Write→Read ×3 → session 结束草稿落 `~/.code-agent/skill-drafts/write-read-*/`（SKILL.md + draft.json，status=pending）→ `skill_draft_pending` 事件出现在 run SSE 流（renderer 确认卡片的数据源）→ skills 目录全程干净（不自动入库）
  - 确认/拒绝闭环：`skill:draft:confirm` → SKILL.md 装入 `~/.code-agent/skills/<name>/`；`skill:draft:reject` → 草稿删除 + patternKey 进 rejected ledger（不再重复打扰）
  - E2E 发现并修复接线问题：EventBus→EventBridge 桥接在 webServer 架构（所有发行版的实际架构）下不会启动，改为 ctx.onEvent → run SSE 流（与 suggestions_update/memory_learned 同通路）
- [x] 评测中心支持固定模型、变 harness 配置的对照实验
  - E2E：`POST /api/evaluation/run-harness-comparison`（固定 glm-5，2 个变体：baseline=压缩开+deferred 工具 vs 压缩关+全量工具）→ 串行各跑 bash-echo case → 2 条 experiment 记录落 DB，`config_json.harness` 携带维度（contextCompression/hooksEnabled/toolMode），实验名带变体名可跨实验对比

## 进度日志

| 日期 | 进展 |
|------|------|
| 2026-06-02 | 计划确认，阶段一开工 |
| 2026-06-02 | 阶段一完成，PR #192 |
| 2026-06-02 | 阶段二完成：GAP-008/009/010 + E2E 发现的压缩层修复，4 commits 在 `feat/geektime-gap-phase2-context-economy`（独立 worktree），E2E 验收 3/3 通过（webServer headless + glm-5 真实链路），待确认后开 PR |
| 2026-06-02 | 阶段三完成：GAP-006+014（Stop hook 安全阀 + CC 兼容 additionalContext）/ 013（交付前 critic）/ 004（workflow 反死循环）/ 016（stage outputSchema）/ 012+015（SubagentStop trace 入口 + hook 日志脱敏）/ 023（块优先级排序 + 丢弃可见化 + budget 动态化），7 commits 在 `feat/geektime-gap-phase3-quality-loops`（独立 worktree），E2E 验收 5/5 通过（webServer headless + glm-5 + 真实 hooks），待确认后开 PR |
| 2026-06-02 | 阶段三 MERGED（PR #196, 95c9c3de） |
| 2026-06-02 | 阶段四完成：GAP-005 修正版（learningPipeline 重建：failure journal 全自动 + skill 蒸馏半自动确认队列 + SkillDraftNotifications 确认 UI）/ GAP-011（SubagentConfig.skills 全文预注入，agent .md frontmatter 支持 skills 字段）/ GAP-017（HarnessVariantConfig 三维度 + runHarnessComparison + evaluation:run-harness-comparison IPC），4 commits 在 `feat/geektime-gap-phase4-experience`（独立 worktree），E2E 验收 4/4 通过（webServer headless + glm-5），E2E 额外发现并修复 EventBus→renderer 桥接在 webServer 架构下失效的接线问题，待确认后开 PR |
