# Codex Audit Report — workflow-runtime-wiring

**Date**: 2026-05-29
**Scope**: `HEAD~2..HEAD` at audit start = `e63e924f` (workflow 命令层接线) + `a90ea861` (tool 名修正 + full-agent E2E)
**Starting commit**: `a90ea861`
**Reviewer**: Codex `gpt-5.4` (adversarial, independent context)
**Rounds run**: 4 / 4
**Converged**: ⚠️ stopped at MAX_ROUNDS — but severity decreased每轮 (R1 2H/6M → R2 1H/4M → R3 1M → R4 1M/1L)，无 HIGH 残留，R4 两项均为 type-impossible 防御 + LOW，实质收敛。

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     | 2    | 3   | 3   | `8c4a949e` |
| 2     | 1    | 4   | 0   | `63104de0` |
| 3     | 0    | 1   | 0   | `410857c7` |
| 4     | 0    | 1   | 1   | `a8556d87` |

测试：20/20 green（`tests/unit/tools/modules/multiagent/workflow.test.ts` 19 + `tests/unit/agent/scriptRuntime/runService.test.ts` 1）。每个 fix 走 TDD（先红后绿）。

## Findings by Round

### Round 1

#### 🔴 HIGH — worker 非真沙箱 + 文档失实（Function-constructor 逃逸 / Date.now·Math.random 未禁）
**Finding**: `new Worker(eval)+AsyncFunction` 不是安全边界，脚本可经 `agent.constructor('return process')()` 拿回 process/require；文档称 `Date.now()/Math.random()` 不可用但 worker 只 shadow 了 require/process/module 全局，没 shadow Date/Math。
**Resolution**: ✅ 文档部分修正（`8c4a949e`）——删除"不可用"误述，改为"避免（确定性/replay）"，去掉"sandboxed"过度措辞。ℹ️ 硬隔离（isolated-vm）**deferred**：sandbox.ts（prior commit 132a3aa0）已注释声明"脚本是半信任非对抗代码，强隔离留后续"，且在 P2 计划内，非本 wiring scope。

#### 🔴 HIGH — runId 碰撞
**Finding**: `wf-${currentToolCallId ?? sessionId}` —— currentToolCallId 可缺失、sessionId 复用 → activeRuns 覆盖 + cancel/状态串线。
**Resolution**: ✅ `8c4a949e`：加 `randomUUID().slice(0,8)` 后缀。

#### 🟡 MED — model override 静默清空鉴权
**Finding**: configService 未初始化时 `resolveSessionDefaultModelConfig` 返回 apiKey=''，override 后子调用无凭证。
**Resolution**: ✅ `8c4a949e`（R2/R4 续修）：同 provider 下继承 base apiKey/baseUrl。

#### 🟡 MED — deriveSubagentContext 整包 spread legacyCtx（未来字段泄漏）
**Resolution**: ✅ `8c4a949e`：显式 null messages/todos/modifiedFiles/currentAttachments。

#### 🟡 MED — startRun 抛错炸 handler；非 cancel 全折叠 DOMAIN_ERROR
**Resolution**: ✅ `8c4a949e`（R2 续修为顶层 try/catch）。

#### 🟢 LOW — return undefined→"null" / filter(Boolean) 删 0·false·'' / 失败先发 completing
**Resolution**: ✅ `8c4a949e` 全部修正。

### Round 2（聚焦 regression + symmetric application）

#### 🔴 HIGH — runService.startRun activeRuns 清理无异常安全
**Finding**: 体内抛（emit/worker/abort）跳过 `activeRuns.delete` → stale run 泄漏 + cancel/getRunState 串线。R1 在 workflow.ts 兜了 startRun 抛错，反而让"不炸 handler 但静默泄漏 run"。
**Resolution**: ✅ `63104de0`：startRun 体包 try/finally，finally 无条件 delete。（runService.ts 属 prior commit，但 real HIGH，同 feature 分支内修。）

