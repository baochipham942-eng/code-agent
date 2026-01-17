# Code Agent - 优化方案

> 版本: 2.0
> 日期: 2026-01-17
> 状态: 详细设计完成

---

## 一、问题概览

### 1.1 问题分类

| 类别 | 数量 | 影响范围 |
|------|------|----------|
| 🔴 数据一致性 (P0) | 3 | 核心功能 |
| 🟡 用户体验 (P1) | 3 | 日常使用 |
| 🟢 性能优化 (P2) | 2 | 效率 |

### 1.2 完整问题清单

| # | 优先级 | 问题 | 影响 | 工作量 |
|---|--------|------|------|--------|
| 1 | 🔴 P0 | Message ID 前后端格式不一致 | 同步冲突、数据丢失 | 2h |
| 2 | 🔴 P0 | toolCallId 来源不一致 | 工具结果无法显示 | 3h |
| 3 | 🔴 P0 | MCPClient 返回空 toolCallId | MCP 工具不可用 | 1h |
| 4 | 🟡 P1 | edit_file 参数展示混乱 | 用户体验差 | 4h |
| 5 | 🟡 P1 | 工具调用历史格式化 | Token 浪费 | 2h |
| 6 | 🟡 P1 | 缺少 Diff 视图 | 代码变更不直观 | 4h |
| 7 | 🟢 P2 | 工具调用默认展开 | 信息噪音 | 0.5h |
| 8 | 🟢 P2 | 缺少工具执行进度指示 | 不清楚执行状态 | 2h |

---

## 二、P0 问题修复方案

### 2.1 统一 ID 生成策略

**问题描述**:
- 前端使用 `Date.now().toString()` 生成 message.id
- 后端使用 `${Date.now()}-${random}` 生成 message.id
- toolCall.id 有 3 种格式：模型生成、文本解析、MCP 回退

**影响**:
- Supabase 同步时可能出现重复或冲突
- 跨设备数据不一致
- 前端无法正确匹配 toolCall 和 toolResult

**解决方案**:

#### 步骤 1: 创建统一 ID 生成器

```typescript
// 新建 src/shared/utils/id.ts

import { v4 as uuidv4 } from 'uuid';

/**
 * 生成全局唯一的消息 ID
 * 格式: UUID v4 (例: "550e8400-e29b-41d4-a716-446655440000")
 */
export function generateMessageId(): string {
  return uuidv4();
}

/**
 * 生成全局唯一的工具调用 ID
 * 格式: "tool-" + UUID v4
 * 用于文本解析回退时，保证与模型生成的 ID 格式区分
 */
export function generateToolCallId(): string {
  return `tool-${uuidv4()}`;
}

/**
 * 验证是否为有效的 UUID
 */
export function isValidUUID(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id) || id.startsWith('tool-') || id.startsWith('call_') || id.startsWith('toolu_');
}
```

#### 步骤 2: 修改前端 useAgent.ts

```typescript
// src/renderer/hooks/useAgent.ts

import { generateMessageId } from '@shared/utils/id';

// 修改 sendMessage 函数
const sendMessage = async (content: string) => {
  // 改为使用统一 ID 生成
  const userMessage: Message = {
    id: generateMessageId(),  // ← 改这里
    role: 'user',
    content,
    timestamp: Date.now(),
  };

  const assistantMessage: Message = {
    id: generateMessageId(),  // ← 改这里
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
  };

  // ... 其余代码不变
};
```

#### 步骤 3: 修改后端 AgentLoop.ts

```typescript
// src/main/agent/AgentLoop.ts

import { generateMessageId, generateToolCallId } from '../../shared/utils/id';

// 修改 generateId 方法
private generateId(): string {
  return generateMessageId();  // ← 改为使用统一函数
}

// 修改文本解析回退 (约 L988)
// 原代码:
// id: `text-${Date.now()}`
// 改为:
id: generateToolCallId()
```

#### 步骤 4: 安装 uuid 依赖

```bash
npm install uuid
npm install -D @types/uuid
```

#### 步骤 5: 修改 vite.config.ts 和 tsconfig 确保 uuid 正确导入

```typescript
// vite.config.ts - 确保 uuid 被正确打包
export default defineConfig({
  // ...
  optimizeDeps: {
    include: ['uuid'],
  },
});
```

```json
// tsconfig.json - 确保类型正确解析
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "esModuleInterop": true
  }
}
```

#### 步骤 6: 添加 ID 验证工具函数

