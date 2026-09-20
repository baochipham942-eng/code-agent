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
  LibraryEvidenceProjection,
  LibraryEvidenceQuery,
  LibraryLearnStatus,
  LibraryListOptions,
  SessionContextPin,
} from '@shared/contract/library';
import { isLibraryLearnStatus } from '@shared/contract/library';
import { isPathWithinRoot } from '../../runtime/workspaceScope';
import {
  buildEvidenceFragment,
  extractLibraryText,
  hasLibraryTextExtractor,
  isTextLikeExtension,
  readLearnedSidecar,
  removeLearnedSidecar,
  writeLearnedSidecar,
  moveLearnedSidecar,
} from './libraryIngest';

const logger = createLogger('LibraryService');

/** 单个导入文件上限（与 web /api/upload/temp 的 MAX_UPLOAD_SIZE 对齐） */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const PENDING_LEARN_SWEEP_LIMIT = 20;

function defaultLearnStatus(kind: LibraryItem['kind'], pathOrUri: string): LibraryLearnStatus {
  if (kind === 'capture' || kind === 'external_ref') return 'ready';
  if (kind === 'artifact' && !hasLibraryTextExtractor(pathOrUri)) return 'ready';
  return 'pending';
}

export class LibraryService {
  private sweepInFlight: Promise<number> | null = null;
  private readonly learningIds = new Set<string>();
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
      learnStatus: isLibraryLearnStatus(String(request.learnStatus ?? ''))
        ? request.learnStatus
        : defaultLearnStatus(request.kind, request.pathOrUri),
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
  async importFile(args: {
    projectId?: string | null;
    sourcePath: string;
    tags?: string[];
    sourceSessionId?: string;
  }, now: number = Date.now()): Promise<LibraryItem> {
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

    const item = this.addItem({
      projectId,
      title: safeName,
      kind: 'upload',
      pathOrUri: target,
      tags: args.tags,
      sourceSessionId: args.sourceSessionId,
      contentHash,
    }, now);
    return this.learnItem(item.id, now);
  }

  /** 跑单条资料的文本学习管线；失败保留真实抽取原因，绝不把失败伪装成 ready。 */
  async learnItem(id: string, now: number = Date.now()): Promise<LibraryItem> {
    const item = this.repo.getItem(id);
    if (!item) throw new Error('Library item not found');
    if (this.learningIds.has(id)) return item;
    this.learningIds.add(id);
    try {
      if (item.kind !== 'upload' && item.kind !== 'artifact') {
        if (item.learnStatus === 'ready') return item;
        if (item.learnStatus === 'pending' || item.learnStatus === 'failed') {
          this.repo.updateLearnStatus(id, 'running', { error: null, now });
        }
        this.repo.updateLearnStatus(id, 'ready', { error: null, now });
        return this.repo.getItem(id) ?? item;
      }

      this.repo.updateLearnStatus(id, 'running', { error: null, now });
      try {
        if (item.kind === 'artifact' && defaultLearnStatus(item.kind, item.pathOrUri) === 'ready') {
          this.repo.updateLearnStatus(id, 'ready', { error: null, now });
          return this.repo.getItem(id) ?? item;
        }
        if (!hasLibraryTextExtractor(item.pathOrUri)) {
          throw new Error(`不支持抽取文本的格式: ${path.extname(item.pathOrUri) || '(无后缀)'}`);
        }
        const extracted = await extractLibraryText(item.pathOrUri);
        writeLearnedSidecar(this.libraryDir(item.projectId), item.id, extracted.text);
        this.repo.updateLearnStatus(id, 'ready', { error: null, now });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.repo.updateLearnStatus(id, 'failed', { error: message, now });
        logger.warn('Library item learning failed', { id, error });
      }
      return this.repo.getItem(id) ?? item;
    } finally {
      this.learningIds.delete(id);
    }
  }

  retryLearn(id: string, now: number = Date.now()): Promise<LibraryItem> {
    const item = this.repo.getItem(id);
    if (!item) throw new Error('Library item not found');
    if (item.learnStatus !== 'failed' && item.learnStatus !== 'pending' && item.learnStatus !== 'running') {
      return Promise.resolve(item);
    }
    return this.learnItem(id, now);
  }

  /** 补跑迁移/登记后仍停在 pending 的 upload/artifact，避免旧资料永久待处理。 */
  sweepPendingLearn(now: number = Date.now(), limit: number = PENDING_LEARN_SWEEP_LIMIT): Promise<number> {
    if (this.sweepInFlight) return this.sweepInFlight;
    this.sweepInFlight = this.runPendingLearnSweep(now, limit).finally(() => {
      this.sweepInFlight = null;
    });
    return this.sweepInFlight;
  }

  private async runPendingLearnSweep(now: number, limit: number): Promise<number> {
    const ids = this.repo.listPendingLearnIds(limit, now);
    for (const id of ids) {
      await this.learnItem(id, now);
    }
    return ids.length;
  }

