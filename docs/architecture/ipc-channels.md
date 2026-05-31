# IPC 通道架构

> 主进程与渲染进程之间的通信协议

## 概述

Code Agent 使用类型安全的 IPC 通道进行 Electron 主进程和渲染进程之间的通信。采用领域驱动的通道设计，每个业务领域对应一个独立通道。

2026-05 起，热路径开始迁到 zod schema 校验：

| 层 | 文件 | 说明 |
|----|------|------|
| schema | `src/shared/ipc/schemas/` | 定义 payload / response zod schema |
| main handler | `src/main/platform/ipcRegistry.ts` | `defineHandler(schema, handler)` 注册时做 payload 校验 |
| renderer | `src/renderer/services/typedInvoke.ts` | dev 模式校验 response，避免 renderer 误读 |
| Web HTTP | `src/web/helpers/typedBody.ts` | Express body 用 `parseBody(req, schema)` 校验 |

当前只有部分 domain / legacy channel 已迁移，未迁移通道仍走 `window.domainAPI.invoke` 或 legacy `ipcService.invoke`。

## 协议格式

### 请求格式 (IPCRequest)

```typescript
interface IPCRequest<T = unknown> {
  action: string;        // 动作名称
  payload?: T;           // 请求数据（可选）
  requestId?: string;    // 请求 ID（可选，用于追踪）
}
```

### 响应格式 (IPCResponse)

```typescript
interface IPCResponse<T = unknown> {
  success: boolean;      // 是否成功
  data?: T;              // 响应数据
  error?: {
    code: string;        // 错误代码
    message: string;     // 错误信息
    details?: unknown;   // 错误详情（可选）
  };
}
```

### 错误代码

| 代码 | 说明 |
|------|------|
| `INVALID_ACTION` | 未知的 action |
| `INTERNAL_ERROR` | 内部错误 |
| `UNAUTHORIZED` | 未授权 |
| `NOT_FOUND` | 资源不存在 |

---

## 领域通道列表

| 通道名称 | 文件位置 | 主要功能 |
|---------|---------|---------|
| `domain:agent` | agent.ipc.ts | Agent 消息和控制 |
| `domain:session` | session.ipc.ts | 会话管理、Prompt Rewind |
| `domain:auth` | auth.ipc.ts | 身份认证 |
| `domain:sync` | sync.ipc.ts | 数据同步 |
| `domain:device` | sync.ipc.ts | 设备管理 |
| `domain:cloud` | historical / retired | 旧 cloud task 入口已退役；当前 cloud config/update/feature flag 在 services 层 |
| `domain:workspace` | workspace.ipc.ts | 工作区管理 |
| `domain:settings` | settings.ipc.ts | 应用设置 |
| `domain:window` | settings.ipc.ts | 窗口控制 |
| `domain:update` | update.ipc.ts | 版本更新 |
| `domain:mcp` | mcp.ipc.ts | MCP 客户端 |
| `domain:connector` | connector.ipc.ts | Calendar/Mail/Reminders 等连接器 |
| `domain:memory` | memory.ipc.ts | 记忆系统 |
| `domain:planning` | planning.ipc.ts | 计划管理 |
| `domain:data` | data.ipc.ts | 数据缓存与调试快照 |
| `domain:task` | task.ipc.ts | 多任务并行 |
| `domain:diff` | diff.ipc.ts | 变更追踪 |
| `domain:error` | error.ipc.ts | 错误与诊断 |
| `domain:cron` | cron.ipc.ts | 定时任务与心跳 |
| `domain:capture` | capture.ipc.ts | 浏览器采集 |
| `domain:desktop` | desktop.ipc.ts | 原生桌面活动 |
| `domain:activity` | activity.ipc.ts | Activity Providers 聚合 |
| `domain:soul` | soul.ipc.ts | 身份/偏好配置 |
| `domain:provider` | provider.ipc.ts | Provider 连通性与诊断 |
| `domain:livePreview` | livePreview.ipc.ts | Live Preview + click-to-source |
| `domain:openchronicle` | openchronicle.ipc.ts | 外部 OpenChronicle daemon |
| `domain:prompt` | prompt.ipc.ts | Prompt Registry 查看、override、debug system prompt |
| `domain:hook` | hook.ipc.ts | Hook 配置摘要、启用状态、配置文件打开/定位 |
| ~~`evaluation:delivery-review:run`~~ | 已下线 | 5/19 随 evaluation 子系统删除；Workspace Preview 不再触发旧 Delivery Review |
| `workflow:*` | workflow.ipc.ts | Dynamic Workflow 运行进度 + 跑前审批（专用 bridge，run/launch 双通道）|