```typescript
// src/shared/utils/id.ts (扩展)

/**
 * 检测 ID 来源
 */
export function getIdSource(id: string): 'uuid' | 'openai' | 'claude' | 'legacy' | 'unknown' {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return 'uuid';
  }
  if (id.startsWith('call_')) {
    return 'openai';
  }
  if (id.startsWith('toolu_')) {
    return 'claude';
  }
  if (/^\d+-[a-z0-9]+$/.test(id) || /^\d+$/.test(id)) {
    return 'legacy';
  }
  return 'unknown';
}

/**
 * 标准化 ID（将旧格式转换为 UUID）
 * 用于数据库迁移
 */
export function normalizeId(id: string): string {
  const source = getIdSource(id);
  if (source === 'uuid' || source === 'openai' || source === 'claude') {
    return id; // 已经是有效格式
  }
  // 为旧格式生成新的 UUID，但保留原 ID 作为前缀以便追踪
  return `migrated-${id}-${uuidv4().slice(0, 8)}`;
}
```

**验证方法**:
1. 发送消息，检查控制台中的 message.id 格式
2. 触发工具调用，检查 toolCall.id 格式
3. 检查 Supabase 中存储的 ID 格式一致性
4. 运行 `npm run typecheck` 确保类型正确

---

### 2.2 修复 toolCallId 匹配问题

**问题描述**:
前端在 `tool_call_end` 事件中通过 `tc.id === event.data.toolCallId` 匹配，但可能因竞态条件导致匹配失败。

**根因分析**:
```
时间线:
T1: 模型返回 toolCall { id: "call_abc", name: "bash" }
T2: 发送 tool_call_start 事件
T3: 前端收到事件，更新 lastMessage.toolCalls
T4: 工具执行完成
T5: 发送 tool_call_end 事件
T6: 前端收到事件，但 lastMessage 可能已变化（新消息到达）
    → 匹配失败！
```

**解决方案**:

#### 步骤 1: 修改 useAgent.ts 的事件处理

```typescript
// src/renderer/hooks/useAgent.ts

case 'tool_call_end':
  const toolResult = event.data as ToolResult;

  // 改进: 遍历所有消息查找匹配的 toolCall
  setMessages(prev => {
    return prev.map(msg => {
      if (msg.role !== 'assistant' || !msg.toolCalls) return msg;

      const hasMatch = msg.toolCalls.some(tc => tc.id === toolResult.toolCallId);
      if (!hasMatch) return msg;

      return {
        ...msg,
        toolCalls: msg.toolCalls.map(tc =>
          tc.id === toolResult.toolCallId
            ? { ...tc, result: toolResult }
            : tc
        )
      };
    });
  });
  break;
```

#### 步骤 2: 添加调试日志（开发环境）

```typescript
// src/renderer/hooks/useAgent.ts

case 'tool_call_end':
  const toolResult = event.data as ToolResult;

  if (import.meta.env.DEV) {
    console.log('[useAgent] tool_call_end received:', {
      toolCallId: toolResult.toolCallId,
      success: toolResult.success,
      duration: toolResult.duration,
    });
  }

  setMessages(prev => {
    let matched = false;
    const updated = prev.map(msg => {
      if (msg.role !== 'assistant' || !msg.toolCalls) return msg;

      const hasMatch = msg.toolCalls.some(tc => tc.id === toolResult.toolCallId);
      if (!hasMatch) return msg;

      matched = true;
      return {
        ...msg,
        toolCalls: msg.toolCalls.map(tc =>
          tc.id === toolResult.toolCallId
            ? { ...tc, result: toolResult }
            : tc
        )
      };
    });

    if (import.meta.env.DEV && !matched) {
      console.warn('[useAgent] No matching toolCall found for:', toolResult.toolCallId);
      console.log('[useAgent] Available toolCalls:',
        prev.filter(m => m.toolCalls).flatMap(m => m.toolCalls!.map(tc => tc.id))
      );
    }

    return updated;
  });
  break;
```

#### 步骤 3: 添加超时处理（防止工具永远 Running）

```typescript
// src/renderer/components/MessageBubble.tsx

const ToolCallDisplay: React.FC<{ toolCall: ToolCall }> = ({ toolCall }) => {
  const [elapsedTime, setElapsedTime] = useState(0);
  const status = getStatus(toolCall);

  useEffect(() => {
    if (status !== 'pending') return;

    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(timer);
  }, [status]);

  // 超过 5 分钟标记为超时
  const isTimeout = status === 'pending' && elapsedTime > 300;

  return (
    <div>
      {/* ... */}
      {status === 'pending' && (
        <span className={`text-xs ${isTimeout ? 'text-amber-400' : 'text-zinc-500'}`}>
          {isTimeout ? `Timeout (${elapsedTime}s)` : `Running... ${elapsedTime}s`}
        </span>
      )}
    </div>
  );
};
```

