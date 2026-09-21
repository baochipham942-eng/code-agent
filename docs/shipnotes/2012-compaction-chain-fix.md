# Issue #2012 compaction-chain fix

本次改动把 `loop_decision` 的输入 token 改为当前 provider response 用量，让 advisory compact 决策调用统一压缩入口，并让纯文本/forced-final 收尾轮执行同一压力检查。

## 反向变异

变异：移除 `conversationRuntime.ts` 中 `decision.action === 'compact'` 的 `checkAndAutoCompress()` 调用；验证结果：

```
FAIL tests/unit/agent/conversationRuntime.test.ts > compact advice executes the runtime compaction path
AssertionError: expected "checkAndAutoCompress" to be called 1 times, but got 0
```

移除 `messageProcessor.ts` 文本轮 `checkAndAutoCompress()` 调用；验证结果：

```
FAIL tests/unit/agent/messageProcessor.persistence.test.ts > evaluates pressure after a text-only response
AssertionError: expected "checkAndAutoCompress" to be called 1 times, but got 0
```

两处均已还原，targeted tests 全绿。

证据档位：static-contract + hermetic-protocol + fault-injection（反向变异记录如上；未做 real-runtime）。


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=f8b0bb63cbbb45e6792d18d8e09afa772fb92afd base=0972777573170f8751845ffd325a697ded172a1f receipt=1361388e-ca11-4498-ba37-a067895dd0d9
