# Alma Trace / Hooks / Performance 对标研究

## 判断

Alma 这轮在 Trace / Hooks / Performance 上的重点，不是做一套复杂的开发者观测后台，而是把底层可观测性转成会话质量保障：长回复不能断，工具输出不能丢，错误不能把栈信息直接甩给用户，插件和 subagent 的完成事件要能被外部系统接住，主进程和数据库不能拖慢会话页。

Code Agent 底层能力更厚：已有 19 类 hook、turn timeline、hook activity banner、stream delta/snapshot、session event persistence、structured replay、error classifier、review queue 和 trace projection。主要差距在产品组织：这些能力分散在 trace / eval / hooks / streaming / error 几条线里，还没有形成一个会话页里的“执行质量面板”。

## Alma 证据

| 版本 | 能力 | 会话页价值 | 证据 |
|---|---|---|---|
| v0.0.805 | Plugin events / metadata，包含 finish reasons、response IDs、`chat.subagent.didComplete` hook | 插件和自动化可以知道一轮回复为什么结束、对应哪个响应、子代理什么时候完成 | `/tmp/alma-update-20260613/release-notes-805-823.md` |
| v0.0.805 | Tool output 被截断后保存到文件 | 长工具输出不会只剩截断片段，模型还能访问剩余内容 | 同上 |
| v0.0.811 | Claude CLI interactive mode + cleaner streaming | 订阅模型链路的流式输出更干净，减少会话页“边来边乱”的情况 | 同上 |
| v0.0.811 | 修复长回复 cut off / reconstructed incorrectly | 最终回答不被截断或错误拼接，直接影响交付可信度 | 同上 |
| v0.0.811 | 使用 clean conversation text，移除 terminal footer / clutter | transcript 不再被终端 UI 噪声污染 | 同上 |
| v0.0.820 | 错误回复只发短摘要，减少 progress spam | 渠道会话不把开发诊断暴露给用户，也不刷屏 | 同上 |
| v0.0.823 | 优化 main process、database、base64 性能瓶颈 | 会话页、附件、图片、数据库读写不拖慢整 app | 同上 |

产品含义：Alma 把“事件、hook、错误、性能”都收束到一个目标：会话页交付不能被底层噪声破坏。

## Code Agent 现状

| 领域 | 当前能力 | 关键文件 | 判断 |
|---|---|---|---|
| Hook 生命周期 | 定义 19 类事件，包含 `SubagentStop`、`StopFailure`、`PreCompact`、`PostExecution`、`SessionStart/End` | `src/main/protocol/events/hookTypes.ts` | 覆盖面已经强于 Alma release note 暴露出的 hook 面 |
| Hook 配置与执行 | 支持 decision / observer，command / prompt / agent / http，global/project 配置合并 | `docs/api-reference/hooks.md`, `src/main/hooks/hookManager.ts` | 底层成熟，但用户需要理解配置文件，门槛偏高 |
| Hook 可见性 | hook trigger history 进入 turn timeline，TurnCard 展示“执行了 N 个钩子”、来源、是否可干预、是否阻止/改写/报错 | `src/renderer/components/features/chat/TurnCard.tsx`, `src/renderer/utils/turnTimelineProjection.ts` | 这是很接近 Alma 产品方向的能力，值得强化 |
| Subagent 完成事件 | `SubagentStart` / `SubagentStop` 已在 subagent executor 多个完成/失败路径触发，`SubagentStop` 带 agentId 作为 trace 查询入口 | `src/main/agent/subagentExecutor.ts`, `tests/unit/hooks/hookSanitizationAndTrace.test.ts` | 能力有，但还没有像 Alma 那样被包装成 plugin event metadata |
| Streaming 稳定性 | 有 `turn_start`、`message_delta`、`message_snapshot`、`stream_chunk`、`stream_reasoning`，并用 deltaSeq 丢弃重复/乱序 delta | `src/main/protocol/messageDeltaAccumulator.ts`, `src/renderer/hooks/agent/effects/useConversationStreamEffects.ts` | 对“长回复拼接稳定”已经有基础防线 |
| Trace Projection | 消息投影成 turn / node，保留 tool call、duration、outputPath、reasoning、modelDecision、artifact metadata | `src/shared/contract/trace.ts`, `src/renderer/hooks/useTurnProjection.ts` | 信息完整，但用户看到的是分散节点，不一定能快速判断这一轮是否健康 |
| Replay / Eval | 会话事件持久化，支持 event stats、tool calls、thinking、error timeline；structured replay 从 telemetry 重建 | `src/main/evaluation/sessionEventService.ts`, `src/main/evaluation/replayService.ts` | 评测侧强，会话页侧还可以更直接 |
| 错误分类 | 有细粒度 error classifier，覆盖 network、rate limit、permission、model、tool 等，并带 retryable / confidence | `src/main/errors/errorClassifier.ts`, `src/main/errors/handler.ts` | 底层分类够用，但会话页还没有统一的短摘要/行动建议层 |
| 性能观测 | streaming performance counters 记录 accumulator、IPC batch、projection、markdown render 等指标 | `src/renderer/utils/streamingPerformanceMetrics.ts` | 更像 debug API，还没有转成用户/开发者可审阅的质量信号 |