**验证方法**:
1. 连续快速发送多条消息
2. 检查所有工具调用都能正确显示结果
3. 没有工具卡在 "Running..." 状态
4. 开发环境下检查控制台无警告

---

### 2.3 修复 MCPClient 空 toolCallId

**问题描述**:
MCPClient 在多处返回 `toolCallId: ''`，导致前端永远无法匹配。

**当前代码问题** (MCPClient.ts:252-303):
```typescript
async callTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  // ...
  return {
    toolCallId: '',  // ← 问题：空字符串
    success: !result.isError,
    output,
    duration: Date.now() - startTime,
  };
}
```

**解决方案**:

#### 步骤 1: 修改 MCPClient.ts 方法签名

```typescript
// src/main/mcp/MCPClient.ts

/**
 * 调用 MCP 工具
 * @param toolCallId - 工具调用 ID（用于前端匹配）
 * @param serverName - MCP 服务器名称
 * @param toolName - 工具名称
 * @param args - 工具参数
 */
async callTool(
  toolCallId: string,  // ← 新增参数（第一个参数）
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const client = this.clients.get(serverName);
  if (!client) {
    return {
      toolCallId,  // ← 使用传入的 ID
      success: false,
      error: `MCP server ${serverName} not connected`,
    };
  }

  const startTime = Date.now();

  try {
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });

    // 转换结果
    let output = '';
    if (result.content && Array.isArray(result.content)) {
      for (const content of result.content) {
        if ('text' in content && typeof content.text === 'string') {
          output += content.text;
        } else if ('type' in content && content.type === 'image') {
          output += `[Image: ${(content as { mimeType?: string }).mimeType || 'unknown'}]`;
        } else if ('type' in content && content.type === 'resource') {
          output += `[Resource]`;
        }
      }
    }

    return {
      toolCallId,  // ← 使用传入的 ID
      success: !result.isError,
      output,
      duration: Date.now() - startTime,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'MCP tool call failed';
    return {
      toolCallId,  // ← 使用传入的 ID
      success: false,
      error: errorMessage,
      duration: Date.now() - startTime,
    };
  }
}
```

#### 步骤 2: 修改 AgentLoop.ts 中调用 MCP 工具的代码

```typescript
// src/main/agent/AgentLoop.ts - executeToolsWithHooks 方法

// 查找 MCP 工具调用的地方
if (toolCall.name.startsWith('mcp_')) {
  const mcpClient = getMCPClient();
  const parsed = mcpClient.parseMCPToolName(toolCall.name);
  if (parsed) {
    // 修改调用方式：传入 toolCallId
    result = await mcpClient.callTool(
      toolCall.id,        // ← 传入 toolCall.id
      parsed.serverName,
      parsed.toolName,
      toolCall.arguments
    );
  }
}
```

#### 步骤 3: 更新类型定义确保一致性

```typescript
// src/main/mcp/MCPClient.ts - 添加类型重载（可选，提高代码清晰度）

/**
 * 调用 MCP 工具（完整签名）
 */
async callTool(
  toolCallId: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult>;

/**
 * @deprecated 使用带 toolCallId 的版本
 */
async callTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult>;

async callTool(
  toolCallIdOrServerName: string,
  serverNameOrToolName: string,
  toolNameOrArgs: string | Record<string, unknown>,
  args?: Record<string, unknown>
): Promise<ToolResult> {
  // 检测调用方式
  if (typeof toolNameOrArgs === 'object') {
    // 旧的 3 参数调用方式 (已废弃)
    console.warn('[MCPClient] Deprecated: callTool should include toolCallId');
    return this._callToolInternal(
      '', // 空 ID
      toolCallIdOrServerName,
      serverNameOrToolName,
      toolNameOrArgs
    );
  } else {
    // 新的 4 参数调用方式
    return this._callToolInternal(
      toolCallIdOrServerName,
      serverNameOrToolName,
      toolNameOrArgs,
      args!
    );
  }
}

private async _callToolInternal(
  toolCallId: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  // 实际实现...
}
```

**验证方法**:
1. 配置一个 MCP Server (如 filesystem)
2. 调用 MCP 工具 (如 `mcp_filesystem_read_file`)
3. 检查工具结果能正确显示
4. 检查控制台无 "空 toolCallId" 警告

