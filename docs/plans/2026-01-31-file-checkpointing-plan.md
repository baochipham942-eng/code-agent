# File Checkpointing 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现文件检查点功能，允许用户回滚 Agent 对文件的修改。

**Architecture:** 创建独立的 FileCheckpointService，通过中间件拦截 write_file/edit_file 工具调用，在执行前保存原文件内容到 SQLite。提供 rewindFiles 方法恢复文件到指定消息之前的状态。

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Electron IPC

---

## Task 1: 添加类型定义

**Files:**
- Create: `src/shared/types/checkpoint.ts`
- Modify: `src/shared/types/index.ts`

**Step 1: 创建检查点类型文件**

```typescript
// src/shared/types/checkpoint.ts

/**
 * 文件检查点记录
 */
export interface FileCheckpoint {
  id: string;
  sessionId: string;
  messageId: string;
  filePath: string;
  originalContent: string | null;  // null 表示文件原本不存在
  fileExisted: boolean;
  createdAt: number;
}

/**
 * 回滚操作结果
 */
export interface RewindResult {
  success: boolean;
  restoredFiles: string[];   // 恢复的文件路径
  deletedFiles: string[];    // 删除的文件路径（原本不存在的）
  errors: Array<{ filePath: string; error: string }>;
}

/**
 * 检查点服务配置
 */
export interface FileCheckpointConfig {
  maxFileSizeBytes: number;        // 默认 1MB
  maxCheckpointsPerSession: number; // 默认 50
  retentionDays: number;            // 默认 7
}
```

**Step 2: 导出类型**

在 `src/shared/types/index.ts` 末尾添加：

```typescript
export * from './checkpoint';
```

**Step 3: 运行类型检查**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/shared/types/checkpoint.ts src/shared/types/index.ts
git commit -m "feat(checkpoint): add FileCheckpoint type definitions"
```

---

## Task 2: 添加数据库表

**Files:**
- Modify: `src/main/services/core/databaseService.ts`

**Step 1: 在 createTables 方法中添加 file_checkpoints 表**

在 `createTables()` 方法末尾（约第 248 行 memories 表之后）添加：

```typescript
    // File Checkpoints 表 (文件回滚检查点)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_content TEXT,
        file_existed INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);
```

**Step 2: 在 createIndexes 方法中添加索引**

找到 `createIndexes()` 方法，添加：

```typescript
    // File Checkpoints indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_file_checkpoints_session ON file_checkpoints(session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_file_checkpoints_message ON file_checkpoints(message_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_file_checkpoints_created ON file_checkpoints(created_at)`);
```

**Step 3: 运行类型检查**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/main/services/core/databaseService.ts
git commit -m "feat(checkpoint): add file_checkpoints table schema"
```

---

## Task 3: 实现 FileCheckpointService

**Files:**
- Create: `src/main/services/checkpoint/fileCheckpointService.ts`
- Create: `src/main/services/checkpoint/index.ts`

**Step 1: 创建 FileCheckpointService**

