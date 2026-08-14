// ============================================================================
// CapabilityCandidateStore — 候选能力账本（N-CAP1 / F1 落盘面）
// ============================================================================
// 落 `<用户配置目录>/capability-candidates.json`，与 skill-drafts/ 平级。
// 只做「读一次进内存 + 增量 upsert + 防抖写回」：候选条目是有界的（按机械分裁剪），
// 不值得为它开一张表加一次迁移。
//
// 「忽略 / 不再提示」两条账沿用 skillDraftQueue 的 rejected 账本形状（{key, at}），
// 区别是：忽略有冷却期会回来，不再提示是终态。

import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import { CAPABILITY_CANDIDATES } from '../../../shared/constants';
import type { CapabilityCandidateRecord } from '../../../shared/contract/capabilityCandidate';
import { createLogger } from '../infra/logger';

const logger = createLogger('CapabilityCandidateStore');

interface LedgerFile {
  version: 1;
  candidates: CapabilityCandidateRecord[];
}

export function getCandidateLedgerPath(): string {
  return path.join(getUserConfigDir(), CAPABILITY_CANDIDATES.LEDGER_FILENAME);
}

function isRecord(value: unknown): value is CapabilityCandidateRecord {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CapabilityCandidateRecord>;
  return typeof entry.clusterKey === 'string'
    && entry.clusterKey.trim().length > 0
    && Number.isFinite(entry.decayedCount)
    && Number.isFinite(entry.lastSeenAt);
}

class CapabilityCandidateStore {
  private candidates = new Map<string, CapabilityCandidateRecord>();
  private loaded = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(getCandidateLedgerPath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<LedgerFile>;
      for (const entry of parsed?.candidates ?? []) {
        if (isRecord(entry)) this.candidates.set(entry.clusterKey, entry);
      }
      logger.info('候选能力账本已载入', { count: this.candidates.size });
    } catch (error) {
      // 首次运行没有账本是正常的；解析失败也不该拖垮启动，但要留痕。
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        logger.warn('候选能力账本读取失败，按空账本继续', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  get(clusterKey: string): CapabilityCandidateRecord | undefined {
    return this.candidates.get(clusterKey);
  }

  list(): CapabilityCandidateRecord[] {
    return [...this.candidates.values()];
  }

  put(record: CapabilityCandidateRecord): void {
    this.candidates.set(record.clusterKey, record);
    this.scheduleWrite();
  }

  /** 裁剪：账本只留分数最高的 N 条，防止长期运行无限膨胀 */
  prune(scoreOf: (record: CapabilityCandidateRecord) => number): void {
    if (this.candidates.size <= CAPABILITY_CANDIDATES.MAX_LEDGER_ENTRIES) return;
    const kept = this.list()
      // 「不再提示」是用户明确表态，永远不裁掉，否则它会重新冒出来
      .sort((a, b) => {
        if (a.state === 'dismissed' && b.state !== 'dismissed') return -1;
        if (b.state === 'dismissed' && a.state !== 'dismissed') return 1;
        return scoreOf(b) - scoreOf(a);
      })
      .slice(0, CAPABILITY_CANDIDATES.MAX_LEDGER_ENTRIES);
    this.candidates = new Map(kept.map((entry) => [entry.clusterKey, entry]));
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writing = this.writing.then(() => this.flush());
    }, CAPABILITY_CANDIDATES.WRITE_DEBOUNCE_MS);
    this.writeTimer.unref?.();
  }

  /** 立即写盘（测试与关停用） */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const payload: LedgerFile = { version: 1, candidates: this.list() };
    const target = getCandidateLedgerPath();
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error) {
      logger.warn('候选能力账本写入失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 仅测试用：清空内存态并允许重新 load */
  resetForTests(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.candidates.clear();
    this.loaded = false;
  }
}

let instance: CapabilityCandidateStore | null = null;

export function getCapabilityCandidateStore(): CapabilityCandidateStore {
  if (!instance) instance = new CapabilityCandidateStore();
  return instance;
}

export type { CapabilityCandidateStore };
