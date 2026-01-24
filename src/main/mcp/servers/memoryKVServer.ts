// ============================================================================
// Memory KV In-Process MCP Server
// 简单的键值存储服务器，用于 Agent 记忆持久化
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { InProcessMCPServer } from '../inProcessServer';
import { createLogger } from '../../services/infra/logger';
import type { ToolResult } from '../../../shared/types';

const logger = createLogger('MemoryKVServer');

// 存储数据结构
interface KVEntry {
  value: unknown;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

interface KVStore {
  version: number;
  entries: Record<string, KVEntry>;
}

/**
 * Memory KV In-Process MCP Server
 *
 * 提供简单的键值存储能力，数据持久化到本地文件。
 *
 * 工具:
 * - kv_set: 设置键值
 * - kv_get: 获取值
 * - kv_delete: 删除键
 * - kv_list: 列出所有键
 * - kv_clear: 清空存储
 *
 * 资源:
 * - memory://kv/stats: 存储统计信息
 */
export class MemoryKVServer extends InProcessMCPServer {
  private store: KVStore;
  private storePath: string;
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor() {
    super('memory-kv');

    // 初始化存储路径
    const userDataPath = app.getPath('userData');
    this.storePath = path.join(userDataPath, 'memory-kv.json');

    // 加载或初始化存储
    this.store = this.loadStore();
  }

  // --------------------------------------------------------------------------
  // Storage Persistence
  // --------------------------------------------------------------------------