---

## 通道详情

### Agent 通道 (`domain:agent`)

| Action | Payload | 响应 | 说明 |
|--------|---------|------|------|
| `send` | `{ content: string; attachments?: unknown[] }` | `null` | 发送消息给 Agent |
| `cancel` | - | `null` | 取消当前任务 |
| `permissionResponse` | `{ requestId: string; response: PermissionResponse }` | `null` | 响应权限请求 |

### Session 通道 (`domain:session`)

| Action | Payload | 响应 | 说明 |
|--------|---------|------|------|
| `list` | - | `Session[]` | 列出所有会话 |
| `create` | `{ title?: string }` | `Session` | 创建新会话 |
| `load` | `{ sessionId: string }` | `Session` | 加载会话 |
| `delete` | `{ sessionId: string }` | `null` | 删除会话 |
| `getMessages` | `{ sessionId: string }` | `Message[]` | 获取消息 |
| `rewindToPrompt` | `{ sessionId: string; userMessageId: string }` | `PromptRewindResult` | 回到某条用户提示词：隐藏后续 active 消息、恢复文件 checkpoint、回填输入草稿 |
| `export` | `{ sessionId: string }` | `SessionExport` | 导出会话 |
| `import` | `{ data: unknown }` | `string` | 导入会话 |

### Prompt 通道 (`domain:prompt`)

| Action | Payload | 响应 | 说明 |
|--------|---------|------|------|
| `list` | - | `PromptDescriptor[]` | 列出已注册 prompt，不返回全文 |
| `get` | `{ id: string }` | `PromptDetail \| null` | 获取默认文本、override 和状态 |
| `set` | `{ id: string; text: string }` | `PromptDetail` | 保存 override 到 `~/.code-agent/prompts-overrides/<id>.md` |
| `reset` | `{ id: string }` | `PromptDetail` | 删除 override，恢复默认 |
| `preview` | `{ id: string }` | `{ id, live, length }` | 读取当前生效文本，用于实时性验证 |
| `debugSystemPrompt` | - | `{ length, preview, text }` | 实际构建一次完整 system prompt |

### Hook 通道 (`domain:hook`)

| Action | Payload | 响应 | 说明 |
|--------|---------|------|------|
| `list` | - | `HookSummary` | 汇总 enabled hooks、unused events、global/project config paths |
| `openConfigFile` | `{ filePath: string }` | `{ opened: string }` | 不存在时创建空模板并打开 |
| `revealConfigFolder` | `{ filePath: string }` | `{ revealed: string }` | 在 Finder 中定位配置文件 |

### Auth 通道 (`domain:auth`)

| Action | Payload | 响应 | 说明 |
|--------|---------|------|------|
| `getStatus` | - | `AuthStatus` | 获取认证状态 |
| `signInEmail` | `{ email, password }` | 用户对象 | 邮箱登录 |
| `signUpEmail` | `{ email, password, inviteCode? }` | 用户对象 | 邮箱注册 |
| `signInOAuth` | `{ provider }` | `null` | OAuth 登录 |
| `signOut` | - | `null` | 登出 |
| `getUser` | - | `AuthUser \| null` | 获取当前用户 |

### Settings 通道 (`domain:settings`)

| Action | Payload | 响应 | 说明 |
|--------|---------|------|------|
| `get` | - | `AppSettings` | 获取设置 |
| `set` | `{ settings: Partial<AppSettings> }` | `null` | 更新设置 |
| `testApiKey` | `{ provider, apiKey }` | `{ success, error? }` | 测试 API Key |
| `getDevMode` | - | `boolean` | 获取开发模式 |
| `setDevMode` | `{ enabled }` | `null` | 设置开发模式 |

