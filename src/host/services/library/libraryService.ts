// ============================================================================
// LibraryService - 项目资料库（上传/归档/列表/会话 pin）
// ============================================================================

import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../infra/logger';
import { getDatabase } from '../core/databaseService';
import { LibraryRepository } from '../core/repositories/LibraryRepository';
import { getUserConfigDir } from '../../config/configPaths';
import type {
  LibraryItem,
  LibraryItemCreateRequest,
  LibraryListOptions,
  SessionContextPin,
} from '@shared/contract/library';

const logger = createLogger('LibraryService');

/** 单个导入文件上限（与 web /api/upload/temp 的 MAX_UPLOAD_SIZE 对齐） */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class LibraryService {
  // ponytail: repo 按需自建（statement 本就逐调用 prepare），不给 databaseService god-file 加行
  private get repo(): LibraryRepository {
    const raw = getDatabase().getDb();
    if (!raw) throw new Error('Database not initialized');
    return new LibraryRepository(raw);
  }

  /** 资料库落盘根目录：<数据目录>/library/<projectId|global>/ */
  libraryDir(projectId: string | null): string {
    return path.join(getUserConfigDir(), 'library', projectId ?? 'global');
  }

  /**
   * 登记一个条目（artifact/capture/external_ref 归档：只记路径，不搬文件）。
   * 同项目下 contentHash 相同的条目直接返回已有条目（去重）。
   */
  addItem(request: LibraryItemCreateRequest, now: number = Date.now()): LibraryItem {
    const projectId = request.projectId ?? null;
    if (request.contentHash) {
      const existing = this.repo.findByContentHash(projectId, request.contentHash);
      if (existing) {
        logger.info('Library item deduped by contentHash', { id: existing.id, title: existing.title });
        return existing;
      }
    }
    // 无内容哈希的登记（如产物归档）按同项目同路径去重，重复归档幂等
    if (!request.contentHash) {
      const existing = this.repo.findByPath(projectId, request.pathOrUri);
      if (existing) {
        logger.info('Library item deduped by path', { id: existing.id, title: existing.title });
        return existing;
      }
    }

    const item: LibraryItem = {
      id: `lib_${now}_${crypto.randomUUID().split('-')[0]}`,
      projectId,
      title: request.title,
      kind: request.kind,
      pathOrUri: request.pathOrUri,
      tags: request.tags ?? [],
      summary: request.summary,
      sourceSessionId: request.sourceSessionId,
      sourceRoleId: request.sourceRoleId,
      contentHash: request.contentHash,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.createItem(item);
    logger.info('Library item added', { id: item.id, kind: item.kind, projectId });
    return item;
  }

  /**
   * 导入本地文件（桌面原生选择器或 web /api/upload/temp 落地的临时路径）：
   * 拷入资料库目录并登记条目。内容 sha256 去重：同项目相同内容不重复落盘。
   */
  importFile(args: {
    projectId?: string | null;
    sourcePath: string;
    tags?: string[];
    sourceSessionId?: string;
  }, now: number = Date.now()): LibraryItem {
    const projectId = args.projectId ?? null;
    const data = fs.readFileSync(args.sourcePath);
    if (data.byteLength === 0) {
      throw new Error('File is empty');
    }
    if (data.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(`Upload exceeds ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`);
    }

    const contentHash = crypto.createHash('sha256').update(data).digest('hex');
    const existing = this.repo.findByContentHash(projectId, contentHash);
    if (existing) {
      logger.info('Upload deduped by contentHash', { id: existing.id, title: existing.title });
      return existing;
    }

    // 文件名只取 basename，防路径穿越；重名加短哈希后缀
    const safeName = path.basename(args.sourcePath).replace(/[\\/:*?"<>|]/g, '_') || 'untitled';
    const dir = this.libraryDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    let target = path.join(dir, safeName);
    if (fs.existsSync(target)) {
      const ext = path.extname(safeName);
      target = path.join(dir, `${path.basename(safeName, ext)}-${contentHash.slice(0, 8)}${ext}`);
    }
    fs.writeFileSync(target, data);

    return this.addItem({
      projectId,
      title: safeName,
      kind: 'upload',
      pathOrUri: target,
      tags: args.tags,
      sourceSessionId: args.sourceSessionId,
      contentHash,
    }, now);
  }

  list(options?: LibraryListOptions): LibraryItem[] {
    return this.repo.listItems(options);
  }

  get(id: string): LibraryItem | undefined {
    return this.repo.getItem(id);
  }

  update(
    id: string,
    patch: { title?: string; tags?: string[]; summary?: string | null; projectId?: string | null },
    now: number = Date.now(),
  ): LibraryItem | undefined {
    const changed = this.repo.updateItem(id, patch, now);
    return changed ? this.repo.getItem(id) : undefined;
  }

  /** 删除条目；upload 类且文件在资料库目录内时一并删除文件 */
  delete(id: string): boolean {
    const item = this.repo.getItem(id);
    if (!item) return false;
    const removed = this.repo.deleteItem(id);
    if (removed && item.kind === 'upload') {
      const root = path.join(getUserConfigDir(), 'library');
      const resolved = path.resolve(item.pathOrUri);
      if (resolved.startsWith(root + path.sep)) {
        try {
          fs.unlinkSync(resolved);
        } catch (error) {
          logger.warn('Failed to remove library file', { id, error });
        }
      }
    }
    return removed;
  }

  // --- 会话 pin ---

  getPin(sessionId: string): SessionContextPin {
    return this.repo.getPin(sessionId) ?? { sessionId, itemIds: [], addedAt: 0 };
  }

  setPinnedItems(sessionId: string, itemIds: string[], now: number = Date.now()): SessionContextPin {
    // 只保留真实存在的条目，去重保序
    const valid = this.repo.listItemsByIds([...new Set(itemIds)]).map((item) => item.id);
    const pin: SessionContextPin = { sessionId, itemIds: valid, addedAt: now };
    this.repo.setPin(pin);
    return pin;
  }

  /** 注入用：会话 pinned 条目的完整元数据（缺失条目自动剔除） */
  getPinnedItems(sessionId: string): LibraryItem[] {
    const pin = this.repo.getPin(sessionId);
    if (!pin || pin.itemIds.length === 0) return [];
    return this.repo.listItemsByIds(pin.itemIds);
  }
}

// 单例
let instance: LibraryService | null = null;

export function getLibraryService(): LibraryService {
  if (!instance) {
    instance = new LibraryService();
  }
  return instance;
}