## 差异矩阵

| 对标点 | Alma 做法 | Code Agent 现状 | 差异 | 建议 |
|---|---|---|---|---|
| Finish reason / response id | release note 明确给 plugin events metadata | 模型响应事件有 provider/model/usage/toolCalls/runtimeDiagnostics，但未看到统一 response id / finish reason 产品契约 | 我们事件多，但缺一个对外稳定的“回合结束元数据” | P0：定义 Turn Completion Metadata，至少包含 status、finishReason、responseId/modelRequestId、tokens、toolCount、errorSummary |
| Subagent complete | `chat.subagent.didComplete` hook | `SubagentStop` hook + agentId trace 入口 | 我们偏 hook 语义，Alma 偏 plugin event 语义 | P0：把 `SubagentStop` 同步投影成会话页和 plugin 都能消费的 `subagent.completed` 事件 |
| Tool output 截断 | 截断内容保存文件，模型可继续访问 | trace toolCall 支持 `outputPath`，tokenOptimizer / tool result budget 有截断能力 | 能力可能已有，但用户很难知道“截断了、在哪里看完整输出” | P0：会话页工具卡显示“已截断，完整输出在文件”，并支持打开/复制路径 |
| Streaming 修复 | 重点修长回复 cut off / 拼接错误 / terminal clutter | deltaSeq、snapshot、stream chunk、reasoning 分离都在 | 我们技术面不错，但缺少“stream repair / recovered”可见状态 | P1：当 snapshot 覆盖 delta 或丢弃 duplicate 时，只在 debug/trace 中记录，不打扰普通用户 |
| 错误短摘要 | 渠道错误只发 short summary | error classifier 与 recovery strategy 已有，UI 上仍可能分散为 toast、message、runtime error | 我们有分类，缺统一表达 | P0：把错误分为“用户可行动 / 系统可恢复 / 开发诊断”，会话页默认只露前两层 |
| Progress spam | 减少 Feishu progress spam | task_progress、task_stats、streaming banner、tool groups 多来源 | 信息量足，但可能重复 | P1：合并同类进度，只显示当前瓶颈和最后有效状态 |
| Performance | 修 main process、DB、base64 lag | streaming metrics 有 debug counter，DB/session event 写入较多 | 我们能测 streaming，缺端到端会话卡顿归因 | P1：加会话性能摘要：首 token、stream flush、tool wait、render cost、DB save cost |

## 借鉴开发切片

### P0. Turn Completion Metadata

目标：每一轮会话结束时形成稳定元数据，供会话页、插件、评测、回放共用。

建议字段：

