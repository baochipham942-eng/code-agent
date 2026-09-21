# Issue #2013 tool-execution timeout fix

工具执行现在按工具类型使用统一的无进展超时：搜索/检索 120 秒、普通工具 120 秒、长任务 600 秒；Bash 保留自身命令级 timeout，terminal_wait 保留自带等待上限，MCP 工具不走外层预算（lazy connect 120s/首次 180s 不算 progress，外层钟会误杀；调用侧已有 MCP 层自己的 60s 调用预算兜底）。工具在预算内没有进展时返回失败结果并让模型换路，期间有工具进度则重置 inactivity 时钟；审批等待（含工具内部 canUseTool 弹卡）不计入无进展时长。有不可重放副作用的写类工具（mail_send、github_pr、calendar_* 等）超时结果标记 outcome-unknown，提示模型先核实副作用状态再决定是否重试。

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
