import { TestCase } from '../../src/types.js';

/**
 * L6 级别测试用例：实时协作系统
 *
 * 参考 ACE-Bench 难度标准：
 * - 200+ 行代码修改
 * - 12+ 个文件
 * - 涉及多个独立模块的协调
 * - 需要理解分布式系统和实时通信概念
 * - 顶级模型成功率 < 10%
 */
export const M07: TestCase = {
  id: 'M07',
  name: '实时协作系统',
  category: 'multi-file',
  complexity: 'L6',

  prompt: `实现一个实时协作文档编辑系统（类似 Google Docs 的简化版）。

## 系统架构

### 1. 数据模型 (prisma/schema.prisma)
- Document: id, title, content, ownerId, createdAt, updatedAt, version
- DocumentVersion: id, documentId, content, version, createdBy, createdAt
- Collaborator: documentId, userId, permission (owner/editor/viewer), addedAt
- EditOperation: id, documentId, userId, operation (JSON), timestamp, applied
- Cursor: documentId, userId, position, selection, updatedAt
- Comment: id, documentId, userId, content, position, resolved, createdAt

### 2. WebSocket 服务 (src/realtime/)
- src/realtime/server.ts - WebSocket 服务器（Socket.io）
- src/realtime/rooms.ts - 房间管理（每个文档一个房间）
- src/realtime/presence.ts - 在线状态和光标同步
- src/realtime/operations.ts - 操作广播和冲突检测
- src/realtime/auth.ts - WebSocket 连接认证

### 3. OT (Operational Transformation) 模块 (src/ot/)
- src/ot/types.ts - 操作类型定义（insert, delete, retain）
- src/ot/transform.ts - OT 变换算法
- src/ot/compose.ts - 操作组合
- src/ot/apply.ts - 应用操作到文档
- src/ot/history.ts - 操作历史和撤销/重做

### 4. 文档服务 (src/services/)
- src/services/document.service.ts
  - createDocument, getDocument, updateDocument, deleteDocument
  - getVersionHistory, revertToVersion
  - addCollaborator, removeCollaborator, updatePermission

- src/services/sync.service.ts
  - applyOperation - 应用并广播操作
  - resolveConflict - 冲突解决
  - getServerState - 获取服务器端文档状态

### 5. API 路由 (src/api/routes/)
- src/api/routes/documents.ts
  - CRUD 操作
  - GET /documents/:id/versions - 版本历史
  - POST /documents/:id/collaborators - 添加协作者
  - GET /documents/:id/export - 导出文档

### 6. 前端组件 (src/components/)
- src/components/editor/CollabEditor.tsx - 主编辑器组件
- src/components/editor/Toolbar.tsx - 格式化工具栏
- src/components/editor/CursorOverlay.tsx - 协作者光标显示
- src/components/editor/PresenceIndicator.tsx - 在线用户列表
- src/components/editor/VersionHistory.tsx - 版本历史面板
- src/components/editor/CommentThread.tsx - 评论功能

### 7. 状态管理 (src/stores/)
- src/stores/documentStore.ts - 文档状态
- src/stores/collaborationStore.ts - 协作状态（光标、在线用户）
- src/stores/historyStore.ts - 本地操作历史

### 8. Hooks (src/hooks/)
- src/hooks/useCollaboration.ts - 协作连接管理
- src/hooks/usePresence.ts - 在线状态
- src/hooks/useOperations.ts - 操作发送和接收

### 9. 技术要求
- WebSocket 断线重连（指数退避）
- 操作队列和批量发送
- 乐观更新 + 服务器确认
- 冲突检测和自动解决
- 光标位置实时同步（节流 100ms）
- 文档自动保存（防抖 2s）

### 10. 测试
- src/__tests__/ot.test.ts - OT 算法单元测试
- src/__tests__/sync.test.ts - 同步逻辑测试
- src/__tests__/collaboration.test.ts - 协作功能集成测试`,

  fixture: 'fullstack-app',

  validations: [
    // 数据模型
    {
      type: 'file-contains',
      target: 'prisma/schema.prisma',
      contains: ['Document', 'DocumentVersion', 'Collaborator', 'EditOperation', 'Cursor'],
    },
    // WebSocket 服务
    {
      type: 'file-exists',
      target: 'src/realtime/server.ts',
    },
    {
      type: 'file-contains',
      target: 'src/realtime/server.ts',
      contains: ['socket', 'io'],
    },
    {
      type: 'file-exists',
      target: 'src/realtime/rooms.ts',
    },
    {
      type: 'file-exists',
      target: 'src/realtime/presence.ts',
    },
    // OT 模块
    {
      type: 'file-exists',
      target: 'src/ot/types.ts',
    },
    {
      type: 'file-exists',
      target: 'src/ot/transform.ts',
    },
    {
      type: 'file-contains',
      target: 'src/ot/transform.ts',
      contains: ['transform', 'insert', 'delete'],
    },
    {
      type: 'file-exists',
      target: 'src/ot/apply.ts',
    },
    // 服务层
    {
      type: 'file-exists',
      target: 'src/services/document.service.ts',
    },
    {
      type: 'file-exists',
      target: 'src/services/sync.service.ts',
    },
    // API 路由
    {
      type: 'file-exists',
      target: 'src/api/routes/documents.ts',
    },
    // 前端组件
    {
      type: 'file-exists',
      target: 'src/components/editor/CollabEditor.tsx',
    },
    {
      type: 'file-exists',
      target: 'src/components/editor/CursorOverlay.tsx',
    },
    {
      type: 'file-exists',
      target: 'src/components/editor/PresenceIndicator.tsx',
    },
    // 状态管理
    {
      type: 'file-exists',
      target: 'src/stores/documentStore.ts',
    },
    {
      type: 'file-exists',
      target: 'src/stores/collaborationStore.ts',
    },
    // Hooks
    {
      type: 'file-exists',
      target: 'src/hooks/useCollaboration.ts',
    },
  ],

  expectedBehavior: {
    agentDispatched: true,
    agentTypes: ['coder', 'code-explore', 'architect'],
    toolsUsed: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    toolCallRange: { min: 25, max: 120 },
    noBlindEdit: true,
  },

  tags: ['multi-file', 'realtime', 'websocket', 'collaboration', 'ot', 'L6'],
  timeout: 1800000, // 30分钟（L6 极复杂任务）

  stepByStepExecution: true,
  steps: [
    {
      instruction: '修改 prisma/schema.prisma 添加 Document, DocumentVersion, Collaborator, EditOperation, Cursor, Comment 模型',
      validation: { type: 'file-contains', target: 'prisma/schema.prisma', contains: ['Document', 'EditOperation', 'Cursor'] },
    },
    {
      instruction: '创建 OT 类型定义 src/ot/types.ts（insert, delete, retain 操作）',
      validation: { type: 'file-exists', target: 'src/ot/types.ts' },
    },
    {
      instruction: '实现 OT 变换算法 src/ot/transform.ts',
      validation: { type: 'file-exists', target: 'src/ot/transform.ts' },
    },
    {
      instruction: '实现操作应用 src/ot/apply.ts',
      validation: { type: 'file-exists', target: 'src/ot/apply.ts' },
    },
    {
      instruction: '创建 WebSocket 服务器 src/realtime/server.ts（使用 Socket.io）',
      validation: { type: 'file-exists', target: 'src/realtime/server.ts' },
    },
    {
      instruction: '实现房间管理 src/realtime/rooms.ts 和在线状态 src/realtime/presence.ts',
      validation: { type: 'file-exists', target: 'src/realtime/rooms.ts' },
    },
    {
      instruction: '创建文档服务 src/services/document.service.ts',
      validation: { type: 'file-exists', target: 'src/services/document.service.ts' },
    },
    {
      instruction: '创建同步服务 src/services/sync.service.ts（操作应用和冲突解决）',
      validation: { type: 'file-exists', target: 'src/services/sync.service.ts' },
    },
    {
      instruction: '创建文档 API 路由 src/api/routes/documents.ts',
      validation: { type: 'file-exists', target: 'src/api/routes/documents.ts' },
    },
    {
      instruction: '创建主编辑器组件 src/components/editor/CollabEditor.tsx',
      validation: { type: 'file-exists', target: 'src/components/editor/CollabEditor.tsx' },
    },
    {
      instruction: '创建光标显示组件 src/components/editor/CursorOverlay.tsx 和在线用户 src/components/editor/PresenceIndicator.tsx',
      validation: { type: 'file-exists', target: 'src/components/editor/CursorOverlay.tsx' },
    },
    {
      instruction: '创建状态管理 src/stores/documentStore.ts 和 src/stores/collaborationStore.ts',
      validation: { type: 'file-exists', target: 'src/stores/collaborationStore.ts' },
    },
    {
      instruction: '创建协作 Hook src/hooks/useCollaboration.ts',
      validation: { type: 'file-exists', target: 'src/hooks/useCollaboration.ts' },
    },
  ],

  nudgeOnMissingFile: true,
};

export default M07;