#### 🟡 MED ×4 — abort 被压成 DOMAIN_ERROR（R1 回归）/ 同 provider override 仍丢 baseUrl / currentToolCallId 经 spread 泄漏 / 加固只做一半（canUseTool·buildLegacyCtx·onProgress 仍能打穿，throwing onProgress 把成功翻失败）
**Resolution**: ✅ `63104de0`：isAbort()→ABORTED；baseUrl 独立继承（空串算缺失）；null currentToolCallId；顶层 try/catch + safeProgress best-effort。
**Codex 确认**: schema-path（runForcedStructured）无同类泄漏（自建 messages，不走 deriveSubagentContext）。

### Round 3（收敛中）

#### 🟡 MED — child toolContext.abortSignal 仍是父 signal（两层不一致）
**Finding**: `...legacyCtx` 带下父 ctx.abortSignal，与 SubagentContext.abortSignal（per-call signal）不一致；下游工具读 toolContext.abortSignal 会绕过 child-scoped cancel/timeout。
**Resolution**: ✅ `410857c7`：toolContext 也覆写 `abortSignal: signal`。
**Codex 诚实否掉 3 个疑点**：try/finally 无新回归（thrown-path 'running' 只是未返回的本地快照）；isAbort cancel-优先与 runService `aborted?'cancelled':'failed'` 口径一致；||vs?? 仅在配置契约定义空串语义时才成立，证据不足。

### Round 4（最后一轮，MAX）

#### 🟡 MED — resolveModelConfig 用 override.provider===base 作继承条件
**Finding**: 只改 model 不带 provider 的同 provider override 会跳过继承。
**Resolution**: ✅ `a8556d87`：`effectiveProvider = override.provider ?? base.provider`。ℹ️ 注：`AgentCallOptions.model` 类型 provider 必填，此为 type-impossible 的防御性加固。

#### 🟢 LOW — 成功路径 JSON.stringify 可抛（BigInt/循环引用）→ 误包 DOMAIN_ERROR
**Resolution**: ✅ `a8556d87`：序列化单独 try/catch + safe fallback。

## Deferred Items（runtime 层，prior commits，非本 wiring scope）

- **硬沙箱隔离（isolated-vm）**：worker eval 非对抗安全边界。已在 P2 计划 + sandbox.ts 注释声明。脚本是模型生成的半信任代码（非攻击者），worker 提供线程隔离+内存上限+timeout 兜底。
- **parallel/pipeline 把异常吞成 null**：CC dynamic-workflow 同款语义（by-design，Claude Code Workflow 文档明写 "thunk that throws resolves to null"）。sandbox.ts，非 ② scope。
- **forced-schema 在 agentBridge 无校验**：runForcedStructured 把模型给的 schema 直传 ToolDefinition.inputSchema。runtime 层加固项，agentBridge.ts（prior commit）。

## Convergence Analysis

4 轮严重度单调下降（2H→1H→0H→0H；MED 6→4→1→1），且 R3/R4 艾克斯主动声明"不凑"并诚实否掉多个疑点 —— 这是真收敛信号而非跑满。**符合 Felix 理论：Round 2 的 5 个发现全是 symmetric application 类**（R1 修了 startRun 抛错却漏了 runService 自身的 activeRuns 清理；修了 history 字段却漏了 currentToolCallId/abortSignal 这两个同属 call-scoped 的兄弟字段；修了 startRun 的 try/catch 却漏了 canUseTool/onProgress 同级入口）。教训：**下次 R1 修 context 派生/错误兜底时，第一时间枚举所有 call-scoped 字段 + 所有可抛的 await 入口**，别只修被点名的那一个。

Round 1 的 sandbox HIGH 是唯一"看起来吓人但实为已知 deferred"的发现，0 假阳性其余全是真 actionable bug —— 艾克斯 gpt-5.4 这轮审得很准。
