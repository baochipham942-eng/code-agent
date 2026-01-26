# Memory 可视化与管理功能升级规划

> 版本: v1.0
> 日期: 2025-01-21
> 状态: 待实现

## 1. 背景与目标

### 1.1 现状问题

Code Agent 已有完整的后端记忆系统（三层架构 + 向量存储 + 自动学习），但存在以下问题：

| 问题 | 影响 |
|------|------|
| **记忆不可见** | 用户不知道 AI 记住了什么 |
| **无法管理** | 无法删除错误记忆、编辑过时信息 |
| **分类不直观** | 现有分类（preference/pattern/decision...）面向开发者，非用户友好 |
| **缺少主动学习确认** | AI 学到东西用户不知道 |

### 1.2 目标

1. **让记忆对用户可见** - 用户能看到"AI 记住了什么"
2. **让记忆可管理** - 删除、编辑、搜索
3. **用户友好的分类** - 按用途而非技术类型组织
4. **学习透明化** - AI 学到新东西时通知用户

---

## 2. 核心设计

### 2.1 记忆分类体系（新）

从技术分类转向用户友好分类：

| 新分类 | 英文 Key | 存储内容 | 原分类映射 |
|--------|----------|----------|------------|
| **关于我** | `about_me` | 身份、角色、沟通风格 | 新增 |
| **我的偏好** | `preference` | 格式、风格、工具偏好 | preference |
| **常用信息** | `frequent_info` | 邮箱、模板、常用数据 | context |
| **学到的经验** | `learned` | AI 观察到的模式/习惯 | pattern, insight, error_solution, decision |

### 2.2 数据结构

```typescript
// 新的记忆条目结构
interface MemoryItem {
  id: string
  content: string                    // "代码用 2 空格缩进"
  category: MemoryCategory           // 'about_me' | 'preference' | 'frequent_info' | 'learned'
  source: 'explicit' | 'learned'     // 用户主动说 vs AI 学到
  confidence: number                 // 0-1，learned 类型需要
  createdAt: number                  // timestamp
  updatedAt: number
  sourceSessionId?: string           // 来自哪个对话
  sourceContext?: string             // 学习时的上下文摘要
  tags?: string[]                    // 可选标签，便于搜索
}

type MemoryCategory = 'about_me' | 'preference' | 'frequent_info' | 'learned'
```

### 2.3 UI 设计

#### 入口位置

设置面板新增「我的记忆」标签页（Memory Tab）

#### 界面布局

```
┌─────────────────────────────────────────────────────────────────┐
│  我的记忆                                                        │
├─────────────────────────────────────────────────────────────────┤
│  [搜索记忆...]                              [导出] [清空全部]    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  👤 关于我                                              [3 条]   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ "我是产品经理，在上海工作"                                  │ │
│  │ 来源: 2025-01-15 对话                      [编辑] [删除]   │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ "喜欢简洁直接的回复风格"                                    │ │
│  │ 来源: 2025-01-10 对话                      [编辑] [删除]   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ⭐ 我的偏好                                             [5 条]   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ "代码用 2 空格缩进"                                        │ │
│  │ 来源: AI 学习 (置信度 95%)                 [编辑] [删除]   │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ...                                                             │
│                                                                  │
│  📋 常用信息                                             [4 条]   │
│  ...                                                             │
│                                                                  │
│  💡 学到的经验                                           [6 条]   │
│  ...                                                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 交互功能

| 功能 | 描述 |
|------|------|
| **搜索** | 全文搜索所有记忆 |
| **按分类折叠** | 点击分类标题展开/收起 |
| **删除** | 单条删除，需确认 |
| **编辑** | 修改记忆内容 |
| **查看来源** | 显示来自哪个对话 |
| **批量清空** | 清空某分类或全部 |
| **导出** | JSON 格式导出 |

---

## 3. 实现计划

### Phase 1: 后端基础（1-2 天）

#### 任务 1.1: 数据库迁移

- [ ] 新增 `memories` 表（或扩展 `project_knowledge`）
- [ ] 添加 `category`, `source`, `sourceSessionId`, `sourceContext` 字段
- [ ] 迁移现有数据到新分类

```sql
-- 新表结构
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL,           -- 'about_me' | 'preference' | 'frequent_info' | 'learned'
  source TEXT NOT NULL DEFAULT 'explicit',  -- 'explicit' | 'learned'
  confidence REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_session_id TEXT,
  source_context TEXT,
  tags TEXT,                        -- JSON array
  project_path TEXT                 -- 可选，项目级记忆
);

CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_project ON memories(project_path);
```

#### 任务 1.2: MemoryService 扩展

- [ ] `getAllMemories(category?)` - 获取所有记忆
- [ ] `updateMemory(id, content)` - 更新记忆
- [ ] `deleteMemory(id)` - 删除单条
- [ ] `deleteByCategory(category)` - 删除整个分类
- [ ] `searchMemories(query)` - 全文搜索
- [ ] `exportMemories()` - 导出 JSON
- [ ] `importMemories(data)` - 导入

#### 任务 1.3: IPC 通道

- [ ] 扩展 `memory` domain，添加新 actions:
  - `list` - 列出所有记忆
  - `update` - 更新
  - `delete` - 删除
  - `deleteByCategory` - 按分类删除
  - `export` - 导出
  - `import` - 导入

### Phase 2: 前端 UI（2-3 天）

#### 任务 2.1: MemoryTab 组件

- [ ] 创建 `src/renderer/components/features/settings/MemoryTab.tsx`
- [ ] 实现分类折叠列表
- [ ] 实现搜索框
- [ ] 实现记忆卡片（显示内容、来源、操作按钮）

#### 任务 2.2: 记忆操作组件

- [ ] `MemoryEditModal` - 编辑弹窗
- [ ] `MemoryDeleteConfirm` - 删除确认
- [ ] `MemoryClearConfirm` - 批量清空确认

#### 任务 2.3: 设置面板集成

- [ ] 在 `SettingsModal.tsx` 添加 Memory 标签页
- [ ] 添加 i18n 翻译

### Phase 3: 学习通知（1 天）

#### 任务 3.1: 学习事件通知

- [ ] AI 学到新记忆时，通过 toast 通知用户
- [ ] 格式: "我记住了: [内容摘要]" + [查看] 按钮

#### 任务 3.2: 学习确认（可选）

- [ ] 低置信度记忆（<0.8）询问用户确认
- [ ] 格式: "我注意到你喜欢 X，要我记住吗？" [是] [否]

### Phase 4: 增强功能（可选，后续迭代）

- [ ] 记忆时间线视图
- [ ] 记忆冲突检测与合并
- [ ] 跨设备同步
- [ ] 记忆统计面板

---

## 4. 文件清单

### 新增文件

| 文件 | 描述 |
|------|------|
| `src/main/memory/memoryManager.ts` | 记忆管理核心逻辑 |
| `src/main/ipc/memoryManagement.ipc.ts` | 记忆管理 IPC（或扩展现有） |
| `src/renderer/components/features/settings/MemoryTab.tsx` | 记忆标签页 |
| `src/renderer/components/features/settings/MemoryCard.tsx` | 记忆卡片组件 |
| `src/renderer/components/features/settings/MemoryEditModal.tsx` | 编辑弹窗 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src/main/services/core/databaseService.ts` | 添加 memories 表 |
| `src/main/memory/memoryService.ts` | 添加管理 API |
| `src/main/ipc/memory.ipc.ts` | 添加新 actions |
| `src/shared/ipc/protocol.ts` | 添加类型定义 |
| `src/renderer/components/features/settings/SettingsModal.tsx` | 添加 Memory Tab |
| `src/renderer/i18n/zh.ts` | 添加中文翻译 |
| `src/renderer/i18n/en.ts` | 添加英文翻译 |

---

## 5. 技术要点

### 5.1 分类迁移逻辑

```typescript
// 旧分类 → 新分类映射
const categoryMigration: Record<string, MemoryCategory> = {
  'preference': 'preference',
  'pattern': 'learned',
  'decision': 'learned',
  'context': 'frequent_info',
  'insight': 'learned',
  'error_solution': 'learned',
}
```

### 5.2 记忆工具兼容

保持 `memory_store` 工具向后兼容，内部做分类映射：

```typescript
// memory_store 工具调用时
if (oldCategory === 'pattern') {
  newCategory = 'learned'
  source = 'learned'
}
```

### 5.3 学习通知机制

```typescript
// 在 auto_learn 执行后
eventBus.emit('memory:learned', {
  content: memory.content,
  category: memory.category,
  confidence: memory.confidence,
})

// 前端监听
useEffect(() => {
  const unsubscribe = window.electronAPI.on('memory:learned', (data) => {
    toast.info(`我记住了: ${data.content.slice(0, 50)}...`, {
      action: { label: '查看', onClick: openMemoryPanel }
    })
  })
  return unsubscribe
}, [])
```

---

## 6. 验收标准

### Phase 1 完成标准

- [ ] `memories` 表创建成功
- [ ] 现有数据迁移完成
- [ ] 所有 CRUD API 可用
- [ ] IPC 通道测试通过

### Phase 2 完成标准

- [ ] Memory Tab 在设置中可见
- [ ] 四个分类正确显示
- [ ] 搜索功能正常
- [ ] 删除/编辑功能正常
- [ ] 导出功能正常

### Phase 3 完成标准

- [ ] AI 学习时有 toast 通知
- [ ] 点击通知可跳转到记忆面板

---

## 7. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 数据迁移丢失 | 迁移前自动备份，提供回滚脚本 |
| 性能问题（记忆过多） | 分页加载，虚拟列表 |
| 用户误删重要记忆 | 删除需确认，提供"最近删除"恢复 |

---

## 8. 后续迭代方向

1. **记忆时间线** - 可视化记忆演变过程
2. **记忆冲突处理** - 检测矛盾记忆，智能合并
3. **项目级记忆** - 切换项目时自动切换记忆上下文
4. **云端同步** - 跨设备记忆同步
5. **记忆洞察** - 统计面板，学习趋势分析
