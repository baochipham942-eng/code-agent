# TASK-04: 接口规范化

> 负责 Agent: Agent-Refactor
> 优先级: P1
> 预估时间: 1 周
> 依赖: TASK-03 完成
> 状态: 待执行

---

## 目标

1. IPC 通道从 70+ 个聚合为 ~15 个领域通道
2. 云端 API 添加版本号 `/api/v1/`
3. 类型定义从单文件拆分为按领域组织

---

## 前置检查

开始前确认：
- [ ] TASK-03 (主进程重构) 已完成
- [ ] `src/main/ipc/` 目录结构已就位
- [ ] `npm run typecheck` 通过

---

## 任务清单

### 4.1 IPC 通道聚合

**目标**: 从 70+ 个独立通道聚合为领域模式

**现状**:
```typescript
// 70+ 个独立通道
ipcMain.handle('agent:send-message', ...)
ipcMain.handle('agent:cancel', ...)
ipcMain.on('agent:event', ...)
ipcMain.handle('session:list', ...)
ipcMain.handle('session:create', ...)
// ...
```

**改造后**:
```typescript
// 15 个领域通道
ipcMain.handle('agent', (event, { action, ...payload }) => {
  switch (action) {
    case 'send': return handleAgentSend(payload);
    case 'cancel': return handleAgentCancel(payload);
    // ...
  }
});

ipcMain.handle('session', (event, { action, ...payload }) => {
  switch (action) {
    case 'list': return handleSessionList(payload);
    case 'create': return handleSessionCreate(payload);
    // ...
  }
});
```

**新增文件**:
- `src/shared/ipc/protocol.ts`

**协议定义**:
```typescript
// src/shared/ipc/protocol.ts

// 请求格式
interface IPCRequest<T = unknown> {
  action: string;
  payload: T;
  requestId?: string;  // 用于追踪
}

// 响应格式
interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// 通道定义
type IPCChannels = {
  agent: 'send' | 'cancel' | 'retry';
  session: 'list' | 'create' | 'load' | 'delete' | 'export';
  generation: 'list' | 'switch' | 'getPrompt' | 'getDiff';
  auth: 'login' | 'logout' | 'getStatus' | 'refresh';
  sync: 'start' | 'stop' | 'getStatus' | 'resolveConflict';
  cloud: 'refreshConfig' | 'getFlags' | 'submitTask';
  workspace: 'open' | 'close' | 'getCurrent' | 'getRecent';
  settings: 'get' | 'set' | 'reset';
  update: 'check' | 'download' | 'install';
  mcp: 'call' | 'listTools' | 'listResources' | 'getStatus';
  tool: 'execute' | 'cancel' | 'getHistory';
  todo: 'list' | 'create' | 'update' | 'delete';
  memory: 'store' | 'search' | 'delete';
  permission: 'request' | 'respond';
  window: 'minimize' | 'maximize' | 'close' | 'setSize';
};
```

**步骤**:
- [ ] 创建 `src/shared/ipc/protocol.ts`
- [ ] 修改 `src/main/ipc/*.ipc.ts`，实现新协议
- [ ] 旧通道保留并标记 `@deprecated`（兼容期 2 个版本）
- [ ] 修改 `src/preload/index.ts`，暴露新 API
- [ ] 修改渲染进程调用方式

**preload 暴露 API**:
```typescript
// src/preload/index.ts
contextBridge.exposeInMainWorld('api', {
  // 新 API
  invoke: <T>(channel: keyof IPCChannels, action: string, payload?: unknown): Promise<T> => {
    return ipcRenderer.invoke(channel, { action, payload });
  },

  // 旧 API (deprecated)
  sendMessage: (content: string) => ipcRenderer.invoke('agent:send-message', content),
  // ...
});
```

**渲染进程调用**:
```typescript
// 旧方式
const sessions = await window.api.listSessions();

// 新方式
const sessions = await window.api.invoke<Session[]>('session', 'list');
```

---

### 4.2 云端 API 版本化

**目标**: 所有 API 添加 `/v1/` 版本前缀

**当前**:
```
/api/prompts
/api/agent
/api/sync
/api/auth
/api/update
/api/tools
```

**改造后**:
```
/api/v1/config    # 合并 prompts
/api/v1/agent
/api/v1/sync
/api/v1/auth
/api/v1/update
/api/v1/tools
```

**步骤**:
- [ ] 创建 `vercel-api/api/v1/` 目录
- [ ] 迁移现有端点到 v1 目录
- [ ] 旧端点添加 301 重定向
- [ ] 客户端 `CloudConfigService` 等更新端点地址
- [ ] 更新 `CLAUDE.md` 中的 API 文档

**重定向示例**:
```typescript
// vercel-api/api/prompts.ts
export default function handler(req, res) {
  const newUrl = `/api/v1/config${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
  res.redirect(301, newUrl);
}
```

---

### 4.3 类型定义拆分

**目标**: 将 684 行的 `types.ts` 拆分为按领域组织

**当前**: `src/shared/types.ts` (684 行)

**目标结构**:
```
src/shared/types/
├── index.ts          # 重导出（保持兼容）
├── generation.ts     # GenerationId, Generation, GenerationDiff
├── model.ts          # ModelProvider, ModelConfig, ModelInfo
├── message.ts        # Message, MessageRole, MessageAttachment
├── tool.ts           # ToolDefinition, ToolContext, ToolResult
├── permission.ts     # PermissionRequest, PermissionResponse
├── session.ts        # Session, SessionExport
├── planning.ts       # TaskPlan, TodoItem, Finding, ErrorRecord
├── agent.ts          # AgentConfig, AgentState, AgentEvent
├── auth.ts           # AuthUser, AuthStatus
├── sync.ts           # SyncStatus, SyncConflict
├── settings.ts       # AppSettings
├── cloud.ts          # 已存在，保留
└── ui.ts             # DisclosureLevel, Language
```

**步骤**:
- [ ] 创建 `src/shared/types/` 目录
- [ ] 分析 `types.ts` 中的类型，按领域归类
- [ ] 创建 14 个领域文件
- [ ] 处理类型间依赖（import）
- [ ] 原 `types.ts` 改为重导出（兼容）：
  ```typescript
  // src/shared/types.ts
  export * from './types/generation';
  export * from './types/model';
  export * from './types/message';
  // ...
  ```
- [ ] `npm run typecheck` 确保无错误

---

## 涉及文件汇总

| 操作 | 文件 |
|------|------|
| 新增 | `src/shared/ipc/protocol.ts` |
| 修改 | `src/main/ipc/*.ipc.ts` (10 个) |
| 修改 | `src/preload/index.ts` |
| 新增 | `vercel-api/api/v1/*.ts` (6 个) |
| 修改 | `vercel-api/api/*.ts` (添加重定向) |
| 新增 | `src/shared/types/*.ts` (14 个) |
| 修改 | `src/shared/types.ts` (改为重导出) |

---

## 禁止修改

- 文件重命名（由 TASK-05 统一处理）
- 工具实现逻辑（只改接口和类型）

---

## 验收标准

- [ ] IPC 通道数从 70+ 降到 ~15 个
- [ ] 旧 IPC 通道仍可用（兼容）
- [ ] 所有云端 API 带 `/v1/` 前缀
- [ ] 旧 API 返回 301 重定向
- [ ] 类型定义按领域拆分为 14 个文件
- [ ] `npm run typecheck` 通过

---

## 交接备注

_（任务完成后填写）_

- 完成时间:
- 新 IPC 协议文档:
- 新 API 端点列表:
- 类型文件对照表:
- 下游 Agent 注意事项:
