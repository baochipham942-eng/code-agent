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