---

## 三、P1 问题优化方案

### 3.1 工具调用智能摘要

**问题描述**:
`edit_file` 的 `old_string` 和 `new_string` 参数可能包含数百行代码，被原样展示为 JSON，用户体验极差。

**解决方案**:

#### 步骤 1: 创建工具摘要函数

```typescript
// src/renderer/utils/toolSummary.ts

import type { ToolCall } from '@shared/types';

export function summarizeToolCall(toolCall: ToolCall): string {
  const { name, arguments: args } = toolCall;

  switch (name) {
    case 'edit_file': {
      const filePath = args.file_path as string;
      const fileName = filePath?.split('/').pop() || filePath;
      const oldLines = (args.old_string as string)?.split('\n').length || 0;
      const newLines = (args.new_string as string)?.split('\n').length || 0;
      const diff = newLines - oldLines;
      const diffStr = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '±0';
      return `Editing ${fileName} (${oldLines} → ${newLines} lines, ${diffStr})`;
    }

    case 'bash': {
      const cmd = (args.command as string) || '';
      const shortCmd = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
      return `Running: ${shortCmd}`;
    }

    case 'read_file': {
      const filePath = args.file_path as string;
      const fileName = filePath?.split('/').pop() || filePath;
      const limit = args.limit as number;
      return limit
        ? `Reading ${fileName} (${limit} lines)`
        : `Reading ${fileName}`;
    }

    case 'write_file': {
      const filePath = args.file_path as string;
      const fileName = filePath?.split('/').pop() || filePath;
      const content = args.content as string;
      const lines = content?.split('\n').length || 0;
      return `Creating ${fileName} (${lines} lines)`;
    }

    case 'glob': {
      const pattern = args.pattern as string;
      return `Finding files: ${pattern}`;
    }

    case 'grep': {
      const pattern = args.pattern as string;
      return `Searching: ${pattern}`;
    }

    default:
      return `Calling ${name}`;
  }
}

export function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    bash: '⌨️',
    read_file: '📄',
    write_file: '✏️',
    edit_file: '🔧',
    glob: '🔍',
    grep: '🔎',
    list_directory: '📁',
    task: '⚡',
    skill: '✨',
    web_fetch: '🌐',
  };
  return icons[name] || '🔧';
}
```

#### 步骤 2: 修改 MessageBubble.tsx

```typescript
// src/renderer/components/MessageBubble.tsx

import { summarizeToolCall, getToolIcon } from '../utils/toolSummary';

const ToolCallDisplay: React.FC<{ toolCall: ToolCall; index: number; total: number }> = ({
  toolCall,
  index,
  total
}) => {
  // 默认折叠
  const [expanded, setExpanded] = useState(false);

  const summary = summarizeToolCall(toolCall);
  const icon = getToolIcon(toolCall.name);

  return (
    <div className="rounded-xl bg-zinc-800/40 border border-zinc-700/50 overflow-hidden">
      {/* 折叠的头部 - 显示摘要 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-700/20"
      >
        <ChevronRight className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />

        <span className="text-lg">{icon}</span>

        <div className="flex-1 text-left">
          <span className="text-sm font-medium text-zinc-200">{toolCall.name}</span>
          <span className="ml-2 text-sm text-zinc-400">{summary}</span>
        </div>

        {/* 状态徽章 */}
        <StatusBadge status={getStatus(toolCall)} />
      </button>

      {/* 展开的内容 */}
      {expanded && (
        <ToolCallExpandedContent toolCall={toolCall} />
      )}
    </div>
  );
};
```

**效果对比**:

| 之前 | 之后 |
|------|------|
| `{"file_path": "snake.html", "old_string": "// 根据方向绘制眼睛\n const eyeSize = ..."` (几百行) | `🔧 edit_file - Editing snake.html (15 → 20 lines, +5)` |

---

### 3.2 Diff 视图组件

**问题描述**:
`edit_file` 的 `old_string` 和 `new_string` 没有差异对比，用户无法快速理解改动内容。

**解决方案**:

#### 步骤 1: 安装 diff 库

```bash
npm install diff
npm install -D @types/diff
```

#### 步骤 2: 创建 DiffView 组件

