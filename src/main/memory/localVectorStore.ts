// ============================================================================
// Local Vector Store - SQLite-vec based vector storage
// Provides high-performance local vector search with FTS support
// ============================================================================

import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('LocalVectorStore');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface LocalVectorDocument {
  id: string;
  content: string;
  embedding: Float32Array | number[];
  metadata: LocalVectorMetadata;
}

export interface LocalVectorMetadata {
  source: string; // file, conversation, knowledge
  projectPath?: string;
  filePath?: string;
  sessionId?: string;
  category?: string;
  contentHash?: string;
  chunkIndex?: number;
  totalChunks?: number;
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
}

export interface LocalSearchResult {
  id: string;
  content: string;
  metadata: LocalVectorMetadata;
  distance: number;
  score: number;
}

export interface FTSSearchResult {
  id: string;
  content: string;
  metadata: LocalVectorMetadata;
  rank: number;
}

export interface LocalVectorStoreConfig {
  dbPath: string;
  dimension: number;
  maxDocuments: number;
  enableFTS: boolean;
}

// ----------------------------------------------------------------------------
// Local Vector Store
// ----------------------------------------------------------------------------

export class LocalVectorStore {
  private db: Database.Database | null = null;
  private config: LocalVectorStoreConfig;
  private initialized = false;

  constructor(config?: Partial<LocalVectorStoreConfig>) {
    const userDataPath = app?.getPath?.('userData') || process.cwd();

    this.config = {
      dbPath: path.join(userDataPath, 'local-vectors.db'),
      dimension: 1024, // DeepSeek embedding dimension
      maxDocuments: 100000,
      enableFTS: true,
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Ensure directory exists
      const dir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Open database
      this.db = new Database(this.config.dbPath);

      // Load sqlite-vec extension
      loadSqliteVec(this.db);
      logger.info('sqlite-vec extension loaded');

      // Create tables
      this.createTables();
      this.initialized = true;

      logger.info(`LocalVectorStore initialized at ${this.config.dbPath}`);
    } catch (error) {
      logger.error('Failed to initialize LocalVectorStore:', error);
      throw error;
    }
  }

