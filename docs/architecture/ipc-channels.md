# IPC 通道架构

> 主进程与渲染进程之间的通信协议

## 概述

Code Agent 使用类型安全的 IPC 通道进行 Electron 主进程和渲染进程之间的通信。采用领域驱动的通道设计，每个业务领域对应一个独立通道。

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

| 序号 | 通道名称 | 文件位置 | 主要功能 |
|------|---------|---------|---------|
| 1 | `domain:agent` | agent.ipc.ts | Agent 消息和控制 |
| 2 | `domain:session` | session.ipc.ts | 会话管理 |
| 3 | `domain:generation` | generation.ipc.ts | 代际管理 |
| 4 | `domain:auth` | auth.ipc.ts | 身份认证 |
| 5 | `domain:sync` | sync.ipc.ts | 数据同步 |
| 6 | `domain:device` | sync.ipc.ts | 设备管理 |
| 7 | `domain:cloud` | cloud.ipc.ts | 云端任务 |
| 8 | `domain:workspace` | workspace.ipc.ts | 工作区管理 |
| 9 | `domain:settings` | settings.ipc.ts | 应用设置 |
| 10 | `domain:window` | settings.ipc.ts | 窗口控制 |
| 11 | `domain:update` | update.ipc.ts | 版本更新 |
| 12 | `domain:mcp` | mcp.ipc.ts | MCP 客户端 |
| 13 | `domain:memory` | memory.ipc.ts | 记忆系统 |
| 14 | `domain:planning` | planning.ipc.ts | 计划管理 |
| 15 | `domain:data` | data.ipc.ts | 数据缓存管理 |

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
| `export` | `{ sessionId: string }` | `SessionExport` | 导出会话 |
| `import` | `{ data: unknown }` | `string` | 导入会话 |

### Generation 通道 (`domain:generation`)

| Action | Payload | 响应 | 说明 |
|--------|---------|------|------|
| `list` | - | `Generation[]` | 列出所有代际 |
| `switch` | `{ id: GenerationId }` | `Generation` | 切换代际 |
| `getPrompt` | `{ id: GenerationId }` | `string` | 获取 Prompt |
| `compare` | `{ id1, id2 }` | `GenerationDiff` | 对比代际 |
| `getCurrent` | - | `Generation` | 获取当前代际 |

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

### 切换代际示例

```typescript
const result = await window.domainAPI.invoke('domain:generation', 'switch', {
  id: 'gen4',
});
```

---

## 文件结构

```
src/main/ipc/
├── index.ts           # IPC 初始化入口
├── agent.ipc.ts       # Agent 通道
├── session.ipc.ts     # Session 通道
├── generation.ipc.ts  # Generation 通道
├── auth.ipc.ts        # Auth 通道
├── sync.ipc.ts        # Sync + Device 通道
├── cloud.ipc.ts       # Cloud 通道
├── workspace.ipc.ts   # Workspace 通道
├── settings.ipc.ts    # Settings + Window 通道
├── update.ipc.ts      # Update 通道
├── mcp.ipc.ts         # MCP 通道
├── memory.ipc.ts      # Memory 通道
├── planning.ipc.ts    # Planning 通道
└── data.ipc.ts        # Data 通道

src/shared/
└── ipc.ts             # 类型定义
```

---

## 注意事项

1. **类型安全**: 所有通道都有 TypeScript 类型定义
2. **错误处理**: 使用统一的 IPCResponse 格式
3. **向后兼容**: 旧版 Legacy API 仍可用，但标记为 @deprecated
