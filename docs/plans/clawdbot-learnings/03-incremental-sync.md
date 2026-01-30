# 增量同步机制

## 问题描述

当前 Code Agent 在索引文件到记忆系统时可能是全量重建，存在以下问题：

1. **性能差**：每次同步都要处理所有文件
2. **资源浪费**：重复计算未变化文件的 embedding
3. **延迟高**：大项目同步时间长

## Clawdbot 实现分析

### 核心文件
- `src/memory/manager.ts` - 记忆管理器
- `src/memory/sync-memory-files.ts` - 记忆文件同步
- `src/memory/sync-session-files.ts` - 会话文件同步

### 关键实现

#### 1. 文件 Watcher

```typescript
import chokidar, { type FSWatcher } from "chokidar";

// 监听文件变化
const watcher = chokidar.watch(memoryDir, {
  persistent: true,
  ignoreInitial: false,
  ignored: ['**/node_modules/**', '**/.git/**'],
});

watcher.on('add', (path) => markDirty(path));
watcher.on('change', (path) => markDirty(path));
watcher.on('unlink', (path) => removeFromIndex(path));
```

#### 2. 脏标记 + 防抖

```typescript
const SESSION_DIRTY_DEBOUNCE_MS = 5000;

private dirty = false;
private sessionsDirty = false;
private sessionsDirtyFiles = new Set<string>();
private watchTimer: NodeJS.Timeout | null = null;

function markDirty(path: string) {
  this.dirty = true;
  this.sessionsDirtyFiles.add(path);

  // 防抖：5秒内的变化合并处理
  if (this.watchTimer) clearTimeout(this.watchTimer);
  this.watchTimer = setTimeout(() => {
    this.syncDirtyFiles();
  }, SESSION_DIRTY_DEBOUNCE_MS);
}
```

#### 3. 增量同步逻辑

```typescript
async function syncDirtyFiles() {
  const filesToSync = Array.from(this.sessionsDirtyFiles);
  this.sessionsDirtyFiles.clear();
  this.dirty = false;

  for (const filePath of filesToSync) {
    const currentHash = await computeFileHash(filePath);
    const storedHash = await getStoredHash(filePath);

    if (currentHash !== storedHash) {
      // 文件变化，重新索引
      await reindexFile(filePath);
      await updateStoredHash(filePath, currentHash);
    }
  }
}
```

#### 4. 会话 Delta 追踪

```typescript
// 追踪会话文件的增量变化
private sessionDeltas = new Map<
  string,
  { lastSize: number; pendingBytes: number; pendingMessages: number }
>();

async function syncSessionDelta(sessionPath: string) {
  const delta = this.sessionDeltas.get(sessionPath);
  const currentSize = (await fs.stat(sessionPath)).size;

  if (delta && currentSize > delta.lastSize) {
    // 只读取新增部分
    const newContent = await readFileTail(sessionPath, delta.lastSize);
    await indexNewContent(newContent);
    delta.lastSize = currentSize;
  }
}
```

## Code Agent 现状

当前 `src/main/memory/memoryService.ts` 可能没有增量同步机制，需要确认。

## 借鉴方案

### 实现步骤

#### Step 1: 添加文件哈希追踪

```typescript
// src/main/memory/fileTracker.ts
import crypto from 'crypto';
import fs from 'fs/promises';

interface FileEntry {
  path: string;
  hash: string;
  lastModified: number;
  indexed: boolean;
}

export class FileTracker {
  private entries = new Map<string, FileEntry>();
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async load(): Promise<void> {
    // 从 SQLite 加载已索引文件的哈希
  }

  async computeHash(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  async needsReindex(filePath: string): Promise<boolean> {
    const currentHash = await this.computeHash(filePath);
    const entry = this.entries.get(filePath);

    if (!entry) return true; // 新文件
    if (entry.hash !== currentHash) return true; // 内容变化

    return false;
  }

  async markIndexed(filePath: string, hash: string): Promise<void> {
    this.entries.set(filePath, {
      path: filePath,
      hash,
      lastModified: Date.now(),
      indexed: true,
    });
    // 持久化到 SQLite
  }
}
```

#### Step 2: 添加文件 Watcher

```typescript
// src/main/memory/fileWatcher.ts
import chokidar from 'chokidar';
import { EventEmitter } from 'events';

export class MemoryFileWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingChanges = new Set<string>();

  constructor(private watchDir: string, private debounceMs = 5000) {
    super();
  }

  start(): void {
    this.watcher = chokidar.watch(this.watchDir, {
      persistent: true,
      ignoreInitial: true,
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/*.log',
      ],
    });

    this.watcher.on('add', (path) => this.handleChange(path, 'add'));
    this.watcher.on('change', (path) => this.handleChange(path, 'change'));
    this.watcher.on('unlink', (path) => this.handleChange(path, 'unlink'));
  }

  private handleChange(path: string, event: string): void {
    this.pendingChanges.add(path);

    // 防抖
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const changes = Array.from(this.pendingChanges);
      this.pendingChanges.clear();
      this.emit('changes', changes);
    }, this.debounceMs);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
```

#### Step 3: 增量同步服务

```typescript
// src/main/memory/incrementalSync.ts
import { FileTracker } from './fileTracker';
import { MemoryFileWatcher } from './fileWatcher';
import { LocalVectorStore } from './localVectorStore';
import { MultiEmbeddingService } from './embeddingService';

export class IncrementalSyncService {
  private tracker: FileTracker;
  private watcher: MemoryFileWatcher;
  private vectorStore: LocalVectorStore;
  private embedding: MultiEmbeddingService;
  private syncing = false;

  constructor(config: {
    watchDir: string;
    dbPath: string;
    vectorStore: LocalVectorStore;
    embedding: MultiEmbeddingService;
  }) {
    this.tracker = new FileTracker(config.dbPath);
    this.watcher = new MemoryFileWatcher(config.watchDir);
    this.vectorStore = config.vectorStore;
    this.embedding = config.embedding;
  }

  async start(): Promise<void> {
    await this.tracker.load();

    this.watcher.on('changes', async (paths: string[]) => {
      await this.syncFiles(paths);
    });

    this.watcher.start();
  }

  async syncFiles(paths: string[]): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    try {
      for (const filePath of paths) {
        if (await this.tracker.needsReindex(filePath)) {
          await this.indexFile(filePath);
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  private async indexFile(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const chunks = this.chunkContent(content);
    const hash = await this.tracker.computeHash(filePath);

    // 删除旧的 chunks
    await this.vectorStore.deleteByPath(filePath);

    // 索引新的 chunks
    for (const chunk of chunks) {
      const [embedding] = await this.embedding.embed([chunk.content]);
      await this.vectorStore.upsertChunk({
        content: chunk.content,
        embedding,
        path: filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
    }

    await this.tracker.markIndexed(filePath, hash);
  }

  private chunkContent(content: string): Chunk[] {
    // 分块逻辑：按段落或固定 token 数
    const lines = content.split('\n');
    const chunks: Chunk[] = [];
    const chunkSize = 500; // tokens

    let currentChunk = '';
    let startLine = 1;

    for (let i = 0; i < lines.length; i++) {
      currentChunk += lines[i] + '\n';

      // 简单估算 token 数（实际应该用 tokenizer）
      if (currentChunk.length > chunkSize * 4) {
        chunks.push({
          content: currentChunk.trim(),
          startLine,
          endLine: i + 1,
        });
        currentChunk = '';
        startLine = i + 2;
      }
    }

    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        startLine,
        endLine: lines.length,
      });
    }

    return chunks;
  }

  stop(): void {
    this.watcher.stop();
  }
}

interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
}
```

#### Step 4: 集成到 MemoryService

```typescript
// 修改 src/main/memory/memoryService.ts
export class MemoryService {
  private incrementalSync: IncrementalSyncService;

  async initialize(): Promise<void> {
    this.incrementalSync = new IncrementalSyncService({
      watchDir: this.workspaceDir,
      dbPath: this.dbPath,
      vectorStore: this.vectorStore,
      embedding: this.embeddingService,
    });

    await this.incrementalSync.start();
  }

  async forceFullReindex(): Promise<void> {
    // 手动触发全量重建（如切换 embedding 提供商后）
    const allFiles = await glob('**/*.{ts,js,md,txt}', {
      cwd: this.workspaceDir,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });

    for (const file of allFiles) {
      await this.incrementalSync.indexFile(path.join(this.workspaceDir, file));
    }
  }
}
```

## 验收标准

1. **增量检测**：修改文件后只重新索引该文件
2. **防抖合并**：快速连续修改只触发一次同步
3. **哈希校验**：未变化的文件不重新索引
4. **持久化**：重启后能恢复索引状态
5. **性能**：1000 文件项目，单文件修改同步 < 2s

## 风险与注意事项

1. **Watcher 资源**：大量文件时 watcher 占用资源
2. **并发安全**：同时修改多文件时的竞态条件
3. **错误恢复**：同步中断后的恢复机制

## 参考资料

- [chokidar](https://github.com/paulmillr/chokidar) - 跨平台文件监听
- [Clawdbot sync-memory-files.ts](https://github.com/clawdbot/clawdbot/blob/main/src/memory/sync-memory-files.ts)