```typescript
// src/main/services/checkpoint/fileCheckpointService.ts

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDatabaseService } from '../index';
import { createLogger } from '../infra/logger';
import type { FileCheckpoint, RewindResult, FileCheckpointConfig } from '../../../shared/types';

const logger = createLogger('FileCheckpointService');

const DEFAULT_CONFIG: FileCheckpointConfig = {
  maxFileSizeBytes: 1 * 1024 * 1024, // 1MB
  maxCheckpointsPerSession: 50,
  retentionDays: 7,
};

export class FileCheckpointService {
  private config: FileCheckpointConfig;

  constructor(config: Partial<FileCheckpointConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 创建检查点（工具执行前调用）
   * @returns checkpointId，跳过时返回 null
   */
  async createCheckpoint(
    sessionId: string,
    messageId: string,
    filePath: string
  ): Promise<string | null> {
    const db = getDatabaseService();
    if (!db) {
      logger.warn('Database service not available');
      return null;
    }

    try {
      // 解析绝对路径
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(filePath);

      // 检查文件是否存在
      let fileExisted = false;
      let originalContent: string | null = null;
      let fileSize = 0;

      try {
        const stats = await fs.stat(absolutePath);
        fileExisted = true;
        fileSize = stats.size;

        // 跳过大文件
        if (fileSize > this.config.maxFileSizeBytes) {
          logger.debug('Skipping large file', { filePath: absolutePath, size: fileSize });
          return null;
        }

        originalContent = await fs.readFile(absolutePath, 'utf-8');
      } catch (err) {
        // 文件不存在，这是合法的（新建文件场景）
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }

      // 检查并强制执行每 session 上限
      await this.enforceLimit(sessionId);

      // 创建检查点
      const id = `ckpt_${Date.now()}_${uuidv4().slice(0, 8)}`;
      const createdAt = Date.now();

      db.getDatabase()?.prepare(`
        INSERT INTO file_checkpoints (id, session_id, message_id, file_path, original_content, file_existed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, messageId, absolutePath, originalContent, fileExisted ? 1 : 0, createdAt);

      logger.debug('Checkpoint created', { id, sessionId, messageId, filePath: absolutePath, fileExisted });
      return id;
    } catch (error) {
      logger.error('Failed to create checkpoint', { error, sessionId, messageId, filePath });
      return null;
    }
  }

  /**
   * 回滚到指定消息之前的状态
   */
  async rewindFiles(sessionId: string, messageId: string): Promise<RewindResult> {
    const db = getDatabaseService();
    if (!db) {
      return { success: false, restoredFiles: [], deletedFiles: [], errors: [{ filePath: '', error: 'Database not available' }] };
    }

    const result: RewindResult = {
      success: true,
      restoredFiles: [],
      deletedFiles: [],
      errors: [],
    };

    try {
      // 获取目标消息的创建时间
      const targetCheckpoint = db.getDatabase()?.prepare(`
        SELECT created_at FROM file_checkpoints
        WHERE session_id = ? AND message_id = ?
        ORDER BY created_at ASC LIMIT 1
      `).get(sessionId, messageId) as { created_at: number } | undefined;

      if (!targetCheckpoint) {
        logger.warn('No checkpoint found for message', { sessionId, messageId });
        return { success: false, restoredFiles: [], deletedFiles: [], errors: [{ filePath: '', error: 'No checkpoint found for message' }] };
      }

      // 获取该消息及之后的所有检查点（按时间倒序，最新的先处理）
      const checkpoints = db.getDatabase()?.prepare(`
        SELECT * FROM file_checkpoints
        WHERE session_id = ? AND created_at >= ?
        ORDER BY created_at DESC
      `).all(sessionId, targetCheckpoint.created_at) as Array<{
        id: string;
        file_path: string;
        original_content: string | null;
        file_existed: number;
      }>;

      if (!checkpoints || checkpoints.length === 0) {
        return result;
      }

      // 按文件路径分组，只保留每个文件最早的检查点（即最原始的状态）
      const fileToOriginal = new Map<string, { content: string | null; existed: boolean }>();
      for (const ckpt of checkpoints) {
        if (!fileToOriginal.has(ckpt.file_path)) {
          fileToOriginal.set(ckpt.file_path, {
            content: ckpt.original_content,
            existed: ckpt.file_existed === 1,
          });
        }
      }

      // 恢复每个文件
      for (const [filePath, original] of fileToOriginal) {
        try {
          if (original.existed) {
            // 文件原本存在，恢复内容
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, original.content || '', 'utf-8');
            result.restoredFiles.push(filePath);
          } else {
            // 文件原本不存在，删除它
            try {
              await fs.unlink(filePath);
              result.deletedFiles.push(filePath);
            } catch (err) {
              // 文件可能已被手动删除，忽略
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
              }
            }
          }
        } catch (error) {
          result.success = false;
          result.errors.push({ filePath, error: String(error) });
          logger.error('Failed to restore file', { filePath, error });
        }
      }

      // 删除已回滚的检查点记录
      db.getDatabase()?.prepare(`
        DELETE FROM file_checkpoints
        WHERE session_id = ? AND created_at >= ?
      `).run(sessionId, targetCheckpoint.created_at);

      logger.info('Files rewound', {
        sessionId,
        messageId,
        restoredCount: result.restoredFiles.length,
        deletedCount: result.deletedFiles.length,
        errorCount: result.errors.length,
      });

      return result;
    } catch (error) {
      logger.error('Failed to rewind files', { error, sessionId, messageId });
      return { success: false, restoredFiles: [], deletedFiles: [], errors: [{ filePath: '', error: String(error) }] };
    }
  }

  /**
   * 获取 session 的所有检查点
   */
  async getCheckpoints(sessionId: string): Promise<FileCheckpoint[]> {
    const db = getDatabaseService();
    if (!db) return [];

    try {
      const rows = db.getDatabase()?.prepare(`
        SELECT id, session_id, message_id, file_path, original_content, file_existed, created_at
        FROM file_checkpoints
        WHERE session_id = ?
        ORDER BY created_at DESC
      `).all(sessionId) as Array<{
        id: string;
        session_id: string;
        message_id: string;
        file_path: string;
        original_content: string | null;
        file_existed: number;
        created_at: number;
      }>;

      return (rows || []).map(row => ({
        id: row.id,
        sessionId: row.session_id,
        messageId: row.message_id,
        filePath: row.file_path,
        originalContent: row.original_content,
        fileExisted: row.file_existed === 1,
        createdAt: row.created_at,
      }));
    } catch (error) {
      logger.error('Failed to get checkpoints', { error, sessionId });
      return [];
    }
  }

  /**
   * 清理过期检查点
   */
  async cleanup(): Promise<number> {
    const db = getDatabaseService();
    if (!db) return 0;

    try {
      const expiryTime = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;

      // 删除过期 session 的检查点（基于 session 最后更新时间）
      const result = db.getDatabase()?.prepare(`
        DELETE FROM file_checkpoints
        WHERE session_id IN (
          SELECT id FROM sessions
          WHERE updated_at < ? OR is_archived = 1
        )
      `).run(expiryTime);

      const deletedCount = result?.changes || 0;
      if (deletedCount > 0) {
        logger.info('Cleaned up expired checkpoints', { count: deletedCount });
      }
      return deletedCount;
    } catch (error) {
      logger.error('Failed to cleanup checkpoints', { error });
      return 0;
    }
  }

  /**
   * 强制执行每 session 上限
   */
  private async enforceLimit(sessionId: string): Promise<void> {
    const db = getDatabaseService();
    if (!db) return;

    try {
      const countResult = db.getDatabase()?.prepare(`
        SELECT COUNT(*) as cnt FROM file_checkpoints WHERE session_id = ?
      `).get(sessionId) as { cnt: number } | undefined;

      const count = countResult?.cnt || 0;
      if (count >= this.config.maxCheckpointsPerSession) {
        // 删除最旧的检查点
        const deleteCount = count - this.config.maxCheckpointsPerSession + 1;
        db.getDatabase()?.prepare(`
          DELETE FROM file_checkpoints
          WHERE id IN (
            SELECT id FROM file_checkpoints
            WHERE session_id = ?
            ORDER BY created_at ASC
            LIMIT ?
          )
        `).run(sessionId, deleteCount);

        logger.debug('Enforced checkpoint limit', { sessionId, deleted: deleteCount });
      }
    } catch (error) {
      logger.error('Failed to enforce limit', { error, sessionId });
    }
  }
}