  private createTables(): void {
    if (!this.db) throw new Error('Database not initialized');

    // Main documents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        project_path TEXT,
        file_path TEXT,
        session_id TEXT,
        category TEXT,
        content_hash TEXT,
        chunk_index INTEGER,
        total_chunks INTEGER,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_path)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_file ON documents(file_path)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash)
    `);

    // Vector table using sqlite-vec
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_documents USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${this.config.dimension}]
      )
    `);

    // FTS table for full-text search
    if (this.config.enableFTS) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
          id,
          content,
          tokenize='porter unicode61'
        )
      `);
    }

    logger.debug('Tables created/verified');
  }

  // --------------------------------------------------------------------------
  // Document Operations
  // --------------------------------------------------------------------------

  /**
   * Insert or update a document with its embedding
   */
  async upsert(doc: LocalVectorDocument): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    const metadata = doc.metadata;

    // Convert embedding to Float32Array if needed
    const embedding = doc.embedding instanceof Float32Array
      ? doc.embedding
      : new Float32Array(doc.embedding);

    // Validate dimension
    if (embedding.length !== this.config.dimension) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.config.dimension}, got ${embedding.length}`
      );
    }

    const transaction = this.db.transaction(() => {
      // Upsert main document
      this.db!.prepare(`
        INSERT INTO documents (
          id, content, source, project_path, file_path, session_id,
          category, content_hash, chunk_index, total_chunks, metadata,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          source = excluded.source,
          project_path = excluded.project_path,
          file_path = excluded.file_path,
          session_id = excluded.session_id,
          category = excluded.category,
          content_hash = excluded.content_hash,
          chunk_index = excluded.chunk_index,
          total_chunks = excluded.total_chunks,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `).run(
        doc.id,
        doc.content,
        metadata.source,
        metadata.projectPath || null,
        metadata.filePath || null,
        metadata.sessionId || null,
        metadata.category || null,
        metadata.contentHash || null,
        metadata.chunkIndex ?? null,
        metadata.totalChunks ?? null,
        JSON.stringify(metadata),
        metadata.createdAt || now,
        now
      );

      // Upsert vector
      // First delete existing if any
      this.db!.prepare('DELETE FROM vec_documents WHERE id = ?').run(doc.id);

      // Insert new vector
      this.db!.prepare(`
        INSERT INTO vec_documents (id, embedding) VALUES (?, ?)
      `).run(doc.id, embedding.buffer);

      // Update FTS
      if (this.config.enableFTS) {
        this.db!.prepare('DELETE FROM documents_fts WHERE id = ?').run(doc.id);
        this.db!.prepare(`
          INSERT INTO documents_fts (id, content) VALUES (?, ?)
        `).run(doc.id, doc.content);
      }
    });

    transaction();
  }

  /**
   * Batch upsert documents
   */
  async upsertBatch(docs: LocalVectorDocument[]): Promise<void> {
    for (const doc of docs) {
      await this.upsert(doc);
    }
  }

  /**
   * Delete document by ID
   */
  delete(id: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const transaction = this.db.transaction(() => {
      this.db!.prepare('DELETE FROM documents WHERE id = ?').run(id);
      this.db!.prepare('DELETE FROM vec_documents WHERE id = ?').run(id);
      if (this.config.enableFTS) {
        this.db!.prepare('DELETE FROM documents_fts WHERE id = ?').run(id);
      }
    });

    transaction();
    return true;
  }

  /**
   * Delete documents by filter
   */
  deleteByFilter(filter: Partial<LocalVectorMetadata>): number {
    if (!this.db) throw new Error('Database not initialized');

    // Build WHERE clause
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.source) {
      conditions.push('source = ?');
      params.push(filter.source);
    }
    if (filter.projectPath) {
      conditions.push('project_path = ?');
      params.push(filter.projectPath);
    }
    if (filter.filePath) {
      conditions.push('file_path = ?');
      params.push(filter.filePath);
    }
    if (filter.sessionId) {
      conditions.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.contentHash) {
      conditions.push('content_hash = ?');
      params.push(filter.contentHash);
    }

    if (conditions.length === 0) return 0;

    const whereClause = conditions.join(' AND ');

    // Get IDs to delete
    const ids = this.db
      .prepare(`SELECT id FROM documents WHERE ${whereClause}`)
      .all(...params) as Array<{ id: string }>;

    if (ids.length === 0) return 0;

    const idList = ids.map((r) => r.id);

    const transaction = this.db.transaction(() => {
      for (const id of idList) {
        this.db!.prepare('DELETE FROM documents WHERE id = ?').run(id);
        this.db!.prepare('DELETE FROM vec_documents WHERE id = ?').run(id);
        if (this.config.enableFTS) {
          this.db!.prepare('DELETE FROM documents_fts WHERE id = ?').run(id);
        }
      }
    });

    transaction();
    return idList.length;
  }

  /**
   * Get document by ID
   */
  get(id: string): LocalVectorDocument | null {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db.prepare(`
      SELECT d.*, v.embedding
      FROM documents d
      LEFT JOIN vec_documents v ON d.id = v.id
      WHERE d.id = ?
    `).get(id) as {
      id: string;
      content: string;
      metadata: string;
      embedding: ArrayBuffer | null;
    } | undefined;

    if (!row) return null;

    const metadata = JSON.parse(row.metadata) as LocalVectorMetadata;
    const embedding = row.embedding
      ? new Float32Array(row.embedding)
      : new Float32Array(this.config.dimension);

    return {
      id: row.id,
      content: row.content,
      metadata,
      embedding,
    };
  }

  // --------------------------------------------------------------------------
  // Vector Search
  // --------------------------------------------------------------------------

  /**
   * Search by vector similarity
   */
  search(
    queryEmbedding: Float32Array | number[],
    options: {
      topK?: number;
      threshold?: number;
      filter?: Partial<LocalVectorMetadata>;
    } = {}
  ): LocalSearchResult[] {
    if (!this.db) throw new Error('Database not initialized');

    const { topK = 10, threshold = 0.0, filter } = options;

    // Convert to Float32Array
    const embedding = queryEmbedding instanceof Float32Array
      ? queryEmbedding
      : new Float32Array(queryEmbedding);

    // Build filter conditions
    let filterClause = '';
    const filterParams: unknown[] = [];

    if (filter) {
      const conditions: string[] = [];
      if (filter.source) {
        conditions.push('d.source = ?');
        filterParams.push(filter.source);
      }
      if (filter.projectPath) {
        conditions.push('d.project_path = ?');
        filterParams.push(filter.projectPath);
      }
      if (filter.filePath) {
        conditions.push('d.file_path = ?');
        filterParams.push(filter.filePath);
      }
      if (filter.sessionId) {
        conditions.push('d.session_id = ?');
        filterParams.push(filter.sessionId);
      }

      if (conditions.length > 0) {
        filterClause = 'WHERE ' + conditions.join(' AND ');
      }
    }

    // Vector search query
    const query = `
      SELECT
        d.id,
        d.content,
        d.metadata,
        vec_distance_cosine(v.embedding, ?) as distance
      FROM vec_documents v
      JOIN documents d ON v.id = d.id
      ${filterClause}
      ORDER BY distance ASC
      LIMIT ?
    `;

    const rows = this.db
      .prepare(query)
      .all(embedding.buffer, ...filterParams, topK) as Array<{
        id: string;
        content: string;
        metadata: string;
        distance: number;
      }>;

    return rows
      .map((row) => {
        const score = 1 - row.distance; // Convert distance to similarity
        if (score < threshold) return null;

        return {
          id: row.id,
          content: row.content,
          metadata: JSON.parse(row.metadata) as LocalVectorMetadata,
          distance: row.distance,
          score,
        };
      })
      .filter((r): r is LocalSearchResult => r !== null);
  }

  // --------------------------------------------------------------------------
  // Full-Text Search
  // --------------------------------------------------------------------------

  /**
   * Full-text search using FTS5
   */
  searchFTS(
    query: string,
    options: {
      topK?: number;
      filter?: Partial<LocalVectorMetadata>;
    } = {}
  ): FTSSearchResult[] {
    if (!this.db) throw new Error('Database not initialized');
    if (!this.config.enableFTS) {
      logger.warn('FTS is not enabled');
      return [];
    }

    const { topK = 10, filter } = options;

    // Sanitize query for FTS
    const sanitizedQuery = this.sanitizeFTSQuery(query);

    // Build filter conditions
    let filterClause = '';
    const filterParams: unknown[] = [];

    if (filter) {
      const conditions: string[] = [];
      if (filter.source) {
        conditions.push('d.source = ?');
        filterParams.push(filter.source);
      }
      if (filter.projectPath) {
        conditions.push('d.project_path = ?');
        filterParams.push(filter.projectPath);
      }
      if (filter.filePath) {
        conditions.push('d.file_path = ?');
        filterParams.push(filter.filePath);
      }
      if (filter.sessionId) {
        conditions.push('d.session_id = ?');
        filterParams.push(filter.sessionId);
      }

      if (conditions.length > 0) {
        filterClause = 'AND ' + conditions.join(' AND ');
      }
    }

    const sqlQuery = `
      SELECT
        d.id,
        d.content,
        d.metadata,
        fts.rank as rank
      FROM documents_fts fts
      JOIN documents d ON fts.id = d.id
      WHERE documents_fts MATCH ?
      ${filterClause}
      ORDER BY rank
      LIMIT ?
    `;

    const rows = this.db
      .prepare(sqlQuery)
      .all(sanitizedQuery, ...filterParams, topK) as Array<{
        id: string;
        content: string;
        metadata: string;
        rank: number;
      }>;

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      metadata: JSON.parse(row.metadata) as LocalVectorMetadata,
      rank: row.rank,
    }));
  }

  private sanitizeFTSQuery(query: string): string {
    // Remove special FTS characters and split into terms
    const terms = query
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0);

    // Join with OR for more flexible matching
    return terms.join(' OR ');
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * Get document count
   */
  getCount(filter?: Partial<LocalVectorMetadata>): number {
    if (!this.db) throw new Error('Database not initialized');

    let sql = 'SELECT COUNT(*) as count FROM documents';
    const params: unknown[] = [];

    if (filter) {
      const conditions: string[] = [];
      if (filter.source) {
        conditions.push('source = ?');
        params.push(filter.source);
      }
      if (filter.projectPath) {
        conditions.push('project_path = ?');
        params.push(filter.projectPath);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
    }

    const row = this.db.prepare(sql).get(...params) as { count: number };
    return row.count;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalDocuments: number;
    bySource: Record<string, number>;
    byProject: Record<string, number>;
    dimension: number;
    ftsEnabled: boolean;
  } {
    if (!this.db) throw new Error('Database not initialized');

    const totalDocuments = this.getCount();

    const bySourceRows = this.db
      .prepare('SELECT source, COUNT(*) as count FROM documents GROUP BY source')
      .all() as Array<{ source: string; count: number }>;
    const bySource: Record<string, number> = {};
    for (const row of bySourceRows) {
      bySource[row.source] = row.count;
    }

    const byProjectRows = this.db
      .prepare(
        'SELECT project_path, COUNT(*) as count FROM documents WHERE project_path IS NOT NULL GROUP BY project_path'
      )
      .all() as Array<{ project_path: string; count: number }>;
    const byProject: Record<string, number> = {};
    for (const row of byProjectRows) {
      byProject[row.project_path] = row.count;
    }

    return {
      totalDocuments,
      bySource,
      byProject,
      dimension: this.config.dimension,
      ftsEnabled: this.config.enableFTS,
    };
  }

  /**
   * Check if document exists by content hash
   */
  existsByHash(contentHash: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db
      .prepare('SELECT 1 FROM documents WHERE content_hash = ? LIMIT 1')
      .get(contentHash);
    return !!row;
  }

  /**
   * Get document ID by content hash
   */
  getIdByHash(contentHash: string): string | null {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db
      .prepare('SELECT id FROM documents WHERE content_hash = ? LIMIT 1')
      .get(contentHash) as { id: string } | undefined;
    return row?.id || null;
  }

  /**
   * Clear all data
   */
  clear(): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.exec('DELETE FROM documents');
    this.db.exec('DELETE FROM vec_documents');
    if (this.config.enableFTS) {
      this.db.exec('DELETE FROM documents_fts');
    }
  }

  /**
   * Vacuum database
   */
  vacuum(): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.exec('VACUUM');
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let localVectorStoreInstance: LocalVectorStore | null = null;

export function getLocalVectorStore(): LocalVectorStore {
  if (!localVectorStoreInstance) {
    localVectorStoreInstance = new LocalVectorStore();
  }
  return localVectorStoreInstance;
}

export async function initLocalVectorStore(
  config?: Partial<LocalVectorStoreConfig>
): Promise<LocalVectorStore> {
  if (config) {
    localVectorStoreInstance = new LocalVectorStore(config);
  } else {
    localVectorStoreInstance = getLocalVectorStore();
  }
  await localVectorStoreInstance.initialize();
  return localVectorStoreInstance;
}