```typescript
// src/renderer/components/DiffView.tsx

import React, { useMemo } from 'react';
import { diffLines, Change } from 'diff';

interface DiffViewProps {
  oldText: string;
  newText: string;
  fileName?: string;
}

export const DiffView: React.FC<DiffViewProps> = ({ oldText, newText, fileName }) => {
  const changes = useMemo(() => diffLines(oldText, newText), [oldText, newText]);

  // 统计变更
  const stats = useMemo(() => {
    let added = 0, removed = 0;
    changes.forEach(change => {
      if (change.added) added += change.count || 0;
      if (change.removed) removed += change.count || 0;
    });
    return { added, removed };
  }, [changes]);

  return (
    <div className="rounded-lg border border-zinc-700/50 overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800/50 border-b border-zinc-700/50">
        <span className="text-sm text-zinc-300">{fileName || 'Changes'}</span>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-green-400">+{stats.added}</span>
          <span className="text-red-400">-{stats.removed}</span>
        </div>
      </div>

      {/* Diff 内容 */}
      <pre className="p-4 text-xs font-mono overflow-x-auto max-h-80">
        {changes.map((change, i) => (
          <DiffLine key={i} change={change} />
        ))}
      </pre>
    </div>
  );
};

const DiffLine: React.FC<{ change: Change }> = ({ change }) => {
  const lines = change.value.split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[i]);

  const bgClass = change.added
    ? 'bg-green-500/10'
    : change.removed
      ? 'bg-red-500/10'
      : '';

  const textClass = change.added
    ? 'text-green-400'
    : change.removed
      ? 'text-red-400'
      : 'text-zinc-400';

  const prefix = change.added ? '+' : change.removed ? '-' : ' ';

  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className={`${bgClass} ${textClass}`}>
          <span className="select-none w-4 inline-block text-zinc-600">{prefix}</span>
          {line}
        </div>
      ))}
    </>
  );
};

// 辅助函数：检测文件语言（用于未来的语法高亮）
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    html: 'html',
    css: 'css',
    json: 'json',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return langMap[ext] || 'text';
}
```

#### 步骤 3: 在 ToolCallDisplay 中使用

```typescript
// 展开内容中针对 edit_file 显示 Diff
{expanded && toolCall.name === 'edit_file' && (
  <div className="px-4 pb-4">
    <DiffView
      oldText={toolCall.arguments.old_string as string}
      newText={toolCall.arguments.new_string as string}
      fileName={toolCall.arguments.file_path as string}
    />
  </div>
)}
```

---

### 3.3 历史消息优化

**问题描述**:
`buildModelMessages()` 将完整的 `edit_file` 参数序列化到历史中，导致：
1. Token 消耗巨大
2. 模型可能被无关细节干扰

**解决方案**:

#### 修改 AgentLoop.ts

```typescript
// src/main/agent/AgentLoop.ts

private buildModelMessages(): Array<{ role: string; content: string }> {
  const modelMessages: Array<{ role: string; content: string }> = [];

  // System prompt
  modelMessages.push({
    role: 'system',
    content: this.generation.systemPrompt,
  });

  // 对话历史
  for (const message of this.messages) {
    if (message.role === 'tool') {
      // 工具结果 - 保留完整内容（模型需要看到执行结果）
      modelMessages.push({
        role: 'user',
        content: `Tool results:\n${message.content}`,
      });
    } else if (message.role === 'assistant' && message.toolCalls) {
      // 工具调用 - 使用简化格式
      const toolCallsStr = message.toolCalls
        .map(tc => this.formatToolCallForHistory(tc))
        .join('\n');
      modelMessages.push({
        role: 'assistant',
        content: toolCallsStr || message.content,
      });
    } else {
      modelMessages.push({
        role: message.role,
        content: message.content,
      });
    }
  }

  return modelMessages;
}

/**
 * 格式化工具调用用于历史记录
 * 只保留关键信息，避免 token 浪费
 */
private formatToolCallForHistory(tc: ToolCall): string {
  const { name, arguments: args } = tc;

  switch (name) {
    case 'edit_file':
      return `Edited ${args.file_path}`;

    case 'bash': {
      const cmd = (args.command as string) || '';
      const shortCmd = cmd.length > 100 ? cmd.slice(0, 97) + '...' : cmd;
      return `Ran: ${shortCmd}`;
    }

    case 'read_file':
      return `Read ${args.file_path}`;

    case 'write_file':
      return `Created ${args.file_path}`;

    case 'glob':
      return `Found files matching: ${args.pattern}`;

    case 'grep':
      return `Searched for: ${args.pattern}`;

    default:
      return `Called ${name}(${JSON.stringify(args).slice(0, 100)})`;
  }
}
```

**Token 节省估算**:

| 场景 | 之前 | 之后 | 节省 |
|------|------|------|------|
| edit_file (50行代码) | ~2000 tokens | ~20 tokens | 99% |
| bash (长命令) | ~500 tokens | ~50 tokens | 90% |

---

## 四、P2 问题优化方案

### 4.1 工具调用默认折叠

**修改 MessageBubble.tsx**:

```typescript
const ToolCallDisplay: React.FC<...> = (...) => {
  // 改为默认折叠
  const [expanded, setExpanded] = useState(false);  // ← 改为 false

  // ... 其余不变
};
```

### 4.2 工具执行进度指示

**问题**: 用户不清楚工具执行进度，尤其是长时间运行的 bash 命令。

**解决方案**: 添加执行时长显示和预估。

```typescript
// ToolCallDisplay 中添加执行时长显示

const [elapsedTime, setElapsedTime] = useState(0);

useEffect(() => {
  if (status === 'pending') {
    const timer = setInterval(() => {
      setElapsedTime(prev => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }
}, [status]);

// 在 UI 中显示
{status === 'pending' && (
  <span className="text-xs text-zinc-500">
    Running... {elapsedTime}s
  </span>
)}
```

---

## 五、实施计划

### 5.1 Sprint 1 (P0 修复) - 预计 6h

| 任务 | 文件 | 时间 |
|------|------|------|
| 创建统一 ID 生成器 | `src/shared/utils/id.ts` | 0.5h |
| 修改前端 ID 生成 | `useAgent.ts` | 0.5h |
| 修改后端 ID 生成 | `AgentLoop.ts` | 0.5h |
| 修复 toolCallId 匹配 | `useAgent.ts` | 1h |
| 修复 MCPClient | `MCPClient.ts`, `ToolExecutor.ts` | 1h |
| 测试验证 | - | 2h |
| 安装 uuid 依赖 | `package.json` | 0.5h |

### 5.2 Sprint 2 (P1 优化) - 预计 10h

| 任务 | 文件 | 时间 |
|------|------|------|
| 创建工具摘要函数 | `src/renderer/utils/toolSummary.ts` | 1h |
| 修改 ToolCallDisplay | `MessageBubble.tsx` | 2h |
| 创建 DiffView 组件 | `src/renderer/components/DiffView.tsx` | 3h |
| 修改历史消息格式化 | `AgentLoop.ts` | 1h |
| 安装 diff 依赖 | `package.json` | 0.5h |
| 测试验证 | - | 2.5h |

### 5.3 Sprint 3 (P2 优化) - 预计 3h

| 任务 | 文件 | 时间 |
|------|------|------|
| 默认折叠 | `MessageBubble.tsx` | 0.5h |
| 执行时长显示 | `MessageBubble.tsx` | 1.5h |
| 测试验证 | - | 1h |

---

## 六、验收标准

### 6.1 P0 验收

- [ ] 所有 message.id 格式统一为 UUID
- [ ] 所有 toolCall 结果能正确显示
- [ ] MCP 工具结果能正确显示
- [ ] Supabase 同步无冲突
- [ ] 跨设备数据一致

### 6.2 P1 验收

- [ ] edit_file 显示 "Editing xxx.ts (15 → 20 lines, +5)"
- [ ] 展开后显示 Diff 视图
- [ ] bash 显示 "Running: npm install..."
- [ ] 历史消息不包含完整代码
- [ ] Token 消耗明显减少

### 6.3 P2 验收

- [ ] 工具调用默认折叠
- [ ] 显示执行时长

---

## 七、风险与应对

| 风险 | 可能性 | 影响 | 应对措施 |
|------|--------|------|----------|
| UUID 与现有数据不兼容 | 高 | 中 | 保留旧 ID 兼容逻辑 |
| Diff 库性能问题 | 低 | 中 | 限制 diff 的最大行数 |
| 历史格式化丢失关键信息 | 中 | 高 | 工具结果保留完整内容 |

---

## 八、测试验证方案

### 8.1 单元测试

#### ID 生成器测试