| 字段 | 用途 |
|---|---|
| `turnId` / `sessionId` | 绑定会话与回放 |
| `status` | completed / failed / cancelled / interrupted |
| `finishReason` | stop / max_iterations / context_length / tool_failure / user_cancel / runtime_error |
| `responseId` 或 `modelRequestId` | 对齐 provider 级响应 |
| `model` / `provider` / `fallback` | 解释模型路由 |
| `inputTokens` / `outputTokens` | 使用量和成本 |
| `toolCount` / `failedToolCount` | 执行质量 |
| `errorSummary` | 短错误摘要 |
| `artifactCount` | 交付物数量 |

验收：
- 单测覆盖成功、失败、取消、max iteration。
- TurnCard 能显示一个折叠的“本轮完成状态”。
- Replay / session event 能按 `turnId` 查到同一份 metadata。

### P0. Tool Output Truncation 可见化

目标：把“截断但已保存完整输出”变成用户能理解、模型能继续用的状态。

最小切片：
- 在 tool result metadata 中标准化 `truncated: true`、`outputPath`、`originalSize`、`visibleSize`。
- `TraceNodeRenderer` 或 `ToolStepGroup` 显示“输出过长，已保留完整文件”。
- 提供打开文件、复制路径、重新读取的入口。

验收：
- 构造超长 tool output，确认会话页有提示。
- 模型后续回合能引用完整输出路径。
- 导出 transcript 时保留路径和截断说明。

### P0. 错误短摘要层

目标：把底层 error classifier 和 recovery strategy 接到会话页。

最小切片：
- 新增 `formatTurnErrorForUser(classification)`，只输出短摘要、影响、建议动作。
- `RunFinalizer` 的 failed / circuit breaker / max iterations 都产出统一 `errorSummary`。
- 详细 stack 和 raw error 只进 trace/replay，不默认显示在 chat 主流里。

验收：
- network / permission / context length / hook blocked / tool failure 分别有快照测试。
- 用户侧消息不包含 stack trace。
- trace 里仍能找到完整诊断。

### P1. Hook / Subagent Event 产品化

目标：把现有 hook 活动从“技术 banner”升级成“本轮有什么自动化参与”。

最小切片：
- `SubagentStop` 同步投影为 `subagent.completed` timeline item。
- Hook banner 增加“影响本轮结果”的摘要，比如“1 个项目 hook 改写了输入”“1 个 hook 阻止了 Bash”。
- 插件侧暴露稳定事件名，避免外部只读内部 hook 名。

验收：
- 子 agent 完成后 TurnCard 可见。
- plugin event 测试覆盖 finish reason / subagent completed。
- hook activity 仍保留 source、decision/observer、duration。

### P1. 会话性能摘要

目标：让性能问题从“感觉卡”变成可定位。

最小切片：
- 收集首 token 时间、stream flush 次数、duplicate delta 数、tool wait 时间、render markdown 次数。
- 只在 debug/inspector 或开发设置中显示，不打扰普通用户。
- 当某项超过阈值时在 trace 中标注，例如“渲染慢”“工具等待久”“DB 写入慢”。

验收：
- `streamingPerformanceMetrics` 有聚合快照。
- E2E 长回复能看到 stream counters。
- 普通会话 UI 不增加噪音。

## 风险

| 风险 | 说明 | 处理 |
|---|---|---|
| 事件太多，反而更吵 | 我们已有大量 trace/hook/streaming 数据，直接全显示会压垮会话页 | 默认显示摘要，展开才看细节 |
| 插件事件和 hook 事件边界混乱 | Hook 是生命周期机制，plugin event 是外部扩展契约 | 先定义稳定外部事件，再映射内部 hook |
| 错误摘要过短导致排障困难 | 用户侧短摘要不能丢开发诊断 | trace/replay 保留完整 error，chat 只放可行动摘要 |
| 性能指标产品化过早 | debug counter 不等于用户指标 | 先给开发者面板，不进主聊天流 |

## 这次没有做

- 没有修改产品实现代码。
- 没有跑完整测试。
- 没有创建 commit、push 或 PR。
- 没有重新反编译 Alma，只基于已下载的 0.0.805 / 0.0.823 bundle 和 release notes 做研究。