### MCP 通道 (`domain:mcp`)

| Action | Payload | 响应 | 说明 |
|--------|---------|------|------|
| `getStatus` | - | MCP 状态 | 获取连接状态 |
| `listTools` | - | 工具列表 | 列出所有工具 |
| `listResources` | - | 资源列表 | 列出所有资源 |
| `setServerEnabled` | `{ serverName, enabled }` | `{ success }` | 启用/禁用服务器 |
| `reconnectServer` | `{ serverName }` | `boolean` | 重新连接 |

### Workflow 通道 (`workflow.ipc.ts`)

Dynamic Workflow（命令式脚本运行时，见 [dynamic-workflow.md](./dynamic-workflow.md)）用**专用 bridge** 推送，因 webServer 不起通用 EventBridge（与 swarm 同款坑）。bridge 按 `BusEvent.type` 前缀路由：`launch:*`（审批事件）→ launch 通道，其余（run 事件）→ run 通道。

| 通道常量 | 字符串 | 方向 | Payload | 说明 |
|---------|--------|------|---------|------|
| `WORKFLOW_EVENT` | `workflow:event` | 推 → renderer | `ScriptRunEvent` | run 进度：`run:start/phase/log`、`agent:start/done/error`、`run:done/error` |
| `WORKFLOW_LAUNCH_EVENT` | `workflow:launch:event` | 推 → renderer | `WorkflowLaunchEvent` | 跑前审批卡（phases/扇出/写提示 + 4 维度成本）|
| `WORKFLOW_APPROVE_LAUNCH` | `workflow:approve-launch` | renderer → main | `{ requestId, feedback?, sessionId? }` | 批准启动 |
| `WORKFLOW_REJECT_LAUNCH` | `workflow:reject-launch` | renderer → main | `{ requestId, feedback, sessionId? }` | 拒绝启动 |
| `WORKFLOW_CANCEL_RUN` | `workflow:cancel-run` | renderer → main | `{ runId, sessionId? }` | 取消 workflow run，带 sessionId 时做授权约束 |

> 事件契约 `ScriptRunEvent` / `WorkflowLaunchEvent` 定义在 `src/shared/contract/scriptRun.ts`，renderer+main 共用；renderer 侧 `workflowStore` 按 `runId` 分桶折叠成进度树。

---

## 调用示例

### 渲染进程调用

```typescript
// 使用 Domain API（推荐）
const response = await window.domainAPI.invoke<Session[]>(
  'domain:session',
  'list'
);

if (response.success) {
  console.log('Sessions:', response.data);
} else {
  console.error('Error:', response.error?.message);
}
```

### 发送消息示例

```typescript
await window.domainAPI.invoke('domain:agent', 'send', {
  content: '帮我创建一个 React 组件',
  attachments: [],
});
```

---

## 文件结构

```
src/main/ipc/
├── index.ts           # IPC 初始化入口
├── agent.ipc.ts       # Agent 通道
├── session.ipc.ts     # Session 通道
├── auth.ipc.ts        # Auth 通道
├── sync.ipc.ts        # Sync + Device 通道
├── cloud.ipc.ts       # Cloud 通道
├── workspace.ipc.ts   # Workspace 通道
├── settings.ipc.ts    # Settings + Window 通道
├── update.ipc.ts      # Update 通道
├── mcp.ipc.ts         # MCP 通道
├── memory.ipc.ts      # Memory 通道
├── planning.ipc.ts    # Planning 通道
├── prompt.ipc.ts      # Prompt 管理通道
├── hook.ipc.ts        # Hook 管理通道
├── workflow.ipc.ts    # Dynamic Workflow run/launch 专用 bridge
└── data.ipc.ts        # Data 通道

src/shared/
└── ipc.ts             # 类型定义
```

---

## 注意事项

1. **类型安全**: 所有通道都有 TypeScript 类型定义
2. **错误处理**: 使用统一的 IPCResponse 格式
3. **向后兼容**: 旧版 Legacy API 仍可用，但标记为 @deprecated
