# Codex Fix Scope Evaluation — 2026-05-28
Worktree: `swarm-jsonl-round2`
Branch: `audit/round-2-scope-eval` (= `feat/swarm-trace-jsonl` + Codex `stash@{0}`)
Evaluator: feature-dev:code-explorer subagent (round2-scope-eval)
Leader spot-check: 3 key citations verified

## TL;DR

| Q | 文件 | 判定 |
|---|---|---|
| Q1 | `legacyAdapter.ts` (+1/-1) + `shadowAdapter.test.ts` (+29) | **REAL_BUG** — Codex 改动正确,但应走 Independent PR 不进 Phase 3.5 |
| Q2 | `deferredToolPreload.ts` (+7) + `deferredToolPreload.test.ts` (+19) | **SCOPE_DRIFT** — Reset |

附带发现:`src/main/tools/modules/document/docEdit.ts:105` 同 bug pattern,该顺手修。

---

## Q1 — legacyAdapter event 契约改动

### 改动方向

`buildLegacyCtxFromProtocol` 里的 `wrapEmit` 把 legacy `(event: string, data: unknown)` 调用 forward 到 protocol `ctx.emit(AgentEvent)`:

- **改前(legacyAdapter.ts:65-67)**:`ctx.emit({ type: event, ...((data && typeof data === 'object') ? data : { data }) } as never)` —— flat spread,生成的对象没有 `data` 字段
- **改后**:`ctx.emit({ type: event, data } as never)` —— nested,符合协议

### 协议契约

`src/shared/contract/agent.ts:219` 定义 AgentEvent 是 nested 形状:

```ts
export type AgentEvent =
  | { type: 'message'; data: Message }
  | { type: 'tool_call_start'; data: ToolCall & {...} }
  | { type: 'tool_call_end'; data: ToolResult & {...} }
  | { type: 'permission_request'; data: PermissionRequest }
  | { type: 'hook_trigger'; data: HookTriggerEventData }
  | { type: 'error'; data: { message: string; ... } }
```

主路径 `toolExecutionEngine.ts:659` 也是 nested:
```ts
emitEvent: (event: string, data: unknown) =>
  this.ctx.onEvent({ type: event, data, sessionId: this.ctx.sessionId } as AgentEvent)
```

### 消费者 × 期望形状对照表

| 消费者 file:line | 读取方式 | 期望形状 | 改前 emit 形状 | 匹配? |
|---|---|---|---|---|
| `src/main/channels/channelAgentBridge.ts:361` | `event.data.name` | nested | flat | ❌ |
| `src/cli/adapter.ts:242` | `event.data as {name?, ...}` | nested | flat | ❌ |
| `src/cli/output/terminal.ts:647` | `event.data.message` | nested | flat | ❌ |
| `src/main/testing/agentAdapter.ts:371` | `event.data.name` | nested | flat | ❌ |
| `src/main/task/TaskManager.ts:890` | `event.data.toolCallId` | nested | flat | ❌ |
| `src/renderer/hooks/agent/effects/useToolExecutionEffects.ts:74` | `event.data.name` | nested | flat | ❌ |

注意:**主路径**(`toolExecutionEngine`)输出 nested 是对的,所以主流工具不受影响。
**只有走 `buildLegacyCtxFromProtocol` 路径的工具**才命中这个 bug。

### 实际活跃受影响

`buildLegacyCtxFromProtocol` 调用方共 11 处,grep 各调用方的 legacy 实现里是否真有 `(event, data)` emit 调用:

- ✅ **`src/main/tools/vision/screenshot.ts:207`** — 唯一活跃 case
  ```ts
  context.emit?.('tool_output', {
    tool: 'screenshot',
    message: '🔍 正在分析截图内容...',
  });
  ```
  调用链:`plugins/builtin/computerUse/screenshot.ts:42` → `screenshotTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool))` → wrapEmit
  改前消费者 `terminal.ts:647` 读 `event.data.message` 拿 undefined,**进度通知静默失效**

- ❌ `src/main/tools/media/ppt/mermaid.ts:45` — `autoProcessMermaid` 无任何调用方(死代码)
- ❌ `src/main/tools/shell/gitWorktree.ts:125` — 旧 `gitWorktreeTool` 已被 native ToolModule 替换,不再走 legacy 路径
- ❌ spawnAgent / task / browser / 其余调用方 — 走 `buildLegacyCtxFromProtocol` 但其 legacy 实现不调 `context.emit(string, data)` 形式

### 判定:**REAL_BUG**

Codex 改动方向正确。bug 真实但影响范围小(仅截图工具的分析进度通知,不影响主功能)。

### 附带发现(超出 4 文件 scope)

`src/main/tools/modules/document/docEdit.ts:103-107` 有同一 bug pattern:

```ts
const wrapEmit = (event: string, data: unknown) => {
  ctx.emit({ type: event, ...((data && typeof data === 'object') ? data : { data }) } as never);
};
```

这是 docEdit 里的 **local** `buildDispatchLegacyCtx`,跟全局 `buildLegacyCtxFromProtocol` 是两份独立实现。应在 independent PR 里顺手修。

### 建议:**Independent PR**(不进 Phase 3.5)