// Singleton
let instance: FileCheckpointService | null = null;

export function getFileCheckpointService(): FileCheckpointService {
  if (!instance) {
    instance = new FileCheckpointService();
  }
  return instance;
}

export function initFileCheckpointService(config?: Partial<FileCheckpointConfig>): FileCheckpointService {
  instance = new FileCheckpointService(config);
  return instance;
}
```

**Step 2: 创建 index.ts 导出**

```typescript
// src/main/services/checkpoint/index.ts

export * from './fileCheckpointService';
```

**Step 3: 运行类型检查**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/main/services/checkpoint/
git commit -m "feat(checkpoint): implement FileCheckpointService"
```

---

## Task 4: 实现检查点中间件

**Files:**
- Create: `src/main/tools/middleware/fileCheckpointMiddleware.ts`
- Modify: `src/main/tools/toolExecutor.ts`

**Step 1: 创建中间件文件**

```typescript
// src/main/tools/middleware/fileCheckpointMiddleware.ts

import { getFileCheckpointService } from '../../services/checkpoint';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('FileCheckpointMiddleware');

// 需要创建检查点的工具
const FILE_WRITE_TOOLS = ['write_file', 'edit_file'];

/**
 * 检查点上下文提供者
 */
export interface CheckpointContext {
  sessionId: string;
  messageId: string;
}

export type CheckpointContextProvider = () => CheckpointContext | null;

/**
 * 在文件写入工具执行前创建检查点
 */
export async function createFileCheckpointIfNeeded(
  toolName: string,
  params: Record<string, unknown>,
  getContext: CheckpointContextProvider
): Promise<void> {
  // 只对文件写入工具创建检查点
  if (!FILE_WRITE_TOOLS.includes(toolName)) {
    return;
  }

  const context = getContext();
  if (!context) {
    logger.debug('No checkpoint context available');
    return;
  }

  const filePath = (params.file_path || params.path) as string | undefined;
  if (!filePath) {
    logger.debug('No file path in params', { toolName });
    return;
  }

  try {
    const service = getFileCheckpointService();
    await service.createCheckpoint(context.sessionId, context.messageId, filePath);
  } catch (error) {
    // 检查点失败不应阻止工具执行
    logger.error('Failed to create checkpoint', { error, toolName, filePath });
  }
}
```

