# 本地向量存储

## 问题描述

当前 Code Agent 的向量存储依赖 Supabase pgvector（云端），存在以下问题：

1. **离线不可用**：没有网络就无法使用记忆功能
2. **延迟较高**：每次查询都需要网络往返
3. **成本问题**：Supabase 有免费额度限制
4. **隐私顾虑**：用户数据上传到云端

## Clawdbot 实现分析

### 核心文件
- `src/memory/manager.ts` (73KB) - 记忆管理器
- `src/memory/embeddings.ts` (7KB) - Embedding 提供商抽象
- `src/memory/embeddings-openai.ts` - OpenAI Embedding
- `src/memory/embeddings-gemini.ts` - Gemini Embedding
- `src/memory/sqlite-vec.ts` - sqlite-vec 扩展加载
- `src/memory/hybrid.ts` - 混合搜索（向量 + FTS）

### 关键实现

#### 1. sqlite-vec 本地向量存储

```typescript
// 加载 sqlite-vec 扩展
import { requireNodeSqlite } from "./sqlite.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";

const db = requireNodeSqlite();
loadSqliteVecExtension(db);

// 创建向量表
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
    embedding float[${dims}]
  );
`);

// 向量转 blob
const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

// 插入向量
db.prepare(`
  INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)
`).run(rowId, vectorToBlob(embedding));

// 向量搜索
db.prepare(`
  SELECT rowid, distance
  FROM chunks_vec
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT ?
`).all(vectorToBlob(queryEmbedding), limit);
```

#### 2. 多 Embedding 提供商

```typescript
type EmbeddingProvider = "openai" | "gemini" | "local";

async function createEmbeddingProvider(params: {
  provider: EmbeddingProvider;
  fallback?: EmbeddingProvider;
}): Promise<EmbeddingProviderResult> {
  // 尝试主提供商
  try {
    if (params.provider === "openai") {
      return createOpenAiProvider();
    } else if (params.provider === "gemini") {
      return createGeminiProvider();
    } else {
      return createLocalProvider();
    }
  } catch (err) {
    // 降级到 fallback
    if (params.fallback) {
      return createEmbeddingProvider({ provider: params.fallback });
    }
    throw err;
  }
}
```

#### 3. 混合搜索（向量 + 全文）

```typescript
// FTS 全文搜索
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content, path, tokenize='porter'
  );
`);

// 混合搜索
function hybridSearch(query: string, limit: number) {
  // 1. 向量搜索
  const vectorResults = searchVector(queryEmbedding, limit * 2);

  // 2. FTS 搜索
  const ftsResults = searchKeyword(query, limit * 2);

  // 3. 合并结果（RRF 算法）
  return mergeHybridResults(vectorResults, ftsResults, limit);
}
```

## Code Agent 现状

当前实现：
- `src/main/memory/vectorStore.ts` (28KB) - 向量存储，依赖 Supabase
- `src/main/memory/embeddingService.ts` (12KB) - 仅支持 OpenAI

```typescript
// 当前：Supabase pgvector
const { data } = await supabase
  .rpc('match_documents', {
    query_embedding: embedding,
    match_threshold: 0.7,
    match_count: 10,
  });
```

## 借鉴方案

### 方案 A：sqlite-vec + better-sqlite3（推荐）

**优点**：
- 完全本地，无网络依赖
- 性能好（纯 C 实现）
- 与现有 better-sqlite3 集成

**实现**：

```typescript
// 1. 安装 sqlite-vec
npm install sqlite-vec

// 2. 创建本地向量存储
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const db = new Database('memory.db');
sqliteVec.load(db);

// 3. 保持 Supabase 作为可选的云端同步
interface VectorStoreConfig {
  mode: 'local' | 'cloud' | 'hybrid';
  localPath?: string;
  supabaseUrl?: string;
}
```

### 方案 B：LanceDB

另一个选择是 LanceDB，Clawdbot 也有扩展支持（`extensions/memory-lancedb`）。

**优点**：更强大的向量数据库功能
**缺点**：额外依赖，学习成本

**建议先用方案 A**，因为 better-sqlite3 已经是项目依赖。

## 实现步骤

### Step 1: 安装 sqlite-vec

```bash
npm install sqlite-vec
```

### Step 2: 创建本地向量存储模块

新建 `src/main/memory/localVectorStore.ts`：

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import { app } from 'electron';
import crypto from 'crypto';

const VECTOR_DIMS = 1536; // OpenAI text-embedding-3-small

export class LocalVectorStore {
  private db: Database.Database;
  private initialized = false;

