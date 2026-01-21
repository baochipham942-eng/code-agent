# OpenWork + AionUi 能力迁移实施计划

> 基于 PoC 验证通过，可以开始正式开发

---

## 前置验证（已完成）

| PoC | 结果 | 提交 |
|-----|------|------|
| react-markdown ESM | ✅ 通过 | 32dcace |
| react-virtuoso 动态高度 | ✅ 通过 | 32dcace |
| Session 数据库迁移 | ✅ 可行 | 待实施 |

---

## 已安装依赖

```json
{
  "dependencies": {
    "react-virtuoso": "^4.18.1"
  },
  "devDependencies": {
    "react-markdown": "^10.1.0",
    "remark-gfm": "^4.0.1",
    "remark-math": "^6.0.0",
    "remark-breaks": "^4.0.0",
    "rehype-katex": "^7.0.1",
    "react-syntax-highlighter": "^15.6.6",
    "@types/react-syntax-highlighter": "^15.5.13"
  }
}
```

---

## Phase 1: 核心体验优化

### 任务清单

| 优先级 | 任务 | 文件 | 状态 |
|--------|------|------|------|
| **P0** | Markdown 渲染升级 | `MessageContent.tsx` | ✅ 完成 |
| **P1** | 工具调用展示优化（折叠/展开） | `ToolCallDisplay.tsx` | 待开始 |
| **P1** | ThoughtDisplay 组件 | 新建 | 待开始 |
| **P1** | ContextUsageIndicator 组件 | 新建 | 待开始 |
| **P1** | 虚拟列表集成 | `ChatView.tsx` | ✅ 完成 |
| **P1** | MessageBatcher 消息批处理 | 新建 | 待开始 |

### Markdown 渲染升级指南

**当前实现** (`src/renderer/components/features/chat/MessageBubble/MessageContent.tsx`):
- 手工正则解析代码块
- 自定义表格、标题、列表解析

**目标实现**:
```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

<ReactMarkdown
  remarkPlugins={[remarkGfm, remarkMath]}
  rehypePlugins={[rehypeKatex]}
  components={{
    code: ({ inline, className, children }) => {
      if (inline) return <InlineCode>{children}</InlineCode>;
      const language = className?.replace('language-', '') || '';
      return (
        <SyntaxHighlighter style={oneDark} language={language}>
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      );
    },
    table: MarkdownTable,  // 复用现有组件
  }}
>
  {content}
</ReactMarkdown>
```

**注意事项**:
1. 需要引入 KaTeX CSS: `import 'katex/dist/katex.min.css'`
2. 保留现有 `CodeBlock` 组件的复制按钮功能
3. 使用渐进式迁移（feature flag）

### 虚拟列表集成指南

**当前实现** (`src/renderer/components/ChatView.tsx`):
```tsx
<div className="max-w-3xl mx-auto py-6 px-4 space-y-6">
  {messages.map((message, index) => (
    <MessageBubble message={message} />
  ))}
</div>
```

**目标实现**:
```tsx
import { Virtuoso } from 'react-virtuoso';

<Virtuoso
  data={filteredMessages}
  itemContent={(index, message) => (
    <div className="px-4 py-2">
      <MessageBubble message={message} />
    </div>
  )}
  followOutput="smooth"
  defaultItemHeight={100}
  overscan={400}
/>
```

**关键配置**:
- `followOutput="smooth"` - 新消息自动滚动
- `defaultItemHeight={100}` - 预估平均高度
- `overscan={400}` - 预渲染像素
- 用 `padding` 不用 `margin`（避免高度计算问题）

---

## Phase 2: 多会话系统

### 任务清单

| 优先级 | 任务 | 文件 | 状态 |
|--------|------|------|------|
| **P1** | Session 类型扩展 | `types/session.ts` | 待开始 |
| **P1** | 数据库迁移脚本 | `databaseService.ts` | 待开始 |
| **P1** | ConversationTabs 组件 | 新建 | 待开始 |
| **P1** | Tab 状态 Context | 新建 | 待开始 |
| **P2** | Tab localStorage 持久化 | 新建 | 待开始 |
| **P2** | Tab 右键菜单 | 新建 | 待开始 |

### Session 类型扩展

```typescript
// src/shared/types/session.ts
export type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

export interface Session {
  // 现有字段...
  workspace?: string;              // 新增
  status?: SessionStatus;          // 新增
  lastTokenUsage?: string;         // 新增: JSON 字符串
}
```

### 数据库迁移（try-catch 模式）

```typescript
// src/main/services/databaseService.ts
private migrateSessionsTable(): void {
  const migrations = [
    { column: 'status', sql: "ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'idle'" },
    { column: 'workspace', sql: 'ALTER TABLE sessions ADD COLUMN workspace TEXT' },
    { column: 'last_token_usage', sql: 'ALTER TABLE sessions ADD COLUMN last_token_usage TEXT' },
  ];

  for (const migration of migrations) {
    try {
      this.db.exec(migration.sql);
    } catch {
      // 列已存在，忽略
    }
  }
}
```

---

## Phase 3: Cowork 模式

### 任务清单

| 优先级 | 任务 | 文件 | 状态 |
|--------|------|------|------|
| **P1** | 模式切换 UI | `SettingsModal.tsx` | 待开始 |
| **P1** | useModeStore | 新建 | 待开始 |
| **P2** | useMultiAgentDetection hook | 新建 | 待开始 |
| **P2** | 简化消息展示 | `MessageBubble/` | 待开始 |
| **P3** | 工作空间分组历史 | `Sidebar.tsx` | 待开始 |

---

## Phase 4: 多任务并行

### 任务清单

| 优先级 | 任务 | 文件 | 状态 |
|--------|------|------|------|
| **P2** | TaskManager 类 | 新建 | 待开始 |
| **P2** | 任务队列 + 并发控制 | 新建 | 待开始 |
| **P2** | AgentLoop 多实例支持 | `AgentLoop.ts` | 待开始 |
| **P3** | 任务中断/取消 (Ctrl+C) | 新建 | 待开始 |

---

## 风险预防（已验证）

| 风险点 | 解决方案 |
|--------|----------|
| ESM 导入错误 | Vite 6 原生支持，无需额外配置 |
| Virtuoso 高度跳动 | 用 padding 替代 margin |
| SQLite IF NOT EXISTS | 使用 try-catch 模式 |
| Bundle 体积 +1MB | 后续可考虑代码分割 |
| KaTeX 字体缺失 | 引入 katex.min.css |

---

## 执行顺序（Wave 编排）

```
Wave 1: 基础组件
├── Markdown 渲染升级 (P0)
└── 虚拟列表集成 (P1)

Wave 2: UI 增强（可并行）
├── 工具调用展示优化
├── ThoughtDisplay 组件
└── ContextUsageIndicator 组件

Wave 3: 多会话系统
├── Session 类型 + 迁移
├── ConversationTabs 组件
└── Tab 状态管理

Wave 4: Cowork 模式
├── 模式切换 UI
├── 多 Agent 检测
└── 简化展示

Wave 5: 多任务并行
├── TaskManager
├── 并发控制
└── 任务中断
```

---

## 新会话启动指令

```
请帮我实施 OpenWork + AionUi 能力迁移的 Phase 1。

参考文档：docs/TODO-openwork-aionui-migration.md

从 Wave 1 开始：
1. Markdown 渲染升级 - 替换 MessageContent.tsx 的手工解析
2. 虚拟列表集成 - 在 ChatView.tsx 中使用 react-virtuoso

依赖已安装，PoC 已验证通过。
```

---

*文档创建时间：2026-01-21*
*基于 Code Agent v0.8.10*