**Step 2: 在 ToolExecutor.execute 中集成中间件**

在 `src/main/tools/toolExecutor.ts` 的 `execute` 方法开头（约第 143 行）添加导入和调用：

在文件顶部添加导入：
```typescript
import { createFileCheckpointIfNeeded } from './middleware/fileCheckpointMiddleware';
```

在 `execute` 方法中，tool 查找之后、权限检查之前（约第 165 行之前）添加：

```typescript
    // 文件检查点：在写入工具执行前保存原文件
    await createFileCheckpointIfNeeded(toolName, params, () => {
      if (!options.sessionId) return null;
      // messageId 从 context 中获取，如果没有则使用工具调用 ID
      const messageId = options.currentToolCallId || `msg_${Date.now()}`;
      return { sessionId: options.sessionId, messageId };
    });
```

**Step 3: 运行类型检查**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/main/tools/middleware/ src/main/tools/toolExecutor.ts
git commit -m "feat(checkpoint): integrate file checkpoint middleware into ToolExecutor"
```

---

## Task 5: 添加 IPC 处理器

**Files:**
- Create: `src/main/ipc/checkpoint.ipc.ts`
- Modify: `src/main/ipc/index.ts`

**Step 1: 创建 checkpoint.ipc.ts**

```typescript
// src/main/ipc/checkpoint.ipc.ts

import type { IpcMain } from 'electron';
import { getFileCheckpointService } from '../services/checkpoint';
import { createLogger } from '../services/infra/logger';
import type { FileCheckpoint, RewindResult } from '../../shared/types';

const logger = createLogger('CheckpointIPC');

/**
 * 注册检查点相关的 IPC handlers
 */