```typescript
// tests/shared/utils/id.test.ts

import { describe, it, expect } from 'vitest';
import {
  generateMessageId,
  generateToolCallId,
  isValidUUID,
  getIdSource,
} from '@shared/utils/id';

describe('ID Generation', () => {
  describe('generateMessageId', () => {
    it('should generate valid UUID v4', () => {
      const id = generateMessageId();
      expect(isValidUUID(id)).toBe(true);
      expect(getIdSource(id)).toBe('uuid');
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 1000 }, () => generateMessageId()));
      expect(ids.size).toBe(1000);
    });
  });

  describe('generateToolCallId', () => {
    it('should generate ID with tool- prefix', () => {
      const id = generateToolCallId();
      expect(id.startsWith('tool-')).toBe(true);
    });
  });

  describe('getIdSource', () => {
    it('should detect UUID format', () => {
      expect(getIdSource('550e8400-e29b-41d4-a716-446655440000')).toBe('uuid');
    });

    it('should detect OpenAI format', () => {
      expect(getIdSource('call_abc123def456')).toBe('openai');
    });

    it('should detect Claude format', () => {
      expect(getIdSource('toolu_01ABC')).toBe('claude');
    });

    it('should detect legacy timestamp format', () => {
      expect(getIdSource('1705234567890')).toBe('legacy');
      expect(getIdSource('1705234567890-abc123')).toBe('legacy');
    });
  });
});
```

#### 工具摘要测试

```typescript
// tests/renderer/utils/toolSummary.test.ts

import { describe, it, expect } from 'vitest';
import { summarizeToolCall, getToolIcon } from '@renderer/utils/toolSummary';

describe('Tool Summary', () => {
  it('should summarize edit_file correctly', () => {
    const toolCall = {
      id: 'test',
      name: 'edit_file',
      arguments: {
        file_path: '/src/components/App.tsx',
        old_string: 'line1\nline2\nline3',
        new_string: 'line1\nline2\nline3\nline4\nline5',
      },
    };
    const summary = summarizeToolCall(toolCall);
    expect(summary).toContain('App.tsx');
    expect(summary).toContain('3');  // old lines
    expect(summary).toContain('5');  // new lines
    expect(summary).toContain('+2'); // diff
  });

  it('should truncate long bash commands', () => {
    const toolCall = {
      id: 'test',
      name: 'bash',
      arguments: {
        command: 'npm install some-very-long-package-name-that-exceeds-sixty-characters-limit',
      },
    };
    const summary = summarizeToolCall(toolCall);
    expect(summary.length).toBeLessThan(80);
    expect(summary).toContain('...');
  });

  it('should return correct icons', () => {
    expect(getToolIcon('bash')).toBe('⌨️');
    expect(getToolIcon('edit_file')).toBe('🔧');
    expect(getToolIcon('read_file')).toBe('📄');
    expect(getToolIcon('unknown_tool')).toBe('🔧');
  });
});
```

### 8.2 集成测试

#### 工具调用流程测试

```typescript
// tests/integration/toolCall.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentLoop } from '@main/agent/AgentLoop';

describe('Tool Call Flow', () => {
  let events: Array<{ type: string; data: unknown }> = [];
  let agentLoop: AgentLoop;

  beforeEach(() => {
    events = [];
    agentLoop = new AgentLoop({
      // ... config
      onEvent: (event) => events.push(event),
    });
  });

  it('should match toolCallId correctly', async () => {
    // 模拟工具调用
    const toolCall = { id: 'call_test123', name: 'bash', arguments: { command: 'echo test' } };

    // 执行工具
    await agentLoop.executeToolCall(toolCall);

    // 验证事件
    const startEvent = events.find(e => e.type === 'tool_call_start');
    const endEvent = events.find(e => e.type === 'tool_call_end');

    expect(startEvent?.data).toMatchObject({ id: 'call_test123' });
    expect(endEvent?.data).toMatchObject({ toolCallId: 'call_test123' });
  });

  it('should handle MCP tool calls with correct ID', async () => {
    const toolCall = {
      id: 'call_mcp123',
      name: 'mcp_filesystem_read_file',
      arguments: { path: '/tmp/test.txt' },
    };

    await agentLoop.executeToolCall(toolCall);

    const endEvent = events.find(e => e.type === 'tool_call_end');
    expect(endEvent?.data).toHaveProperty('toolCallId', 'call_mcp123');
  });
});
```

### 8.3 E2E 测试场景

