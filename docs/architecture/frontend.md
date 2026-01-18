# 前端架构

> React + Zustand + Tailwind CSS

## 关键组件

| 组件 | 文件 | 职责 |
|------|------|------|
| **ChatView** | `ChatView.tsx` | 主聊天视图，渲染消息列表 |
| **ChatInput** | `ChatInput.tsx` | 消息输入框 |
| **MessageBubble** | `MessageBubble.tsx` | 消息气泡 + 工具调用显示 |
| **ToolCallDisplay** | (in MessageBubble) | 工具调用可折叠面板 |
| **Sidebar** | `Sidebar.tsx` | 会话列表 + 搜索 |

## useAgent Hook 事件处理

```typescript
// src/renderer/hooks/useAgent.ts

监听 IPC 事件: agent:event

case 'turn_start':
  // 创建新的 assistant 消息
  addMessage({ id: turnId, role: 'assistant', content: '' });

case 'stream_chunk':
  // 流式追加文本到当前 turn 的消息
  updateMessage(turnId, { content: existing + chunk });

case 'tool_call_start':
  // 更新工具状态为 "running"
  // (通过 toolCall.id 匹配)

case 'tool_call_end':
  // 通过 toolCallId 找到对应的 toolCall
  // 更新其 result 字段
  const updatedToolCalls = lastMessage.toolCalls.map(tc =>
    tc.id === event.data.toolCallId
      ? { ...tc, result: event.data }
      : tc
  );

case 'permission_request':
  // 显示权限请求对话框

case 'agent_complete':
  // 解锁输入，允许新消息
```

## 状态管理 (Zustand)

```
stores/
├── sessionStore.ts    # 会话状态 (messages, currentSession)
├── appStore.ts        # 全局状态 (isProcessing, currentGeneration)
└── authStore.ts       # 认证状态 (user, isAuthenticated)
```

---

## UI/UX 改进方向

### 工具调用显示问题

**当前问题**:
- 代码被 JSON.stringify，`\n` 显示为字面量
- 没有语法高亮
- 没有折叠/截断

**成熟产品做法对比**:

| 方面 | Claude Code | Cursor | 当前产品 |
|------|-------------|--------|---------|
| edit_file 显示 | Diff 视图 (红绿对比) | 内联 diff | 原始 JSON |
| 参数摘要 | "Editing file.ts (15 lines)" | 简短摘要 | 完整参数 |
| 默认状态 | 折叠 | 折叠 | 展开 |
| 长内容 | 智能截断 | 虚拟滚动 | 完全展开 |

### 建议的改进

**智能摘要**:
```typescript
function summarizeToolCall(toolCall: ToolCall): string {
  switch (toolCall.name) {
    case 'edit_file':
      const lines = (toolCall.arguments.old_string as string)?.split('\n').length;
      return `Editing ${toolCall.arguments.file_path} (replacing ~${lines} lines)`;
    case 'bash':
      return `Running: ${(toolCall.arguments.command as string)?.slice(0, 50)}...`;
    case 'read_file':
      return `Reading ${toolCall.arguments.file_path}`;
    case 'write_file':
      return `Creating ${toolCall.arguments.file_path}`;
  }
}
```

**Diff 视图**:
```typescript
import { diffLines } from 'diff';

const DiffView = ({ oldText, newText }) => {
  const changes = diffLines(oldText, newText);
  return (
    <pre>
      {changes.map(change => (
        <span className={
          change.added ? 'bg-green-500/20' :
          change.removed ? 'bg-red-500/20' : ''
        }>
          {change.added ? '+' : change.removed ? '-' : ' '}
          {change.value}
        </span>
      ))}
    </pre>
  );
};
```

---

## 文件结构

```
src/renderer/
├── components/
│   ├── ChatView.tsx       # 聊天视图
│   ├── ChatInput.tsx      # 输入框
│   ├── MessageBubble.tsx  # 消息气泡 (442 行)
│   ├── Sidebar.tsx        # 侧边栏
│   ├── TodoPanel.tsx      # 任务面板
│   └── PreviewPanel.tsx   # 预览面板
│
├── hooks/
│   ├── useAgent.ts        # Agent 通信 Hook
│   ├── useGeneration.ts   # 代际 Hook
│   └── useRequireAuth.ts  # 登录拦截 Hook
│
└── stores/
    ├── sessionStore.ts    # 会话状态
    ├── appStore.ts        # 全局状态
    └── authStore.ts       # 认证状态
```
