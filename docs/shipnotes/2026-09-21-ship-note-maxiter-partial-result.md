# Ship Note — 撞 max iterations 强制部分结果收尾 + CLI 独立退出码 2（issue #1999）

## 背景

夜跑 2026-09-20：3 个撞 max iterations（50）的会话全部 exit 1 + 空回复 + 无产物。根因链：

1. 主循环进入最后一轮会激活 max-steps forced-final 通道（`activateMaxStepsFinalResponse`），但模型交白卷（空文本）时循环直接退出，没有任何 final 消息；
2. `runFinalizer` 对 max-iterations 只发一条无 code 的 `error` 事件（'Max iterations reached'）；
3. CLI adapter 见到 error 事件即 `success=false` → exit 1，输出取 `lastContent || 最后一条助手消息`——两者都空。

## 方案（一句话）

撞顶时复用既有 forced-final 收尾通道做确定性保底：模型在最后一轮有优先权，模型没交付（`forceFinalResponseReason` 未被清除——该判据对预算耗尽等其他 forced-final 触发路径同样成立，两条触发路径行为对齐）时，运行时合成「部分结果 + 未完成说明」补一条 final 消息；CLI 凭稳定 code `MAX_ITERATIONS_REACHED` 映射独立退出码 2（0 正常 / 1 异常 / 2 撞顶部分完成，文档在 `docs/architecture/cli.md` 与 `src/cli/exitCodes.ts`）。

不把 50 调大——那是掩盖问题；压缩失效另案（调查发现见 PR 描述，本单未改压缩逻辑）。

## 改动文件

- `src/host/agent/runtime/conversationRuntime.ts` — 循环尾部接 `ensureMaxStepsWrapUp`
- `src/host/agent/runtime/maxStepsFallback.ts` — `ensureMaxStepsWrapUp` + `buildMaxStepsPartialResultContent`
- `src/host/agent/runtime/runFinalizer.ts` — max-iterations error 事件带稳定 code
- `src/shared/constants/agent.ts` — `RUN_ERROR_CODE_MAX_ITERATIONS`
- `src/cli/adapter.ts` / `src/cli/types.ts` / `src/cli/commands/run.ts` — `runErrorCode` → `terminationReason` → 退出码
- `src/cli/exitCodes.ts`（新）— 退出码约定 + `resolveRunExitCode`
- `docs/architecture/cli.md` — 退出码文档
- `tests/unit/agent/conversationRuntime.test.ts` / `tests/unit/cli/adapter.cliAgent.test.ts` / `tests/unit/cli/exitCodes.test.ts`（新）

## 测试证据

- `npm run typecheck`：PASS（typescript7 native）
- `npx vitest run tests/unit/agent/conversationRuntime.test.ts`：81/81 PASS（+3 新用例：撞顶空输出→合成部分结果+message 事件；撞顶有总结→不兜底；未撞顶→不兜底）
- `npx vitest run tests/unit/cli/adapter.cliAgent.test.ts tests/unit/cli/exitCodes.test.ts`：39+3=42/42 PASS（+2 adapter 用例：部分完成→terminationReason+输出非空、无 code 错误→普通失败；+3 退出码映射用例）
- 三文件合跑：123/123 PASS
- `node node_modules/typescript7/bin/tsc --noEmit -p tsconfig.tests.json`：0 error（tsc-tests 棘轮 current=0 baseline=0）
- ✓ gates:fast passed required local preflight. schema=2 head=2fc9c9be1f42bf28dce3b9dbddbf40f7758d5949 base=a5ca056be0b1803312259441b9837698368ad8ea receipt=8e76a13d-13b5-46bf-ad47-18ac37d974e2（--regressions 覆盖 7 个未登记源路径，语义理由在 JSON）

证据档位：static-contract + hermetic-protocol + fault-injection。未做 real-runtime：撞顶路径需要 50 轮真实推理，本地不可复现；保底触发条件、消息合成与退出码映射均被单测逐点钉死，且反向变异证明测试真红。

## 反向变异

变异 1：`maxStepsFallback.ensureMaxStepsWrapUp` 函数体首行插 `if (true) return;`（禁用保底收尾），跑撞顶空输出用例：

```
 FAIL  tests/unit/agent/conversationRuntime.test.ts > ConversationRuntime > run > synthesizes a partial-result wrap-up when max iterations ends without any final text (issue #1999)
AssertionError: expected undefined to be truthy
      Tests  1 failed | 80 skipped (81)
```

变异 2：`cli/adapter.ts` 删掉 `terminationReason` 映射（3 行），跑部分完成用例：