  constructor(dbPath?: string) {
    const defaultPath = path.join(app.getPath('userData'), 'memory.db');
    this.db = new Database(dbPath || defaultPath);
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // 加载 sqlite-vec 扩展
    sqliteVec.load(this.db);

    // 创建向量表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        hash TEXT UNIQUE,
        created_at INTEGER DEFAULT (unixepoch()),
        metadata TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        embedding float[${VECTOR_DIMS}]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content, path, tokenize='porter'
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    `);

    this.initialized = true;
  }

  private vectorToBlob(embedding: number[]): Buffer {
    return Buffer.from(new Float32Array(embedding).buffer);
  }

  async upsertChunk(params: {
    content: string;
    embedding: number[];
    path?: string;
    startLine?: number;
    endLine?: number;
    metadata?: Record<string, unknown>;
  }): Promise<number> {
    const hash = this.hashContent(params.content);

    // 检查是否已存在
    const existing = this.db
      .prepare('SELECT id FROM chunks WHERE hash = ?')
      .get(hash) as { id: number } | undefined;

    if (existing) {
      return existing.id;
    }

    // 插入内容
    const result = this.db
      .prepare(`
        INSERT INTO chunks (content, path, start_line, end_line, hash, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        params.content,
        params.path || null,
        params.startLine || null,
        params.endLine || null,
        hash,
        params.metadata ? JSON.stringify(params.metadata) : null
      );

    const rowId = result.lastInsertRowid as number;

    // 插入向量
    this.db
      .prepare('INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)')
      .run(rowId, this.vectorToBlob(params.embedding));

    // 插入 FTS
    this.db
      .prepare('INSERT INTO chunks_fts (rowid, content, path) VALUES (?, ?, ?)')
      .run(rowId, params.content, params.path || '');

    return rowId;
  }

  async searchVector(
    queryEmbedding: number[],
    limit: number = 10,
    threshold: number = 0.3
  ): Promise<SearchResult[]> {
    const results = this.db
      .prepare(`
        SELECT
          c.id, c.content, c.path, c.start_line, c.end_line,
          v.distance
        FROM chunks_vec v
        JOIN chunks c ON c.id = v.rowid
        WHERE v.embedding MATCH ?
          AND v.distance < ?
        ORDER BY v.distance
        LIMIT ?
      `)
      .all(this.vectorToBlob(queryEmbedding), threshold, limit) as RawResult[];

    return results.map((r) => ({
      id: r.id,
      content: r.content,
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      score: 1 - r.distance, // 距离转相似度
    }));
  }

  async searchKeyword(query: string, limit: number = 10): Promise<SearchResult[]> {
    const results = this.db
      .prepare(`
        SELECT
          c.id, c.content, c.path, c.start_line, c.end_line,
          bm25(chunks_fts) as score
        FROM chunks_fts f
        JOIN chunks c ON c.id = f.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `)
      .all(query, limit) as RawResult[];

    return results.map((r) => ({
      id: r.id,
      content: r.content,
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      score: Math.abs(r.score), // BM25 分数是负数
    }));
  }

  async hybridSearch(
    query: string,
    queryEmbedding: number[],
    limit: number = 10
  ): Promise<SearchResult[]> {
    // 向量搜索
    const vectorResults = await this.searchVector(queryEmbedding, limit * 2);

    // 关键词搜索
    const keywordResults = await this.searchKeyword(query, limit * 2);

    // RRF 合并
    return this.mergeResults(vectorResults, keywordResults, limit);
  }

  private mergeResults(
    vectorResults: SearchResult[],
    keywordResults: SearchResult[],
    limit: number
  ): SearchResult[] {
    const k = 60; // RRF 常数
    const scores = new Map<number, { result: SearchResult; score: number }>();

    // 向量结果
    vectorResults.forEach((r, i) => {
      const rrfScore = 1 / (k + i + 1);
      scores.set(r.id, { result: r, score: rrfScore });
    });

    // 关键词结果
    keywordResults.forEach((r, i) => {
      const rrfScore = 1 / (k + i + 1);
      const existing = scores.get(r.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(r.id, { result: r, score: rrfScore });
      }
    });

    // 排序并返回
    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ ...s.result, score: s.score }));
  }

  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  close(): void {
    this.db.close();
  }
}

interface SearchResult {
  id: number;
  content: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  score: number;
}

interface RawResult {
  id: number;
  content: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  distance?: number;
  score?: number;
}
```

### Step 3: 多 Embedding 提供商

修改 `src/main/memory/embeddingService.ts`：

```typescript
export type EmbeddingProvider = 'openai' | 'gemini' | 'zhipu' | 'local';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  fallback?: EmbeddingProvider;
  model?: string;
  apiKey?: string;
}

