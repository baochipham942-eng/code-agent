# Issue #2013 tool-execution timeout fix

工具执行现在按工具类型使用统一的无进展超时：搜索/检索 120 秒、普通工具 120 秒、长任务 600 秒；Bash 保留自身命令级 timeout，terminal_wait / gui_agent / spawn_agent(AgentSpawn) 保留自管计时（spawn_agent 前台由 raceForegroundBlockingBudget 到点转后台收养，并行模式由协调器负责），MCP 工具不走外层预算（lazy connect 120s/首次 180s 不算 progress，外层钟会误杀；调用侧已有 MCP 层自己的 60s 调用预算兜底）。工具在预算内没有进展时返回失败结果并让模型换路，期间有工具进度（emitEvent）则重置 inactivity 时钟；审批等待（含工具内部 canUseTool 弹卡）不计入无进展时长。有不可重放副作用的写类工具（mail_send、github_pr、calendar_* 等）超时结果标记 outcome-unknown，提示模型先核实副作用状态再决定是否重试。

已知边界：协议工具主派发路径不传进度回调，只有工具主动 emitEvent 才算进展——耗时长又不发事件的生成/自动化类工具（docx_generate、ExcelAutomate、xlwings_execute 等）安静超过 120 秒会被判超时。遇到误杀时把工具名加进 `src/shared/constants/timeouts.ts` 的 `TOOL_EXECUTION_LONG_RUNNING_NAMES`（600 秒档），自管计时的工具加 `TOOL_EXECUTION_SELF_LIMITING_NAMES`。

行为变化（相对基线）：detached 子代理（spawn_agent `run_in_background` / `waitForCompletion:false` / 前台超时转后台收养）不再跟随整轮运行的停止而取消——引擎在工具调用收口时会 abort 本次调用的信号，三条路径都在返回前摘除监听；取消语义统一走 SpawnGuard / close_agent，与后台语义一致。

## 反向变异

变异：在 `awaitToolExecutionWithTimeout` 中删除 `options.abort()`；验证结果：

```
FAIL tests/unit/agent/toolExecutionTimeouts.test.ts > turns an inactive execution into a model-visible failure
AssertionError: expected "abort" to be called once, but got 0 times
```

删除 `resolve(options.buildTimeoutResult(...))` 时验证结果为：

```
FAIL tests/unit/agent/toolExecutionTimeouts.test.ts > turns an inactive execution into a model-visible failure
Error: Test timed out in 5000ms.
```

两处均已还原，targeted tests 全绿。

证据档位：static-contract + hermetic-protocol + fault-injection（反向变异记录如上；未做 real-runtime）。
