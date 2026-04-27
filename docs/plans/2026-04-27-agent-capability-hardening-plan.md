# Agent 能力产品化加固计划

日期：2026-04-27

范围：当前 `code-agent` 的真实产品运行链路，不以 harness/eval 或 legacy-only 文件作为主判断依据。

## 结论

当前 agent 能力已经不是 demo：标准 chat loop、context assembly、核心 tools、message/tool result 落库、MCP lifecycle、Skill 激活、swarm UI/IPC/trace、standard telemetry 都进了生产链路。

但还不能说是产品级闭环。主要缺口集中在五类：

- 权限边界：legacy wrapper、Skill shell、Bash/native tool、MCP 权限语义没有完全统一。
- 执行断链：MCP dynamic tool 可见但 direct execute 走不到 `MCPClient.callTool`。
- 生命周期：pause/resume/cancel/error 没有统一 terminal state，工具执行也缺 run-level abort。
- multiagent：消息路由、依赖门控、结果归并、run-level cancel 还不可靠。
- 可恢复与可解释：task/todo/context intervention/compact 状态跨重启不完整，auto-agent telemetry 和 replay explainability 不够。

## 优先级

### P0：先修安全和执行硬断点

1. Browser/Computer 内层审批被 wrapper 放行
   - 文件：`src/main/tools/modules/_helpers/legacyAdapter.ts`
   - 证据：`buildLegacyCtxFromProtocol()` 把 `requestPermission` 固定成 `async () => true`。
   - 影响：`browser_action.upload_file`、`computer_use` 的敏感操作二级审批被短路。
   - 最小修复：legacy `requestPermission` 转发到真实 `canUseTool` 或 ToolExecutor permission request。
   - 验证：denied upload 返回 `UPLOAD_FILE_PERMISSION_DENIED`；denied computer action 返回 blocked。

2. Skill `!cmd` 绕过审批执行 shell
   - 文件：`src/main/services/skills/skillRenderer.ts`
   - 证据：`renderSkillContent()` 对 `!cmd` 直接 `execSync()`。
   - 影响：绕过 Bash tool、approval、hooks、audit、blocked command。
   - 最小修复：先禁用 `!cmd` 自动执行，渲染成文本；长期可转成 Bash tool call。
   - 验证：临时 skill 内写 `!touch /tmp/skill-pwned`，调用 Skill 后不能无审批落地。

3. MCP dynamic tool 可见但 direct execute 断链
   - 文件：`src/main/protocol/dispatch/toolResolver.ts`
   - 证据：ToolSearch 会暴露 `mcp__server__tool`，但 `ToolResolver` 只查 protocol registry。
   - 影响：模型看到 MCP tool，却可能执行时报 unknown/not registered。
   - 最小修复：`ToolResolver.getDefinition/execute` 加 MCP dynamic branch，解析后调用 `getMCPClient().callTool(...)`。
   - 验证：ToolSearch 加载 MCP tool 后，`ToolExecutor.execute('mcp__...')` 能产生 `tool_call_end success`。

## 分阶段执行

### 阶段 1：P0 安全与 MCP direct execute

目标：先把“能调用但不安全 / 看得见但跑不了”的硬断点清掉。

改动边界：
- `legacyAdapter.ts`：转发 legacy permission。
- `skillRenderer.ts`：禁掉或改造 `!cmd`。
- `toolResolver.ts`：支持 MCP dynamic definition/execute。

验收：
- Browser/Computer denied path 被真实阻断。
- Skill `!cmd` 不再绕过审批。
- MCP dynamic tool 能通过 ToolExecutor direct execute。

### 阶段 2：tool 权限模型收口

目标：ToolExecutor、ProtocolToolResolver、legacy wrapper 的审批语义一致。

改动边界：
- 统一 `Bash` / `bash` 判断，安全校验、safe command、exec policy 都用 normalized tool name。
- resolver 复用 ToolExecutor 顶层审批结果，避免 native handler 二次审批。
- Skill `allowed-tools` 只对 trusted/builtin skill 自动生效；project skill 扩权必须显式授权。
- MCP annotations 映射到统一 permission model，并统一日志脱敏。