export class MultiEmbeddingService {
  private config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = config;
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      return await this.embedWithProvider(this.config.provider, texts);
    } catch (err) {
      if (this.config.fallback) {
        console.warn(`Embedding fallback from ${this.config.provider} to ${this.config.fallback}`);
        return await this.embedWithProvider(this.config.fallback, texts);
      }
      throw err;
    }
  }

  private async embedWithProvider(provider: EmbeddingProvider, texts: string[]): Promise<number[][]> {
    switch (provider) {
      case 'openai':
        return this.embedOpenAI(texts);
      case 'gemini':
        return this.embedGemini(texts);
      case 'zhipu':
        return this.embedZhipu(texts);
      case 'local':
        return this.embedLocal(texts);
      default:
        throw new Error(`Unknown embedding provider: ${provider}`);
    }
  }

  private async embedGemini(texts: string[]): Promise<number[][]> {
    // Gemini embedding 实现
    // 模型: text-embedding-004
    // 免费额度更高
  }

  private async embedZhipu(texts: string[]): Promise<number[][]> {
    // 智谱 embedding 实现
    // 模型: embedding-3
    // 中文效果更好
  }

  private async embedLocal(texts: string[]): Promise<number[][]> {
    // 本地模型（如 all-MiniLM-L6-v2）
    // 需要额外配置
  }
}
```

### Step 4: 统一存储接口

修改 `src/main/memory/vectorStore.ts`，支持本地 + 云端：

```typescript
export interface VectorStoreConfig {
  mode: 'local' | 'cloud' | 'hybrid';
  localPath?: string;
  supabaseUrl?: string;
  supabaseKey?: string;
}

export class UnifiedVectorStore {
  private local?: LocalVectorStore;
  private cloud?: SupabaseVectorStore;
  private mode: VectorStoreConfig['mode'];

  constructor(config: VectorStoreConfig) {
    this.mode = config.mode;

    if (config.mode === 'local' || config.mode === 'hybrid') {
      this.local = new LocalVectorStore(config.localPath);
    }

    if (config.mode === 'cloud' || config.mode === 'hybrid') {
      this.cloud = new SupabaseVectorStore(config.supabaseUrl, config.supabaseKey);
    }
  }

  async search(query: string, embedding: number[]): Promise<SearchResult[]> {
    if (this.mode === 'local') {
      return this.local!.hybridSearch(query, embedding);
    } else if (this.mode === 'cloud') {
      return this.cloud!.search(embedding);
    } else {
      // hybrid: 合并本地和云端结果
      const [localResults, cloudResults] = await Promise.all([
        this.local!.hybridSearch(query, embedding),
        this.cloud!.search(embedding),
      ]);
      return this.mergeResults(localResults, cloudResults);
    }
  }
}
```

### Step 5: 配置 UI

在设置中添加存储模式选择：

```typescript
// 存储模式选项
const STORAGE_MODES = [
  { value: 'local', label: '本地存储（离线可用）' },
  { value: 'cloud', label: '云端存储（Supabase）' },
  { value: 'hybrid', label: '混合模式（本地 + 云端同步）' },
];

// Embedding 提供商选项
const EMBEDDING_PROVIDERS = [
  { value: 'openai', label: 'OpenAI (text-embedding-3-small)' },
  { value: 'gemini', label: 'Gemini (text-embedding-004) - 免费额度高' },
  { value: 'zhipu', label: '智谱 (embedding-3) - 中文优化' },
];
```

## 验收标准

1. **本地存储**：在离线状态下能正常存储和搜索
2. **向量搜索**：相似度搜索结果准确
3. **混合搜索**：向量 + 关键词搜索效果优于单一方式
4. **多提供商**：OpenAI/Gemini/智谱 都能正常工作
5. **自动降级**：主提供商失败时自动切换
6. **性能**：10000 条记录搜索 < 100ms

## 风险与注意事项

1. **维度一致性**：不同提供商的向量维度不同，切换时需要重建索引
   - OpenAI text-embedding-3-small: 1536
   - Gemini text-embedding-004: 768
   - 智谱 embedding-3: 2048

2. **数据迁移**：从云端切换到本地需要导出/导入机制

3. **磁盘空间**：本地存储需要足够空间

## 参考资料

- [sqlite-vec GitHub](https://github.com/asg017/sqlite-vec)
- [Clawdbot memory/manager.ts](https://github.com/clawdbot/clawdbot/blob/main/src/memory/manager.ts)
- [Gemini Embedding API](https://ai.google.dev/gemini-api/docs/embeddings)