export function registerCheckpointHandlers(ipcMain: IpcMain): void {
  // 获取 session 的检查点列表
  ipcMain.handle('checkpoint:list', async (_, sessionId: string): Promise<FileCheckpoint[]> => {
    try {
      const service = getFileCheckpointService();
      return await service.getCheckpoints(sessionId);
    } catch (error) {
      logger.error('Failed to list checkpoints', { error, sessionId });
      return [];
    }
  });

  // 回滚文件到指定消息之前
  ipcMain.handle('checkpoint:rewind', async (_, sessionId: string, messageId: string): Promise<RewindResult> => {
    try {
      const service = getFileCheckpointService();
      return await service.rewindFiles(sessionId, messageId);
    } catch (error) {
      logger.error('Failed to rewind files', { error, sessionId, messageId });
      return {
        success: false,
        restoredFiles: [],
        deletedFiles: [],
        errors: [{ filePath: '', error: String(error) }],
      };
    }
  });

  // 手动触发清理
  ipcMain.handle('checkpoint:cleanup', async (): Promise<number> => {
    try {
      const service = getFileCheckpointService();
      return await service.cleanup();
    } catch (error) {
      logger.error('Failed to cleanup checkpoints', { error });
      return 0;
    }
  });

  logger.debug('Checkpoint IPC handlers registered');
}
```

**Step 2: 在 index.ts 中注册**

在 `src/main/ipc/index.ts` 中：

1. 添加导入（约第 37 行）：
```typescript
import { registerCheckpointHandlers } from './checkpoint.ipc';
```

2. 在 `setupAllIpcHandlers` 函数末尾添加注册调用：
```typescript
  // Checkpoint handlers
  registerCheckpointHandlers(ipcMain);
```

**Step 3: 运行类型检查**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/main/ipc/checkpoint.ipc.ts src/main/ipc/index.ts
git commit -m "feat(checkpoint): add IPC handlers for checkpoint operations"
```

---

## Task 6: 初始化服务和启动清理

**Files:**
- Modify: `src/main/app/bootstrap.ts`

**Step 1: 添加导入**

在 `bootstrap.ts` 顶部导入部分添加：
```typescript
import { initFileCheckpointService, getFileCheckpointService } from '../services/checkpoint';
```

**Step 2: 在核心服务初始化中添加检查点服务**

找到核心服务初始化函数（约第 100 行 `initCoreServices`），在数据库初始化之后添加：

```typescript
    // 初始化文件检查点服务
    initFileCheckpointService();
    logger.info('File checkpoint service initialized');
```

**Step 3: 在后台服务初始化中添加清理**

找到后台服务初始化部分，添加检查点清理：

```typescript
    // 清理过期检查点（启动时执行一次）
    getFileCheckpointService().cleanup().then(count => {
      if (count > 0) {
        logger.info('Cleaned up expired file checkpoints', { count });
      }
    }).catch(err => {
      logger.warn('Failed to cleanup file checkpoints', { error: err });
    });
```

**Step 4: 运行类型检查**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/app/bootstrap.ts
git commit -m "feat(checkpoint): initialize service and cleanup on startup"
```

---

## Task 7: 更新服务导出

**Files:**
- Modify: `src/main/services/index.ts`

**Step 1: 添加导出**

在 `src/main/services/index.ts` 中添加：

```typescript
export * from './checkpoint';
```

**Step 2: 运行类型检查**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/main/services/index.ts
git commit -m "feat(checkpoint): export checkpoint service from services index"
```

---

## Task 8: 验证完整功能

**Step 1: 构建项目**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run build`
Expected: PASS

**Step 2: 运行类型检查**

Run: `cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck`
Expected: PASS

**Step 3: 测试场景**

手动测试（在开发模式下）：
1. 启动应用 `npm run dev`
2. 创建新 session
3. 使用 edit_file 修改一个文件
4. 检查 SQLite 数据库中是否有检查点记录
5. 调用 rewindFiles 恢复文件
6. 验证文件内容已恢复

**Step 4: Final Commit**

```bash
git add -A
git commit -m "feat(checkpoint): complete file checkpointing feature implementation"
```

---

## 验收标准检查

- [ ] edit_file 修改文件后，调用 rewindFiles 能恢复原内容
- [ ] 大文件(>1MB)跳过检查点
- [ ] TypeScript 类型检查通过
- [ ] 每 session 最多 50 个检查点
- [ ] 7 天后自动清理