验收：
- `Bash rm -rf /` 被 pre-validation 拦截。
- `Bash git status` safe path 不重复弹审批。
- project skill 写 `allowed-tools: Bash(git:*)` 后不会自动免批。
- MCP read-only/destructive 权限可区分，日志不泄露 token/password/api_key。

### 阶段 3：run lifecycle 单一状态机

目标：send、pause、resume、cancel、error 都有清楚终态。

改动边界：
- `ConversationRuntime.run` 增加统一 terminal path。
- pause 进入等待态，不跑 finalizer、不清空 loop。
- cancel 传递 run-level `AbortSignal` 到 `ToolExecutionEngine -> ToolExecutor -> ToolResolver -> protocol context`。
- desktop chat 和 TaskManager 状态所有权收敛，避免一边 running、一边 idle。

验收：
- pause 后没有 `agent_complete`，resume 继续同一个 loop。
- cancel 长 Bash/http_request 会终止真实执行。
- model 抛异常仍触发 failure finalizer、trace end、相关 hook。
- 同一会话 session status 和 task state 不再漂移。

### 阶段 4：multiagent / swarm 产品化补洞

目标：agent team 的消息、依赖、取消、归并可信。

改动边界：
- `swarm:send-user-message` 路由到 parallel executor inbox，未知 agent 返回 `delivered:false`。
- `dependsOn` 按成功依赖门控，上游失败时下游标 blocked。
- aggregation 按总任务数计算成功率，失败 agent 也进入结果结构。
- stop all 改成 run-level cancel。
- `send_input interrupt=true` 要么实现抢占，要么从 schema 下掉。

验收：
- 给子 agent 发消息，executor 能 drain 到。
- 上游失败，下游不启动。
- 一成一败时 successRate 是 0.5。
- run-level cancel 后 pending agent 不再启动，trace 终态是 cancelled。

### 阶段 5：持久化与恢复

目标：重启后关键状态不静默丢失。

改动边界：
- plan/launch approval orphan 按 `kind` 分区 hydrate。
- `taskStore`、auto todo、context intervention 落 session-scoped SQLite。
- manual compact、compression state、persistent system context 有恢复面。
- running/queued task crash 后标 interrupted/orphaned。

验收：
- 同时存在 plan + launch pending，重启后两条都按 kind 恢复。
- todo/task 重启后仍能出现在 finalizer 和 UI。
- pin/exclude 重启后仍影响 `buildModelMessages()`。
- compact 后 reload session 仍是 compact 后上下文。

### 阶段 6：observability / replay / eval 闭环

目标：不仅知道发生了什么，还能解释为什么这样调用工具。

改动边界：
- auto-agent/subagent 接入 telemetry turn/model/tool rows。
- replay join model_calls、events、tool schema、permission trace、context compression event。
- eval 增加 `real-agent-run` gate，不只看 final string。
- streaming tool call snapshot 持久化，断流标 incomplete。

验收：
- 触发 auto-agent 后 DB 有 subagent model/tool telemetry。
- replay 能展示每次 tool call 前的模型决策和当时 tools/schema。
- eval result 带 `sessionId + replayKey + telemetryCompleteness`。
- 半截 tool arguments 断流后不会被当成稳定完成态执行。

## 新会话推进模板

每轮开新会话可以按这个句式启动：

```text
你在 /Users/linchen/Downloads/ai/code-agent 继续。
先读 docs/plans/2026-04-27-agent-capability-hardening-plan.md。
本轮只做阶段 X：<阶段名>。
先读 active path，再做最小 patch，再跑定向测试。
不要扩大到相邻阶段。
```

推荐顺序：

1. 阶段 1：P0 安全与 MCP direct execute。
2. 阶段 2：tool 权限模型收口。
3. 阶段 3：run lifecycle 单一状态机。
4. 阶段 4：multiagent / swarm 产品化补洞。
5. 阶段 5：持久化与恢复。
6. 阶段 6：observability / replay / eval 闭环。

每轮完成标准：

- 有 active path 文件和行号证据。
- 有最小 patch，不顺手重构无关系统。
- 有定向测试或真实 smoke。
- 明确区分代码接线、自动化测试、真实运行验证。
