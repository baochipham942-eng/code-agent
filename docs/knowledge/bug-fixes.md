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

## Session 25 修复 (2026-04-25): 评测框架完整重建 + thinking-mode 协议

7 个 commit：3d81a779 → b0625519 → 54a58c5e → 82a7f461 → a7ac6f44/19fa963d → be4c32f9 → 06c8a329

起因：4-24 跑出 reread-loop-trap 76.9% partial，调查发现是**假评测**——`__dirname is not defined in ES module scope` 让 AgentLoop 启动就崩，turnCount=0、responses=[]，但弱断言（no_crash + max_tool_calls≤3，0 次工具调用自然 ≤3）伪通过。

### 错误模式: 测试框架的 multi-turn 假象

**问题**: `agentAdapter.sendMessage` 内部 `const messages = []` 是局部变量；`reset()` 是 no-op。每次 follow-up sendMessage 启动一个全新 AgentLoop，messages 数组从零开始 → 模型在 follow-up 里看到的对话历史长度是 1（只有当前 user prompt）。testRunner 的 multi-turn for loop 期望 adapter 在 sendMessage 间保持状态，但 adapter 没实现这个契约。所有 multi-turn case 实际跑成 N 个独立 single-turn。

**根因链路**: turn 2 「第 10 行什么内容？」无 conversation history → 模型没"刚才"的 Read 结果 → 凭空编造文件内容；turn 4「保险起见重新读一次完整文件」无文件名 → 模型从某个上下文捡一个文件名（实际从 `recent-conversations.md` 注入捞到了 test-chain.ts）

**修复**: messages / sessionId 提到 adapter 实例字段，sendMessage 复用 this.messages，reset() 清空（commit `3d81a779`）

**泛化规则**: 测试 adapter 跟 testRunner 之间的 multi-turn 契约要文档化。adapter `reset()` 是空 no-op + sendMessage 局部变量这种组合是 silent 违约。

### 错误模式: 跨 case 的 memory 污染

**问题**: `messageBuild.ts:117` 每次构 system prompt 都 inject `buildRecentConversationsBlock()`，读 `~/.code-agent/memory/recent-conversations.md`。前一个 case 的 user prompt 被写进去后，下一个 case 启动时 system context 里就带着上一个 case 的痕迹。reread-loop-trap 第 4 个 follow-up 没文件名时，GLM 从上下文捡了 `test-chain.ts`（来自隔壁 case `long-chain-budget-15` 的 setup）。

**修复**: 加 env var `CODE_AGENT_DISABLE_RECENT_CONVERSATIONS`，agentAdapter 在 constructor 设置；`buildRecentConversationsBlock` 和 `appendConversationSummary` 双向短路（commit `3d81a779`）

**泛化规则**: 评测套件运行的 agent 必须跟生产模式有干净的 memory 隔离。"读取写入"这种本应跨会话持久化的特性，在评测里要默认关闭。

### 错误模式: 协议字段对字面执行模型的反向引导

**问题**: 两条 nudge 文案都让长会话退化：

1. `PLACEHOLDER_FILE_READ` (mask 触发后替换 Read 结果): "...if you need specific content, ask the user."
2. `<reread-loop-detected>` nudge (≥3 次重读触发): "STOP re-reading. Proceed based on what you remember, or ask the user for guidance."

agent 循环里没有 askUser 工具也没有真实 user 在线，模型读到 "ask user" 后会：A) 试着调用一个不存在的 askUser 工具（GLM 试过 AskUserQuestion，失败），B) 继续 Read 想看是不是文件变了，C) 输出"我需要 guidance"然后停下。Claude 经过 RLHF 学会忽略，GLM/Kimi/DeepSeek 字面执行。

**修复**: 两处都改成"do not re-read, do not ask user, proceed from conversation history"（commit `b0625519` + `54a58c5e`）

**泛化规则**: 注入到 agent 循环的 system reminder 不能含"ask user"这种 agent 无法兑现的指令。任何指令都要确保 agent 实际能执行。

### 错误模式: 工具描述强制 read-before-edit

**问题**: `Edit` 工具 description 和 `file_path` 参数 description 都写了 "You must read the file with Read before editing"。`fileReadTracker.hasBeenRead()` 是 session 级 latch，一旦 read 过永久 true（updateAfterEdit 只更 mtime/size），所以工程上 Edit 完全不需要每次重读。但模型每次 Edit 都看到这条死指令 → GLM/Kimi/DeepSeek 字面遵守，每次 Edit 前都先 Read 一次，long-chain 里累积超 budget。

**修复**: 描述改成"FIRST edit per file 需要先 Read，subsequent edits 不需要 re-read"（commit `b0625519`）

**泛化规则**: 工具描述写"必须先做 X"时，要标注是否每次调用都需要、还是 session 内一次即可。否则字面执行模型会重复无效操作。

### 错误模式: thinking-mode 协议字段在 history 里漏传

**问题**: DeepSeek thinking-mode 要求 history 中**每个** assistant 消息都携带 `reasoning_content` 字段，否则 API 直接 400 拒绝。代码里的转换 `if (m.thinking) { msg.reasoning_content = m.thinking }`（shared.ts:336）只在 truthy 时设，三个漏点：

1. tool_use 响应 (`thinking` 通常为 undefined) → 缺字段
2. 纯文本 assistant 响应（走 line 367 的 fallback）→ 完全没设
3. sseStream 里 `reasoning || undefined` 把空字符串转成 undefined，让 truthy 检查永远失败

DeepSeek 报 400 后 AgentLoop catch → 返回空 ModelResponse → conversationRuntime.ts:580/587 都不进 → line 592 break → sendMessage 静默返回 turn=0。后续 follow-up 同样模式持续失败，duration 13s 跑完所有 10 个 follow-up。

**修复**: `convertToOpenAIMessages` 加 options.thinkingMode；BaseOpenAIProvider 加虚方法 `isThinkingMode()`，DeepSeekProvider/MoonshotProvider override 返回 true；assistant 的 toolCalls 和纯文本两个分支都补上 `reasoning_content = m.thinking ?? ''`（commit `19fa963d` + `be4c32f9`）

**泛化规则**: provider-specific 协议要求（reasoning_content / cache_control / metadata）不能写在共享转换函数里"全 provider 默认行为"——要走子类 override。共享函数只放协议骨架。

### 错误模式: 评测断言把"啰嗦"当成"失败"

**问题**: `max_tool_calls` 在 yaml 里写 `critical: true, weight: 1`，超 budget 1 个工具调用就 fail 整个 case 当 0 分。GLM 在 incremental-edit suite 上 5 个 case 的 content_contains / test_passes 全过——任务都做对了，只是 3 个 case 多读 2-4 次。评测显示 40% pass，但实际产出是 100% 完成。

**修复**: 5 处 max_tool_calls 都降级成 `critical: false, weight: 0.5`，让任务完成度作为主信号，budget 作为扣分项（commit `06c8a329`）

**效果**: GLM avg_score 40% → 93%，无 failed case（3 partial + 2 passed）。tool counts 没变，change 纯粹是评分语义。

**泛化规则**: 评测断言要分两类——任务完成度（critical）和过程质量（weighted）。把过程质量做成硬 gate 会让评测数字偏离实际产出能力。
