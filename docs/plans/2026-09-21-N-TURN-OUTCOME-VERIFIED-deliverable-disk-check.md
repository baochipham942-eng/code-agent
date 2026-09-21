# N-TURN-OUTCOME-VERIFIED — turn_outcome 交付物落盘核对闭环（issue #1998）

日期：2026-09-21 ｜ 分支：n-turn-outcome-verified ｜ 工单：baochipham942-eng/code-agent #1998

## 背景与根因

trace 里 turn_outcome 的 verdict 605/608 是 `self_claimed`、`verified` 为 0，
`deliverables_declaration` 仅 5 条（对 5476 次 inference）。两条根因：

1. **verified 不可达**：generic 路径的判定要求 `kind==='test' && state==='read'`
   的证据（`turnOutcomeStamp.ts`），只有跑过验证命令才产生；而产品交付形态
   （网页/报告/演示稿）绝大多数不跑测试命令。
2. **deliverables_declaration 近乎死代码**：只在模型显式调 `declare_deliverables`
   时发射（`declareDeliverablesGate.ts`），该工具是 deferred 工具
   （`deferredTools.ts`），模型极少调用；声明槽 `ctx.artifact.declaredDeliverables`
   在 generic run 里没有任何消费方。

直接后果：产物幻觉拦不住——本夜约 25 个会话声称交付了磁盘上不存在的文件。

## 改动

- 新增 `src/host/agent/runtime/deliverableDiskCheck.ts`：收集本 run 的交付物声称
  （本 run 内 `declare_deliverables` 声明 + 最终回复 claim 动词抽取；词表与
  `postLaunchSignals.CLAIM_VERB_PATTERN` 同源，容忍空格/中文、NFC 归一化、剔除
  `资料/` 输入引用），逐个落盘核对存在且非空；`runDeliverableDiskCheckGate`
  是给 messageProcessor 的收尾闸。
- `turnOutcomeStamp.ts`：核对全部通过 → verdict `verified`（测试命令之外的第二条
  可达路径）；缺漏记 `DELIVERABLE_NOT_ON_DISK` / `DELIVERABLE_EMPTY` 进
  evidenceProblems；回复里抽取的声称记进同一本 `deliverables_declaration` 账
  （`status: 'inferred'`，`turnTrace.ts` 联合类型扩展），不另起平行机制。
- `messageProcessor.ts`：最终回复落库前过闸，缺漏且有预算 → 注入
  `<deliverable-disk-check>` 回喂补一轮（上限
  `TURN_OUTCOME.MAX_DELIVERABLE_REPAIR_ROUNDS = 1`，常量在
  `src/shared/constants/agent.ts`）；预算用尽仍缺 → 放行但 final 追加未交付说明。
- `src/shared/contract/contextView.ts`：注入源枚举加 `deliverable-disk-check`。

## 反向变异

变异：`messageProcessor.ts` 收尾闸调用条件改为
`if (!isForcedFinalTextPass && process.env.DELIVERABLE_GATE_MUTATION !== '1')`，
`DELIVERABLE_GATE_MUTATION=1 npx vitest run tests/unit/agent/messageProcessor.deliverableDiskCheck.test.ts`：

```
× claims delivered but file missing → feeds back one bounded repair round
× still missing after the repair budget → break and the final reply states what was not delivered
× declared deliverable (declare_deliverables this run) missing → same repair round
AssertionError: expected 'break' to be 'continue' // Object.is equality
AssertionError: expected '已生成 `ghost.html`，请查收。' to contain '本轮实际未交付'
Tests  3 failed | 2 passed (5)
```

还原后同文件 5/5 复绿。

## 测试证据

- `npm run typecheck` ✓（typescript7 native）
- `npx vitest run tests/unit/agent/runtime/deliverableDiskCheck.test.ts` 14/14 ✓
- `npx vitest run tests/unit/agent/messageProcessor.deliverableDiskCheck.test.ts` 5/5 ✓
- `npx vitest run tests/unit/agent/turnOutcomeStamp.test.ts` 35/35 ✓（30 存量 + 5 新增）
- `npx vitest run tests/unit/agent/messageProcessor.deliveryCritic.test.ts tests/unit/agent/messageProcessor.stopHook.test.ts tests/unit/agent/messageProcessor.persistence.test.ts tests/unit/agent/runtime/goalEvidenceGate.test.ts tests/unit/agent/runtime/goalEvidenceGateEvent.test.ts` 74/74 ✓
- `npx vitest run tests/unit/agent`（全量 282 文件）：3201 通过 / 1 失败，
  失败项 `toolExecutionEngine.hooks.test.ts` 单跑 63/63 通过，为并行负载抖动
  （两次全量跑失败集不同：13 失败 → 1 失败），与本改动无关。
- `npm run gates:fast -- --regressions .reports/gates-fast/regressions-n1998.json` ✓
  receipt=3c8fe910-d47b-43ff-8281-a2e648243785

证据档位：static-contract + hermetic-protocol + fault-injection（反向变异真红见上）。
未做 real-runtime：闭环判定全部为本地文件系统确定性核对，单测以真实 tmp 目录夹具
覆盖存在/缺失/空文件三态；真实模型端到端行为留待夜跑 trace 观察 verified 占比。