```typescript
// tests/e2e/scenarios.ts

export const testScenarios = [
  {
    name: 'P0-1: ID 格式验证',
    steps: [
      '1. 发送消息 "创建一个 hello.txt 文件"',
      '2. 等待工具执行完成',
      '3. 打开开发者工具 → 检查 message.id 格式',
      '4. 验证格式为 UUID 而非时间戳',
    ],
    expected: 'message.id 应为 UUID 格式 (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)',
  },
  {
    name: 'P0-2: 工具结果匹配',
    steps: [
      '1. 快速连续发送多条消息触发工具调用',
      '2. 观察工具调用面板',
      '3. 验证所有工具都显示结果，无 "Running..." 卡住',
    ],
    expected: '所有工具调用都应正确显示结果',
  },
  {
    name: 'P0-3: MCP 工具',
    steps: [
      '1. 配置 filesystem MCP Server',
      '2. 发送 "列出当前目录的文件"',
      '3. 观察 MCP 工具调用结果',
    ],
    expected: 'MCP 工具结果应正确显示',
  },
  {
    name: 'P1-1: edit_file 摘要',
    steps: [
      '1. 发送 "在 App.tsx 中添加一个新组件"',
      '2. 观察 edit_file 工具调用',
      '3. 验证默认显示摘要而非完整参数',
    ],
    expected: '应显示 "Editing App.tsx (X → Y lines, ±Z)"',
  },
  {
    name: 'P1-2: Diff 视图',
    steps: [
      '1. 触发 edit_file 工具调用',
      '2. 点击展开工具详情',
      '3. 验证显示 Diff 视图',
    ],
    expected: '应显示红绿对比的 Diff 视图，而非 JSON',
  },
];
```

### 8.4 性能测试

```typescript
// tests/performance/tokenUsage.test.ts

import { describe, it, expect } from 'vitest';
import { formatToolCallForHistory } from '@main/agent/AgentLoop';

describe('Token Usage Optimization', () => {
  it('should reduce token count for edit_file history', () => {
    const toolCall = {
      id: 'test',
      name: 'edit_file',
      arguments: {
        file_path: '/src/App.tsx',
        old_string: '// 很长的代码...\n'.repeat(100),  // 模拟 100 行
        new_string: '// 更长的代码...\n'.repeat(120),
      },
    };

    // 原始方式
    const originalFormat = `Calling edit_file(${JSON.stringify(toolCall.arguments)})`;
    const originalTokens = Math.ceil(originalFormat.length / 4); // 粗略估计

    // 优化后
    const optimizedFormat = formatToolCallForHistory(toolCall);
    const optimizedTokens = Math.ceil(optimizedFormat.length / 4);

    console.log(`Original: ~${originalTokens} tokens`);
    console.log(`Optimized: ~${optimizedTokens} tokens`);
    console.log(`Saved: ${((1 - optimizedTokens / originalTokens) * 100).toFixed(1)}%`);

    expect(optimizedTokens).toBeLessThan(originalTokens * 0.1); // 至少减少 90%
  });
});
```

---

## 九、后续规划

完成本次优化后，建议的下一步：

1. **流式输出优化**: 模型输出实时显示
2. **错误重试机制**: 工具执行失败时自动重试
3. **工具执行取消**: 支持取消长时间运行的工具
4. **多语言代码高亮**: Diff 视图支持语法高亮
5. **工具调用统计**: 展示工具调用的统计信息（成功率、平均耗时等）
6. **Supabase 同步优化**: 基于 UUID 的增量同步策略

---

## 十、附录

### 10.1 文件修改清单

| 文件 | 修改内容 | 优先级 |
|------|----------|--------|
| `src/shared/utils/id.ts` | 新建，统一 ID 生成 | P0 |
| `src/renderer/hooks/useAgent.ts` | 修改 ID 生成，优化事件处理 | P0 |
| `src/main/agent/AgentLoop.ts` | 修改 ID 生成，优化 buildModelMessages | P0/P1 |
| `src/main/mcp/MCPClient.ts` | 添加 toolCallId 参数 | P0 |
| `src/renderer/utils/toolSummary.ts` | 新建，工具摘要函数 | P1 |
| `src/renderer/components/DiffView.tsx` | 新建，Diff 视图组件 | P1 |
| `src/renderer/components/MessageBubble.tsx` | 使用摘要和 DiffView | P1/P2 |
| `package.json` | 添加 uuid, diff 依赖 | P0/P1 |

### 10.2 回滚方案

如果优化后出现问题，可以通过以下方式回滚：

```bash
# 1. 回滚代码
git revert <commit-hash>

# 2. 数据迁移（如果已经有 UUID 格式的数据）
# 旧格式兼容性已在 isValidUUID 中处理，无需特殊迁移
```

### 10.3 监控指标

| 指标 | 描述 | 目标 |
|------|------|------|
| 工具结果匹配率 | tool_call_end 成功匹配的比例 | > 99.9% |
| Token 使用量 | 每次对话的平均 token 消耗 | 减少 30%+ |
| Diff 渲染时间 | DiffView 组件渲染耗时 | < 100ms |
| ID 碰撞率 | 发生 ID 重复的概率 | < 0.001% |
