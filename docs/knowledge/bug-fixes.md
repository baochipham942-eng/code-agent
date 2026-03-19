# Bug 修复记录与模式

## v32 修复清单 (2026-02-13)

| 修复项 | 文件 | 验证 |
|--------|------|------|
| force-execute 参数验证 | detector.ts | C05: 0→20, C08: 0→20 ✅ |
| bash stderr 可见性 | bash.ts | C07: 6→15 ✅ |
| Ran: 正则尾部括号清理 | detector.ts | C07 产出 xlsx ✅ |
| CLI 模式跳过 dynamicDescription | dynamicDescription.ts | ✅ |
| maxTokens 全模型适配 (15文件) | constants.ts + 8 providers + 6 config | ✅ |
| 工具描述优化 (10工具) | read.ts, readXlsx.ts, bash.ts, write.ts, edit.ts, glob.ts, grep.ts, listDirectory.ts, webFetch.ts, webSearch.ts | C06: 0→18 ✅ |
| eval 脚本 case 过滤 | run_eval_round.sh | ✅ |

## v32 工程修复 + 工具描述优化 (2026-02-13)

- 4 个 bug fix: force-execute验证, stderr, Ran:正则, CLI dynamicDescription
- 1 个系统重构: maxTokens 全模型适配 (15文件)
- 10 个工具描述优化 (Claude Code 风格)
- R22=164, R23=154
- C04 R23=0 待分析（日志在 results/eval-r23/case04_response.txt）
- 关键文件: detector.ts, bash.ts, constants.ts, 10个工具文件

## Session 11 修复 (2026-03-08): Edit 失败高频 + TodoWrite 残留 + token 双计数

- Edit 报错根因：Observation Masking 抹掉 Read 结果 → 模型凭记忆构造 old_text → 匹配失败
- 修复1: tokenOptimizer.observationMask() — 检测 `\d+→` 行号格式，Read 结果用专属 placeholder `[File content cleared - use Read tool to re-read this file before editing it]`，对齐 CC 的 compact-file-reference 策略
- 修复2: contextHealthService.calculateToolResultsTokens() — 移除 toolResults 数组双计数，只计 message.content，token 估算恢复正确（之前翻倍导致 30% 用量触发 60% 阈值）
- 修复3: agentLoop.buildModelMessages() — 过滤历史 assistant 消息中的废弃 tool_call（REMOVED_TOOLS Set），不送给模型，TodoWrite 幽灵调用消除
- 修复4: orchestrator.ts — 移除 prompt 中的 TodoWrite 条目
- 修复5: edit.ts — 错误提示改为 "use Read tool to re-read the file, then retry"
- UI: ChatView ThinkingIndicator 增加 ctx% 显示，颜色跟随阈值（≥60% 琥珀，≥85% 红）
- commit: 0efc21d，已推送 main
- 关键文件: tokenOptimizer.ts, contextHealthService.ts, agentLoop.ts, orchestrator.ts, edit.ts, ChatView.tsx, constants.ts

## Session 20 修复 (2026-03-19): Deep Research 触发失败 + 引擎效率

### 错误模式: 默认值语义歧义

**问题**: `taskType` 默认值 `'code'` 身兼两义 — 既是"确认为编程任务"，也是"什么都没匹配到"。agentOrchestrator 排除列表 `['code', 'data', 'ppt', 'image', 'video']` 包含 `'code'`，导致所有未被正则捕获的 prompt 跳过 LLM 意图分类 fallback，Deep Research 引擎成了死代码。

**根因链路**: 用户输入"请深入研究…" → 正则缺"深入研究" → taskType 保持默认 `'code'` → `'code'` 在排除列表 → 跳过 LLM 分类 → 走 normalMode

**修复**: 默认值 `'code'` → `'unknown'`（表示"正则未命中"），新增编程任务显式正则

**泛化规则**: 当一个变量既作为"默认/未知状态"又作为"有效业务值"时，必须拆分为两个明确的语义（`'unknown'` vs `'code'`）。条件分支中的排除列表要考虑默认值是否会被误排除。

### 错误模式: 中文 \b 边界

**问题**: 正则 `\b(实现|重构)\b` 无法匹配中文上下文中的"帮我实现"，因为 `\b` 只对 ASCII 单词边界有效。

**修复**: 中文关键词不用 `\b`，英文关键词保留 `\b`，拆为两条正则

**泛化规则**: 中英文混合正则必须分开处理边界匹配

### Deep Research 引擎效率

**问题**: 搜索效率低下（17 次搜索含大量重复查询），content extraction 浪费主模型 fallback 链

**修复**: 6 项优化（query 去重、域名黑名单、并行化、阈值调整、URL 排序、quickModel 提取）

**效果**: tool 调用 -72%，耗时 -30%，输出 +132%
