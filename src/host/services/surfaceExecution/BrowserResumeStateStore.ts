import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getUserConfigDir } from '../../config/configPaths';
import { getSecureStorage } from '../core/secureStorage';
import type { BrowserService } from '../infra/browserService';

const RESUME_STATE_DIR = 'browser-resume-state';
const RESUME_STATE_SLOT_PREFIX = 'browser-resume:';

interface SecureKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface BrowserResumeStateStore {
  exportForConversation(conversationId: string, browserService: BrowserService): Promise<string>;
  importForConversation(conversationId: string, browserService: BrowserService): Promise<boolean>;
  clearConversation(conversationId: string): Promise<void>;
  activateConversation(conversationId: string): void;
}

export interface SecureBrowserResumeStateStoreOptions {
  rootDir?: string;
  secureStorage?: SecureKeyValueStore;
  workspaceRoot?: string;
}

function conversationHash(conversationId: string): string {
  return createHash('sha256').update(conversationId).digest('hex');
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * BrowserService 的 export/import 只接文件路径，因此敏感 state 会短暂经过磁盘。
 * 临时文件固定落用户数据目录、预创建为 0600，并在动作结束后删除；两轮之间的
 * 寄存值进入 SecureStorage 的加密文件，不留在 screenshot/artifact 或工作区目录。
 */
export class SecureBrowserResumeStateStore implements BrowserResumeStateStore {
  private readonly rootDir: string;
  private readonly secureStorage: SecureKeyValueStore;
  private readonly workspaceRoot: string;
  private readonly generations = new Map<string, number>();
  private readonly importClaims = new Set<string>();
  private readonly inactiveConversations = new Set<string>();

  constructor(options: SecureBrowserResumeStateStoreOptions = {}) {
    this.rootDir = path.resolve(options.rootDir || path.join(getUserConfigDir(), RESUME_STATE_DIR));
    this.secureStorage = options.secureStorage || getSecureStorage();
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
  }

  async exportForConversation(
    conversationId: string,
    browserService: BrowserService,
  ): Promise<string> {
    if (this.inactiveConversations.has(conversationId)) return '';
    const generation = this.generations.get(conversationId) || 0;
    const temporaryPath = await this.createTemporaryPath(conversationId, 'export');
    let primaryError: unknown;
    try {
      await browserService.exportStorageState(temporaryPath);
      await fs.promises.chmod(temporaryPath, 0o600);
      const serialized = await fs.promises.readFile(temporaryPath, 'utf8');
      JSON.parse(serialized);
      if ((this.generations.get(conversationId) || 0) === generation) {
        await this.secureStorage.setItem(this.slot(conversationId), serialized);
      }
      return temporaryPath;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await this.removeTemporaryPath(temporaryPath, primaryError);
    }
  }

  async importForConversation(
    conversationId: string,
    browserService: BrowserService,
  ): Promise<boolean> {
    const slot = this.slot(conversationId);
    if (this.importClaims.has(slot)) return false;
    this.importClaims.add(slot);
    let temporaryPath: string | undefined;
    let primaryError: unknown;
    try {
      const serialized = await this.secureStorage.getItem(slot);
      if (!serialized) return false;
      await this.secureStorage.removeItem(slot);
      JSON.parse(serialized);
      temporaryPath = await this.createTemporaryPath(conversationId, 'import');
      await fs.promises.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await browserService.importStorageState(temporaryPath);
      return true;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      this.importClaims.delete(slot);
      if (temporaryPath) await this.removeTemporaryPath(temporaryPath, primaryError);
    }
  }

  async clearConversation(conversationId: string): Promise<void> {
    this.inactiveConversations.add(conversationId);
    this.generations.set(conversationId, (this.generations.get(conversationId) || 0) + 1);
    await this.secureStorage.removeItem(this.slot(conversationId));
    const conversationDir = this.conversationDir(conversationId);
    await fs.promises.rmdir(conversationDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    });
  }

  activateConversation(conversationId: string): void {
    this.inactiveConversations.delete(conversationId);
  }

  private slot(conversationId: string): string {
    return `${RESUME_STATE_SLOT_PREFIX}${conversationHash(conversationId)}`;
  }

  private conversationDir(conversationId: string): string {
    return path.join(this.rootDir, conversationHash(conversationId));
  }

  private async createTemporaryPath(
    conversationId: string,
    direction: 'export' | 'import',
  ): Promise<string> {
    const directory = this.conversationDir(conversationId);
    const temporaryPath = path.join(directory, `${direction}-${randomUUID()}.json`);
    if (isInside(temporaryPath, this.workspaceRoot)) {
      throw new Error('Browser resume state path must be outside the workspace.');
    }
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(directory, 0o700);
    const handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.close();
    return temporaryPath;
  }

  private async removeTemporaryPath(temporaryPath: string, primaryError: unknown): Promise<void> {
    try {
      await fs.promises.unlink(temporaryPath);
      await fs.promises.rmdir(path.dirname(temporaryPath)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
      });
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Browser resume state operation and temporary-file cleanup both failed.',
          { cause: cleanupError },
        );
      }
      throw cleanupError;
    }
  }
}