```
 FAIL  tests/unit/cli/adapter.cliAgent.test.ts > CLIAgent > run hitting max iterations: partial completion keeps output and marks terminationReason
AssertionError: expected undefined to be 'max_iterations' // Object.is equality
      Tests  1 failed | 38 skipped (39)
```

两处变异均已 `git checkout` 还原，还原后 123/123 全绿。

## 压缩失效调查发现（只调查，未改压缩逻辑）

1. **`loop_decision.contextRatio` 是累计值，不是单请求压力**：`conversationRuntime.ts` 构造 `LoopState` 时 `tokenUsage.input = ctx.stats.totalInputTokens`，而 `runStatsState.addTokenUsage` 每次推理 `+=` 累计整个 run；除以单次上下文窗口得出 5.85。50 轮 × 平均 ~23k input / 138k 窗口 ≈ 5.85 完全正常——该 trace 字段口径误导，单凭它不能断言「压缩没跟上」，建议在压缩 issue 里改口径（用当轮 `response.usage.inputTokens`）。
2. **loop 决策引擎的 `compact` 决策是 advisory，从不驱动真压缩**：`decideNextAction` 的 `execution: 'advisory'` 只落 trace（`loop_decision` 记录后无任何执行分支）；真压缩只有两条路径——`messageProcessor.handleToolResponse` 末尾的 `checkAndAutoCompress()`（每轮工具调用后）与 `inference.ts` 的 provider-confirmed overflow 补偿。所以「决策说 compact 但上下文没压回去」首先应查压缩审计事件（`context_compressed` / `emitContextCompressionSignal` 的 skip/lossless-budget-skip），而不是 loop_decision。
3. **压缩检查只挂在工具轮**：`checkAndAutoCompress` 仅在 `handleToolResponse` 末尾调用；纯文本轮（含 forced-final 收尾轮）不做压力评估。撞顶会话若末段是长文本往返，压力窗口会比工具轮稀疏——是否需要在文本轮也评估，留给压缩 issue 裁决。


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=4ce72953a5e14ab9928e934d10db913ee6d28c30 base=7f353a4fec5d2526531dbbf93c5f086fec8ad664 receipt=7689b704-1c08-46ca-ac3a-ffc4aa6fdc29


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=887652a2c63ab65c66c2ff61d7035bc96a74d613 base=7f353a4fec5d2526531dbbf93c5f086fec8ad664 receipt=740bf894-69e4-448f-858a-1cd762ddb778


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=cea91d5729d0214ac5920bd105bb7c01d45b37bf base=3dfe6d07dabd5d90b60ff9b3630556dba4300461 receipt=c0dfb2f1-8e8d-407d-9eae-3b2acc50ab8f

## ai-review R1（codex，Important 3 · Nit 1）修复

1. 兜底摘要限定本次 run：`buildMaxStepsPartialResultContent` 取最近 assistant 文本时按 `timestamp >= ctx.stats.runStartTime` 过滤，旧会话历史不再被复述成「最近一次产出」。
2. CLI 最终 output 在 `terminationReason=max_iterations` 时优先取最后一条助手消息（兜底收尾）而非 `lastContent`（前面回合的流式旧文本）。
3. forced-final 轮只回空白字符不算交付：`conversationRuntime` 文本分支对 forced-final 加 `content.trim()` 判据，空白收尾不再清掉 `forceFinalResponseReason`、保底判据保持有效。
4. Nit（maxIterations=1 无保底）：by design——单轮上限的语义就是一枪一响，forced-final 会禁掉唯一一轮的工具调用，维持原有 `maxIterations > 1` 守卫。

新增钉死用例：空白 forced-final 轮→兜底生效且不进 handleTextResponse；pre-run 历史答案→不复述、报「没有留下可见产出」；CLI 撞顶前有流式输出→最终 output 为兜底收尾。合计 126/126 全绿。


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=a357bb76cf54bac061e4ad85dccb45dca6bb50fe base=460628e431b4ee2fac7e2d716732f02819d2d508 receipt=3bda4f23-b544-45a4-bcd4-2d71ec9265d9

## ai-review R2（codex，Important 1）修复

forced-final 轮原文仅含内部格式标记（`<truncation-recovery>` / `Ran:` 等）时，`stripInternalFormatMimicry` 清洗后落盘正文为空，但旧代码仍清掉 `forceFinalResponseReason`，保底判据失效、CLI 空 output 却带退出码 2。修复：`messageProcessor.handleTextResponse` 在 forced-final 且清洗后正文为空时不落盘、不清 reason（turn_end/telemetry 照发），reason 残留驱动 `ensureMaxStepsWrapUp` 兜底。钉死用例在 `tests/unit/agent/messageProcessor.persistence.test.ts`（39/39 全绿）。