范围:
1. `legacyAdapter.ts` Codex 改动保留(已正确)
2. `shadowAdapter.test.ts` 新测试保留(随 legacyAdapter PR 合)
3. **顺手修** `docEdit.ts:105` 的同一 pattern flat-spread
4. PR 描述列出 11 个 `buildLegacyCtxFromProtocol` 调用方,说明实际活跃受影响只有 screenshot

风险:低。改动只影响进度通知 UX,不影响工具主功能。
不放进 Phase 3.5 的理由:跟 swarm-jsonl 完全无关,放进去会污染 swarm PR 的 scope。

---

## Q2 — deferredToolPreload AgentSpawn 自动加载

### 改动内容

`src/main/agent/runtime/contextAssembly/deferredToolPreload.ts:21-22` 新增正则:

```ts
const MULTIAGENT_INTENT_RE =
  /\bAgentSpawn\b|\bspawn_agent\b|\bmulti[\s-]?agent\b|\bsub[\s-]?agent\b|\bparallel\s+agents?\b|\bTask\s+tool\b|多代理|多智能体|子代理|派\s*agent|派.*子代理|并行.*agent/i;
```

用户 prompt 命中关键词时,getDeferredToolsToPreloadForTurn 自动 preload `AgentSpawn`。

### audit 报告里对应 finding?

**没有**。

audit Section A Notes 写:
> "A file-mode first attempt did not call AgentSpawn; it used TaskManager/direct tools and produced no JSONL. The passing B run used a stricter prompt that forced ToolSearch select:AgentSpawn before AgentSpawn."

audit Section D 列出的 bug 只有:
- HIGH: CLI `exec` 命令不存在
- MED: webServer DB 路径与任务 hint 不符

Codex 自己把"更严格 prompt"当作可接受方案接受了,**没列为 wiring bug**。

### Phase 3 wiring 本身有问题吗?

没有。E2E B/C pass 证明 AgentSpawn 工具链路正常。问题是 AgentSpawn 作为 deferred 工具默认不在上下文,模型不主动 ToolSearch 解锁。这是**发现性问题**,不是 wiring 漏洞。

### 误触发分析

跟现有 3 条 intent regex(`COMPUTER_INTENT_RE` / `MEETING_DESKTOP_CONTEXT_RE` / `BROWSER_INTERACTIVE_INTENT_RE`)无关键词重叠。

但关键词清单本身有问题:
- `Task tool` 偏宽 — 用户讨论 Task 工具本身就会误触发
- `sub-agent` / `multi-agent` — 架构讨论中高频,可能不必要地把 AgentSpawn 塞进上下文

### 判定:**SCOPE_DRIFT**

理由:
1. audit 没列为 finding,Codex 把"prompt 解决方案"擅自固化为代码改动
2. Phase 3 wiring 已正常工作,改动是 UX 改进不是修复
3. 超出 swarm-jsonl Phase 3.5 的 "CLI 接 file 后端 + DATA_DIR + replace 语义" 范围

### 建议:**Reset**

如果 leader 认为 AgentSpawn 发现性值得改进:
- 独立 PR 评估
- 精简关键词清单(`Task tool` 删掉,`sub-agent` 改更具体)
- 跟"deferred 工具发现性"这个产品问题一起讨论

---

## 总体建议

| 文件 | 判定 | 去留 |
|---|---|---|
| `src/main/tools/modules/_helpers/legacyAdapter.ts` (+1/-1) | REAL_BUG | **Keep → Independent PR** |
| `tests/unit/tools/shadowAdapter.test.ts` (+29) | 对应 legacyAdapter 测试 | **Keep → 随 legacyAdapter PR 合** |
| `src/main/agent/runtime/contextAssembly/deferredToolPreload.ts` (+7) | SCOPE_DRIFT | **Reset** |
| `tests/unit/agent/deferredToolPreload.test.ts` (+19) | 对应测试 | **Reset(随上一个)** |

### Phase 3.5 现状

不受本次评估影响。`feat/swarm-trace-jsonl @ 291859ef` 5 commit 已经完整可推 PR。

### Independent PR(legacyAdapter)的范围

- 核心改动:`legacyAdapter.ts` 1 行(已正确)
- 附带修:`docEdit.ts:105` 同 pattern flat-spread
- 测试:`shadowAdapter.test.ts` 新 test case
- 范围风险:低 — 改动只影响进度通知 UX,11 个 `buildLegacyCtxFromProtocol` 调用方里只有 screenshot 真受影响
- PR 描述应该列出 grep 过程让 reviewer 能复现

---

## 关键文件引用(grep 实测)

- `src/main/tools/modules/_helpers/legacyAdapter.ts:65-67` — Codex 改后 wrapEmit
- `src/main/agent/runtime/toolExecutionEngine.ts:659` — 主路径 emitEvent 基准
- `src/shared/contract/agent.ts:219` — AgentEvent nested 契约
- `src/main/tools/vision/screenshot.ts:207` — 唯一活跃 flat-emit bug case(确认 grep)
- `src/main/tools/modules/document/docEdit.ts:103-107` — 附带发现同 pattern bug(确认 grep)
- `src/main/plugins/builtin/computerUse/screenshot.ts:42` — screenshot wrapper 入口
- `src/main/agent/runtime/contextAssembly/deferredToolPreload.ts:21-22` — MULTIAGENT_INTENT_RE 改动
- `docs/audits/2026-05-28-swarm-jsonl-e2e-codex.md` — Codex audit 原报告(对照确认无 MULTIAGENT finding)
