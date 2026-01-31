# File Checkpointing 设计文档

## 概述

为 code-agent 实现文件检查点功能，允许用户回滚 Agent 对文件的修改。

## 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 服务架构 | 独立 FileCheckpointService | 与现有 CheckpointManager 职责分离 |
| 存储方式 | SQLite | 统一管理、事务支持、级联删除 |
| 创建时机 | 中间件拦截 | 非侵入式、集中管理 |
| 回滚范围 | 消息及之后所有修改 | 类似 git reset 语义 |
| 新建文件回滚 | 删除文件 | 恢复到"文件不存在"状态 |

## 数据结构

### 数据库表

```sql
CREATE TABLE file_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  original_content TEXT,
  file_existed BOOLEAN NOT NULL,
  created_at INTEGER NOT NULL,

  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_checkpoints_session ON file_checkpoints(session_id);
CREATE INDEX idx_checkpoints_message ON file_checkpoints(message_id);
CREATE INDEX idx_checkpoints_created ON file_checkpoints(created_at);
```

### TypeScript 类型

```typescript
interface FileCheckpoint {
  id: string;
  sessionId: string;
  messageId: string;
  filePath: string;
  originalContent: string | null;
  fileExisted: boolean;
  createdAt: number;
}

interface RewindResult {
  success: boolean;
  restoredFiles: string[];
  deletedFiles: string[];
  errors: Array<{ filePath: string; error: string }>;
}
```

## 服务接口

```typescript
class FileCheckpointService {
  private readonly MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
  private readonly MAX_CHECKPOINTS_PER_SESSION = 50;
  private readonly RETENTION_DAYS = 7;

  async createCheckpoint(sessionId: string, messageId: string, filePath: string): Promise<string | null>;
  async rewindFiles(sessionId: string, messageId: string): Promise<RewindResult>;
  async getCheckpoints(sessionId: string): Promise<FileCheckpoint[]>;
  async cleanup(): Promise<number>;
}
```

## 中间件集成

```typescript
const FILE_WRITE_TOOLS = ['write_file', 'edit_file'];

class FileCheckpointMiddleware {
  wrap(executor: ToolExecutor): ToolExecutor {
    return async (tool, params, context) => {
      if (FILE_WRITE_TOOLS.includes(tool.name)) {
        const session = this.getCurrentSession();
        if (session) {
          await this.checkpointService.createCheckpoint(
            session.sessionId,
            session.messageId,
            params.file_path || params.path
          );
        }
      }
      return executor(tool, params, context);
    };
  }
}
```

## IPC 接口

```typescript
'checkpoint:list': (sessionId: string) => FileCheckpoint[];
'checkpoint:rewind': (sessionId: string, messageId: string) => RewindResult;
'checkpoint:cleanup': () => number;
```

## 清理机制

- 每个 session 最多保留 50 个检查点（FIFO）
- session 归档 7 天后自动清理
- 应用启动时执行一次清理

## 文件结构

```
src/main/
├── services/checkpoint/
│   └── fileCheckpointService.ts
├── tools/middleware/
│   └── fileCheckpointMiddleware.ts
└── ipc/
    └── checkpoint.ipc.ts

src/shared/types/
└── checkpoint.ts
```

## 验收标准

- edit_file 修改文件后，调用 rewindFiles 能恢复原内容
- 大文件(>1MB)跳过检查点
- TypeScript 类型检查通过
- 每 session 最多 50 个检查点
- 7 天后自动清理

## 不包含

- 前端 UI（另一个任务）
- 目录级别的检查点