  projectEvidence(query: LibraryEvidenceQuery): LibraryEvidenceProjection {
    const item = this.repo.findByPathAnyProject(query.source) ?? this.findItemForSidecar(query.source);
    if (!item) return { query, hit: false, reason: '未找到对应的资料库条目' };
    if (item.learnStatus !== 'ready') {
      return {
        query,
        hit: false,
        item,
        reason: item.learnStatus === 'failed'
          ? (item.learnError ?? '资料解析失败')
          : '资料仍在处理中，尚未生成可用依据',
      };
    }
    const text = readLearnedSidecar(this.libraryDir(item.projectId), item.id)
      ?? (isTextLikeExtension(item.pathOrUri) ? this.readTextFallback(item.pathOrUri) : null);
    if (!text) return { query, hit: false, item, reason: '资料没有可展示的抽取文本' };
    const window = query.lineRange
      ? { start: Math.min(query.lineRange[0], query.lineRange[1]), end: Math.max(query.lineRange[0], query.lineRange[1]) }
      : this.parseCitationWindow(query.location);
    const fragment = buildEvidenceFragment(text, window);
    if (!fragment) return { query, hit: false, item, reason: '资料没有可展示的片段' };
    return { query, hit: true, item, fragment };
  }

  private parseCitationWindow(location?: string): { start: number; end: number } | null {
    const match = location?.match(/^lines?:(\d+)(?:-(\d+))?$/i);
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }

  private findItemForSidecar(source: string): LibraryItem | undefined {
    const match = source.match(/[\\/]\.extracted[\\/]([^/\\]+)\.md$/);
    return match ? this.repo.getItem(match[1]) : undefined;
  }

  private readTextFallback(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * 归档一段生成文本（agent 产出 / 团队聚合稿）到资料库：写入 <libraryDir>/<title>-<hash>.md
   * 并登记 artifact 条目。contentHash=sha256(text) 去重——同项目同内容重复归档幂等
   * （刻意用 contentHash 而非 path 去重，绕开 findByPath 被 guardSensitiveText 重写路径导致的口径不一致）。
   */
  archiveText(args: {
    projectId?: string | null;
    title: string;
    text: string;
    tags?: string[];
    summary?: string;
    sourceSessionId?: string;
    sourceRoleId?: string;
  }, now: number = Date.now()): LibraryItem {
    const projectId = args.projectId === 'global' ? null : (args.projectId ?? null);
    const text = args.text;
    const contentHash = crypto.createHash('sha256').update(text).digest('hex');
    // 已存在同内容条目 → addItem 内部按 contentHash 直接返回，不重复落盘
    const existing = this.repo.findByContentHash(projectId, contentHash);
    if (existing) return existing;

    const dir = this.libraryDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    const safeName = (args.title.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80)) || 'output';
    const target = path.join(dir, `${safeName}-${contentHash.slice(0, 8)}.md`);
    if (!fs.existsSync(target)) fs.writeFileSync(target, text);

    const item = this.addItem({
      projectId,
      title: args.title,
      kind: 'artifact',
      pathOrUri: target,
      tags: args.tags,
      summary: args.summary,
      sourceSessionId: args.sourceSessionId,
      sourceRoleId: args.sourceRoleId,
      contentHash,
    }, now);
    if (item.learnStatus === 'pending') {
      this.repo.updateLearnStatus(item.id, 'running', { error: null, now });
      try {
        writeLearnedSidecar(this.libraryDir(projectId), item.id, text);
        this.repo.updateLearnStatus(item.id, 'ready', { error: null, now });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.repo.updateLearnStatus(item.id, 'failed', { error: message, now });
        throw error;
      }
      return this.repo.getItem(item.id) ?? item;
    }
    return item;
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
    const previous = this.repo.getItem(id);
    const changed = this.repo.updateItem(id, patch, now);
    if (!changed) return undefined;
    const next = this.repo.getItem(id);
    if (previous && next && previous.projectId !== next.projectId) {
      moveLearnedSidecar(this.libraryDir(previous.projectId), this.libraryDir(next.projectId), id);
    }
    return next;
  }

  /** 删除条目；upload 类且文件在资料库目录内时一并删除文件 */
  delete(id: string): boolean {
    const item = this.repo.getItem(id);
    if (!item) return false;
    const removed = this.repo.deleteItem(id);
    if (removed && item.kind === 'upload') {
      const root = path.join(getUserConfigDir(), 'library');
      const resolved = path.resolve(item.pathOrUri);
      if (isPathWithinRoot(resolved, root) && resolved !== path.resolve(root)) {
        try {
          fs.unlinkSync(resolved);
        } catch (error) {
          logger.warn('Failed to remove library file', { id, error });
        }
      }
    }
    if (removed) removeLearnedSidecar(this.libraryDir(item.projectId), item.id);
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
