# Ship note · 2026-09-21 · 推理客户端超时重试帽 + 重试进会话 trace（issue #1989）

## 背景

夜跑 2026-09-20（506 题）：24 个会话 exit=timeout，其中 18 个 trace 最后事件是
`request_manifest`——请求发出后无任何后续事件，被外层 600s 看门狗强杀，整轮作废。

排查结论（修正工单初始假设）：客户端超时**早已就位**——非流式 `PROVIDER_TIMEOUT=300s`、
流式首字节 60s / 无数据间隔 120s 看门狗（`aiSdkAdapter.ts`）。真正的两个缺口：

1. **超时驱动的重试与秒级瞬态错误共享 4 次重试预算**。每次超时重试最坏烧满一个
   300s 整请求窗口，单轮推理最坏 5×300s=1500s，远超外层 600s 看门狗——夜跑全灭
   就是这个形态：第一次 300s 超时后还在退避重试，600s 到点被强杀，trace 上只见
   request_manifest。
2. **重试只落 stderr 日志**，turn trace 里没有任何超时/重试记录，事后分析无从
   分辨「还在等」与「第几次超时重试」。

## 改动

- `withTransientRetry` 新增 `isTimeoutError` / `maxTimeoutRetries`：客户端超时
  （非流式整请求、流式首字节看门狗）驱动的重试单独计数，封顶
  `INFERENCE_TIMEOUTS.TIMEOUT_RETRY_MAX=2`（`src/shared/constants/timeouts.ts`，
  仓规 §5.1）。普通瞬态错误（502/ECONNRESET 等秒级失败）重试预算不变；
  已出字后的断流续接预算（STREAM_RECONNECT_MAX=2，ADR-068）不变。
- `InferenceOptions.onInferenceRetry` + turn trace 新事件 `inference_retry`
  （kind=timeout/transient/reconnect，关联 requestId），provider 挂起时 trace
  不再止于 request_manifest。
- 顺手收编：`inference.ts` artifact compact 重发的 90s/20s/45s 字面量 →
  `INFERENCE_TIMEOUTS.ARTIFACT_COMPACT_RETRY_*`；`withRequestTimeout` 与重试通知
  事件拼装抽到 `src/host/model/adapters/inferenceRetryNotify.ts`（god-file
  max-lines 1000 守门）。

## 不误杀正常长生成

阈值未动：非流式整请求 300s > 观测 p99（156s）；流式按「无数据间隔」判挂死
（120s 无事件才算，长流式只要有 token 在进就不触发），撞 32k 输出上限的 475s
长生成走的是流式路径，不受影响。本 PR 只改**超时后的重试次数**，不改超时阈值。

## 反向变异

落地后这三刀必须红：

### 1. 删掉 withTransientRetry 的超时重试帽

- 文件：`src/host/model/providers/retryStrategy.ts`（`withTransientRetry`）
- 变异：把 `timeoutBudgetLeft` 恒置 `true`（或删掉 `maxTimeoutRetries` 判断）。
- 预期红：`tests/unit/model/retryStrategy.test.ts`
  「超时错误到 maxTimeoutRetries 即放弃（1+2 次调用），不烧满 maxRetries」——
  fn 会被调 5 次而非 3 次，断言必红。

### 2. 流式首字节超时不受帽

- 文件：`src/host/model/adapters/aiSdkAdapter.ts`（`streamViaAiSdk` catch 分支）
- 变异：把 `timeoutCapHit` 恒置 `false`。
- 预期红：`tests/unit/model/aiSdkAdapterTimeout.test.ts`
  「流式：首字节连续挂起 → 首字节超时重试帽（2 次）耗尽后抛错」——
  streamText 会被调 5 次而非 3 次，断言必红。

### 3. 重试不进 trace

- 文件：`src/host/agent/runtime/contextAssembly/requestManifest.ts`
  （`recordInferenceRetryTrace`）
- 变异：删掉返回闭包里的 `ctx.runtime.turnTrace?.record(...)` 调用。
- 预期红：`tests/unit/agent/requestManifest.test.ts`
  「把重试事件以 inference_retry 记入 turn trace 并关联 requestId」必红。

## 测试证据

- `npx vitest run tests/unit/model/aiSdkAdapterTimeout.test.ts tests/unit/model/retryStrategy.test.ts tests/unit/agent/inference.artifactRetry.test.ts`：131 passed。
- `npx vitest run tests/unit/agent/turnTrace.test.ts tests/unit/agent/requestManifest.test.ts`：16+2 passed（requestManifest 新增 2 条本 PR 用例后 11 passed 单文件）。
- `tests/unit/model/` + `tests/unit/agent/` 全量：3614 passed / 3 failed——
  3 个失败全在 `toolArtifactValidationLifecycle.lightPlayability.test.ts`
  （playability 冒烟各 30s 超时），在纯净 origin/main（stash 本 PR）上同样失败，
  存量环境型 flake，与本 PR 无关。
- `npm run typecheck`：通过（typescript7）。
- `npm run gates:fast -- --regressions <json>`：passed，receipt 见 PR 描述。

证据档位：static-contract（typecheck + eslint + gates:fast）+ hermetic-protocol
（mock streamText/generateText 的挂起-超时-重试单测，fake timers）。