  private loadStore(): KVStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf-8');
        const parsed = JSON.parse(data) as KVStore;
        logger.info(`Loaded KV store with ${Object.keys(parsed.entries).length} entries`);
        return parsed;
      }
    } catch (error) {
      logger.error('Failed to load KV store, starting fresh', error);
    }

    return {
      version: 1,
      entries: {},
    };
  }

  private saveStore(): void {
    // Debounce saves to avoid excessive disk writes
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(() => {
      try {
        const dir = path.dirname(this.storePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
        logger.debug('KV store saved');
      } catch (error) {
        logger.error('Failed to save KV store', error);
      }
    }, 100);
  }

  private cleanExpiredEntries(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of Object.entries(this.store.entries)) {
      if (entry.expiresAt && entry.expiresAt < now) {
        delete this.store.entries[key];
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Cleaned ${cleaned} expired entries`);
      this.saveStore();
    }
  }

  // --------------------------------------------------------------------------
  // Tool Registration
  // --------------------------------------------------------------------------

  protected async registerTools(): Promise<void> {
    // kv_set - 设置键值
    this.addTool({
      definition: {
        name: 'kv_set',
        description: `Set a key-value pair in the memory store.

Parameters:
- key (required): The key to set
- value (required): The value to store (can be any JSON-serializable value)
- ttl (optional): Time to live in seconds (0 = no expiration)
- metadata (optional): Additional metadata to store with the value`,
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'The key to set',
            },
            value: {
              type: 'string',
              description: 'The value to store (JSON string for complex values)',
            },
            ttl: {
              type: 'number',
              description: 'Time to live in seconds (0 = no expiration)',
            },
            metadata: {
              type: 'object',
              description: 'Additional metadata',
            },
          },
          required: ['key', 'value'],
        },
        generations: ['gen5', 'gen6', 'gen7', 'gen8'],
        requiresPermission: false,
        permissionLevel: 'read',
      },
      handler: async (args, toolCallId): Promise<ToolResult> => {
        const { key, value, ttl, metadata } = args as {
          key: string;
          value: unknown;
          ttl?: number;
          metadata?: Record<string, unknown>;
        };

        if (!key || typeof key !== 'string') {
          return { toolCallId, success: false, error: 'Key is required and must be a string' };
        }

        const now = Date.now();
        const isUpdate = key in this.store.entries;

        this.store.entries[key] = {
          value,
          createdAt: isUpdate ? this.store.entries[key].createdAt : now,
          updatedAt: now,
          expiresAt: ttl && ttl > 0 ? now + ttl * 1000 : undefined,
          metadata,
        };

        this.saveStore();

        return {
          toolCallId,
          success: true,
          output: `${isUpdate ? 'Updated' : 'Set'} key "${key}"${ttl ? ` (expires in ${ttl}s)` : ''}`,
        };
      },
    });

    // kv_get - 获取值
    this.addTool({
      definition: {
        name: 'kv_get',
        description: `Get a value from the memory store by key.

Parameters:
- key (required): The key to retrieve
- withMetadata (optional): Include metadata in response (default: false)`,
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'The key to retrieve',
            },
            withMetadata: {
              type: 'boolean',
              description: 'Include metadata in response',
            },
          },
          required: ['key'],
        },
        generations: ['gen5', 'gen6', 'gen7', 'gen8'],
        requiresPermission: false,
        permissionLevel: 'read',
      },
      handler: async (args, toolCallId): Promise<ToolResult> => {
        const { key, withMetadata } = args as { key: string; withMetadata?: boolean };

        if (!key || typeof key !== 'string') {
          return { toolCallId, success: false, error: 'Key is required and must be a string' };
        }

        // Clean expired entries first
        this.cleanExpiredEntries();

        const entry = this.store.entries[key];
        if (!entry) {
          return { toolCallId, success: true, output: `Key "${key}" not found` };
        }

        // Check expiration
        if (entry.expiresAt && entry.expiresAt < Date.now()) {
          delete this.store.entries[key];
          this.saveStore();
          return { toolCallId, success: true, output: `Key "${key}" has expired` };
        }

        if (withMetadata) {
          return {
            toolCallId,
            success: true,
            output: JSON.stringify({
              value: entry.value,
              createdAt: new Date(entry.createdAt).toISOString(),
              updatedAt: new Date(entry.updatedAt).toISOString(),
              expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
              metadata: entry.metadata,
            }, null, 2),
          };
        }

        return {
          toolCallId,
          success: true,
          output: typeof entry.value === 'string'
            ? entry.value
            : JSON.stringify(entry.value, null, 2),
        };
      },
    });

    // kv_delete - 删除键
    this.addTool({
      definition: {
        name: 'kv_delete',
        description: `Delete a key from the memory store.

Parameters:
- key (required): The key to delete`,
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'The key to delete',
            },
          },
          required: ['key'],
        },
        generations: ['gen5', 'gen6', 'gen7', 'gen8'],
        requiresPermission: false,
        permissionLevel: 'read',
      },
      handler: async (args, toolCallId): Promise<ToolResult> => {
        const { key } = args as { key: string };

        if (!key || typeof key !== 'string') {
          return { toolCallId, success: false, error: 'Key is required and must be a string' };
        }

        if (key in this.store.entries) {
          delete this.store.entries[key];
          this.saveStore();
          return { toolCallId, success: true, output: `Deleted key "${key}"` };
        }

        return { toolCallId, success: true, output: `Key "${key}" not found` };
      },
    });

    // kv_list - 列出所有键
    this.addTool({
      definition: {
        name: 'kv_list',
        description: `List all keys in the memory store.

Parameters:
- prefix (optional): Filter keys by prefix
- limit (optional): Maximum number of keys to return (default: 100)`,
        inputSchema: {
          type: 'object',
          properties: {
            prefix: {
              type: 'string',
              description: 'Filter keys by prefix',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of keys to return',
            },
          },
        },
        generations: ['gen5', 'gen6', 'gen7', 'gen8'],
        requiresPermission: false,
        permissionLevel: 'read',
      },
      handler: async (args, toolCallId): Promise<ToolResult> => {
        const { prefix, limit = 100 } = args as { prefix?: string; limit?: number };

        // Clean expired entries first
        this.cleanExpiredEntries();

        let keys = Object.keys(this.store.entries);

        if (prefix) {
          keys = keys.filter(k => k.startsWith(prefix));
        }

        keys = keys.slice(0, limit);

        if (keys.length === 0) {
          return { toolCallId, success: true, output: 'No keys found' };
        }

        const keyList = keys.map(k => {
          const entry = this.store.entries[k];
          const expiry = entry.expiresAt
            ? ` (expires: ${new Date(entry.expiresAt).toISOString()})`
            : '';
          return `- ${k}${expiry}`;
        }).join('\n');

        return {
          toolCallId,
          success: true,
          output: `Found ${keys.length} key(s):\n${keyList}`,
        };
      },
    });

    // kv_clear - 清空存储
    this.addTool({
      definition: {
        name: 'kv_clear',
        description: `Clear all entries from the memory store.

Parameters:
- prefix (optional): Only clear keys with this prefix`,
        inputSchema: {
          type: 'object',
          properties: {
            prefix: {
              type: 'string',
              description: 'Only clear keys with this prefix',
            },
          },
        },
        generations: ['gen5', 'gen6', 'gen7', 'gen8'],
        requiresPermission: true,
        permissionLevel: 'write',
      },
      handler: async (args, toolCallId): Promise<ToolResult> => {
        const { prefix } = args as { prefix?: string };

        if (prefix) {
          const keys = Object.keys(this.store.entries).filter(k => k.startsWith(prefix));
          for (const key of keys) {
            delete this.store.entries[key];
          }
          this.saveStore();
          return { toolCallId, success: true, output: `Cleared ${keys.length} key(s) with prefix "${prefix}"` };
        }

        const count = Object.keys(this.store.entries).length;
        this.store.entries = {};
        this.saveStore();
        return { toolCallId, success: true, output: `Cleared all ${count} entries` };
      },
    });
  }

  // --------------------------------------------------------------------------
  // Resource Registration
  // --------------------------------------------------------------------------

  protected async registerResources(): Promise<void> {
    // memory://kv/stats - 存储统计信息
    this.addResource({
      uri: 'memory://kv/stats',
      name: 'KV Store Statistics',
      description: 'Statistics about the key-value store',
      mimeType: 'application/json',
      handler: async () => {
        this.cleanExpiredEntries();

        const entries = Object.entries(this.store.entries);
        const totalSize = JSON.stringify(this.store).length;

        return JSON.stringify({
          totalKeys: entries.length,
          totalSizeBytes: totalSize,
          version: this.store.version,
          storagePath: this.storePath,
          keys: entries.map(([key, entry]) => ({
            key,
            type: typeof entry.value,
            createdAt: new Date(entry.createdAt).toISOString(),
            updatedAt: new Date(entry.updatedAt).toISOString(),
            expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
            hasMetadata: !!entry.metadata,
          })),
        }, null, 2);
      },
    });
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async stop(): Promise<void> {
    // Flush pending saves
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      try {
        fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
        logger.info('KV store flushed on stop');
      } catch (error) {
        logger.error('Failed to flush KV store on stop', error);
      }
    }
    await super.stop();
  }
}

// Factory function
export function createMemoryKVServer(): MemoryKVServer {
  return new MemoryKVServer();
}
