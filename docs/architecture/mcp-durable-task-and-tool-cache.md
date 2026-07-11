# MCP Durable Task 与安全 ToolCache

## 交付边界

本切片在 Host 内导出 MCP Durable Task controller、SDK protocol adapter、现有
`RunKernelAdapter` 的 checkpoint adapter，以及接收 `RunRehydrationPlan` 的 recovery handler。
它不修改 Durable Run 公共合同、数据库表、全局 recovery dispatch 或 `webServer` 启动路径。

MCP 长任务继续使用 `PendingOperation.kind = tool_call`。`providerOperationId` 是绑定
`taskId + runId + operationId + serverIdentity` 的校验封套；没有新增 MCP operation kind 或第二套持久化。

## SDK 与协议能力矩阵

锁定依赖为 `@modelcontextprotocol/sdk 1.29.0`。该版本已经实现 experimental Tasks，
无需升级 SDK。

| 能力事实 | SDK 1.29 | Neo 记录位置 | Durable Task 决策 |
|---|---|---|---|
| server `tasks.requests.tools.call` | 支持 | `MCPToolRegistry.serverTaskCapabilities` | 必须声明 |
| tool `execution.taskSupport` | `optional/required/forbidden` | `MCPTool.execution` | `optional/required` 才是候选 |
| `tasks/get` | 支持 | `McpSdkTaskProtocol.getTask` | 有受信 handle 才查询 |
| `tasks/result` | 支持 | `resolveTaskResult` | 只在 completed 后读取一次 |
| `tasks/cancel` | 支持，server capability 单独声明 | registry + protocol adapter | 未声明时拒绝取消 RPC |
| `tasks/list` | 支持，server capability 单独声明 | registry | 本切片不靠 list 恢复单个 operation |
| W3C `_meta` | request params 支持 | create/get/result/cancel adapter | 仅传播 traceparent/tracestate |
| in-process MCP task | 当前接口未实现 | `InProcessMCPServerInterface` | 保持同步，不伪造后台任务 |

server capability、tool execution 字段和 annotations 都是远端声明。Durable Task admission
还要求调用方提供的本地 `trustedServerIdentities` 命中稳定 server fingerprint。缺声明、声明冲突、
server 未受信时都回到现有同步调用；`required` 工具若因信任策略不能启用 task，直接同步调用可能被
server 拒绝，但 Neo 不以伪造后台任务或放宽权限兜底。

## PendingOperation 映射

| 阶段 | Durable fact |
|---|---|
| prepare | `kind=tool_call`、stable idempotency key、SHA-256 `inputDigest`、`prepared` |
| prepare checkpoint | `mcp_task_prepared`，只含 operation/server/tool/digest 元数据 |
| task create | `tools/call` 携带 task creation params；原始参数只进入传输，不进入 checkpoint/trace |
| handle checkpoint | `waiting` + bound `providerOperationId` |
| get/update | `working/input_required -> waiting`；transport 断开保留既有 waiting/unknown |
| terminal | `completed -> succeeded + opaque resultRef`；`failed/cancelled -> failed` |
| cancel | handle 持久记录 cancel-requested，重复取消不再发送第二次 RPC |

task handle 封套带 SHA-256 完整性校验，并在每次 get/update/cancel/result 时同时核对 run、operation、
server identity。旧 run 的 handle 不能更新新 run。原始结果由注入的 `McpTaskResultStore` 保存，
checkpoint 只留不透明 `resultRef`；terminal operation 通过该引用恢复展示，不再查询或执行。

## Recovery handler

`createMcpTaskRecoveryHandler()` 接受 `RunRehydrationPlan`，并要求启动调用方提供
`isMcpOperation` 路由谓词；MCP 与其他 provider 共享 `kind=tool_call`，handler 不得抢占别人的 operation。
它不注册到全局启动流程：

| 现场 | 决策 |
|---|---|
| succeeded + resultRef | 从 `McpTaskResultStore` 加载展示结果后 `reuse_result`；引用失效则 review |
| 有合法 handle 且受信 server 可查询 | 查询原 task；running 继续 observe，terminal 收敛 |
| handle 无效/绑定不符 | operation 标为 failed，run 保持 waiting，`requires_review` |
| dispatch unknown 且无 handle | `requires_review` |
| 无查询能力 | `requires_review` |
| side-effect 不确定 | `retry=false`，不盲重试 |
| 查询时 transport 断开 | 保留 waiting/unknown，继续 observe |

等待集成的接线只有两处：Native/其他 engine 的 MCP dispatch 在拥有 run owner、attempt 和当前 state 后
构造 `createMcpKernelCheckpointPort()` 并注入 durable `McpTaskResultStore`；启动 recovery dispatcher
把 MCP `tool_call` plan 交给导出的 handler。两处都不能绕过现有 owner fencing。

## Trace 与敏感数据

create/get/update/cancel/resolve 各自创建本地 MCP client span。span attributes 只含 action、server
fingerprint 和 operation id digest。SDK adapter 在四类 RPC 的 `_meta` 中仅放 W3C
`traceparent/tracestate`。authorization、cookie、token、raw arguments、task result 不进入 attributes。

## ToolCache allowlist

生产 allowlist 为 `TOOL_CACHE_ALLOWLIST = {}`。本轮没有找到满足全部证明条件的现有工具：

| 候选 | 拒绝证据 |
|---|---|
| Read/read_file | 更新 file-read evidence 与 context-health |
| Bash/Write/Edit | 有直接副作用 |
| Glob/Grep/ListDirectory | 文件系统外部变化未由稳定 data fingerprint/version 覆盖，且 handler lifecycle 尚未证明无副作用 |
| WebFetch/WebSearch | 开放世界数据变化与 provider side effects 未纳入可靠 key |
| MCP tools | annotations/task capability 都是不可信提示，且没有逐工具 lifecycle、version/fingerprint 证明 |

测试专用 policy 只有五项证明全部为 true 才能准入：纯读、无隐藏生命周期副作用、不更新 context
evidence、外部变化已进入 key、结果可安全重放。生产代码不提供测试 fixture policy。

cache namespace 升为 `tool-cache:v3`，旧记录自然失效。完整 key 的 SHA-256 material 包含：tool name、
tool version、canonical args、workspace realpath fingerprint、session、server identity、capability policy
version、cache policy version，以及 data fingerprint 或 TTL bucket。MCP 候选缺 server identity 或
capability policy version时拒绝读写。cache hit 仍追加 execution begin/complete（`status=cached`）并写
`tool.cache_hit=true` 到活动 span。

## 剩余风险

- MCP Tasks 仍是 SDK experimental API，协议字段未来可能变化；升级 SDK 必须重跑能力审计。
- task create 响应返回前崩溃时拿不到 provider handle，只能 requires_review；MCP 当前没有可由 Neo
  指定的标准 idempotency key 来消除这个窗口。
- server identity 是配置元数据的稳定 hash，不含 headers/env secrets；凭据轮换不会误造新 server，
  endpoint/command 改变会产生新 identity 并使旧 handle fail-closed。
- 全局启动 recovery dispatch 尚未接线，本切片刻意不修改冻结的 `webServer`。
