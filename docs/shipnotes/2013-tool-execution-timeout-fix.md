# Issue #2013 tool-execution timeout fix

工具执行现在按工具类型使用统一的无进展超时：搜索/检索 120 秒、MCP 60 秒、普通工具 120 秒、长任务 600 秒；Bash 保留自身命令级 timeout。工具在预算内没有进展时返回失败结果并让模型换路，期间有工具进度则重置 inactivity 时钟。

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
