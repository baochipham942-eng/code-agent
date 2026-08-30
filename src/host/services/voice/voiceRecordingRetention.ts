// ============================================================================
// 通话录音三重上限（N-L7-REC）—— 保留期 / 体积 / 条数，三条互相独立
// ============================================================================
// 只有时间上限没有体积上限会失控（本机 ~/.claude/projects 攒到 4.0G 是活证），
// 所以三条缺一不可，且每条单独都能触发清理——验收要分别变异验证。
//
// 删除语义取「用户可见」这一支（工单 §4 给的是「可见 或 可撤」）：每批清理追加一条
// 台账，记清删了几个、释放多少、触发的是哪条上限；设置页把它显示出来。不做回收站——
// 录音是用户主动打开开关才产生的排障素材，为它建两段式删除是过度工程。
//
// 触发点两处，都不新建定时器：① 启动期与 logRetention/dbRetention 同一条链
// ② 每通挂断后就地跑一次（只在启动时清的话，一次会话里连打十通会一路突破上限）。
// ============================================================================

import fs from 'fs';
import path from 'path';
import {
  VOICE_RECORDING_CLEANUP_LEDGER_FILE,
  VOICE_RECORDING_CLEANUP_LEDGER_LIMIT,
  VOICE_RECORDING_MAX_BYTES,
  VOICE_RECORDING_MAX_CALLS,
  VOICE_RECORDING_RETENTION_DAYS,
} from '../../../shared/constants/voice';
import { createLogger } from '../infra/logger';
import { getVoiceRecordingRoot } from './voiceCallRecorder';

const logger = createLogger('VoiceRecordingRetention');

const DAY_MS = 24 * 60 * 60 * 1000;

/** 触发清理的上限维度。三条互相独立。 */
type VoiceRecordingCleanupRule = 'age' | 'count' | 'bytes';

export interface VoiceRecordingCleanupEntry {
  at: number;
  deleted: number;
  freedBytes: number;
  /** 每条上限各删了几个——判据 3 分别变异验证时靠它对号。 */
  byRule: Record<VoiceRecordingCleanupRule, number>;
}

interface VoiceRecordingItem {
  /** 目录名（不含路径），也是 UI 上的录音标识。 */
  name: string;
  dir: string;
  /** 目录 mtime，≈ 通话结束时间（meta.json 在 close 时写）。 */
  modifiedAt: number;
  bytes: number;
}

async function dirBytes(dir: string): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      total += (await fs.promises.stat(path.join(dir, entry.name))).size;
    } catch {
      // 文件在枚举期间被删：跳过，不让单个文件失败改变总量口径以外的行为
    }
  }
  return total;
}

/** 列出全部录音（一通一条），按时间升序（最旧在前）。 */
async function listVoiceRecordings(root?: string): Promise<VoiceRecordingItem[]> {
  const recordingRoot = getVoiceRecordingRoot(root);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(recordingRoot, { withFileTypes: true });
  } catch {
    return []; // 目录不存在 = 从没录过，不是错误
  }
  const items: VoiceRecordingItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // 台账是根目录下的文件，天然排除
    const dir = path.join(recordingRoot, entry.name);
    try {
      const stat = await fs.promises.stat(dir);
      items.push({ name: entry.name, dir, modifiedAt: stat.mtimeMs, bytes: await dirBytes(dir) });
    } catch {
      // 目录读不到就当它不存在，不阻塞其余
    }
  }
  return items.sort((a, b) => a.modifiedAt - b.modifiedAt);
}

async function readVoiceRecordingCleanupLedger(root?: string): Promise<VoiceRecordingCleanupEntry[]> {
  const file = path.join(getVoiceRecordingRoot(root), VOICE_RECORDING_CLEANUP_LEDGER_FILE);
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as VoiceRecordingCleanupEntry[]) : [];
  } catch {
    return []; // 没清理过 / 台账损坏：当空账处理，不阻塞清理本身
  }
}

async function appendCleanupLedger(root: string | undefined, entry: VoiceRecordingCleanupEntry): Promise<void> {
  const recordingRoot = getVoiceRecordingRoot(root);
  const file = path.join(recordingRoot, VOICE_RECORDING_CLEANUP_LEDGER_FILE);
  const history = await readVoiceRecordingCleanupLedger(root);
  const next = [entry, ...history].slice(0, VOICE_RECORDING_CLEANUP_LEDGER_LIMIT);
  try {
    await fs.promises.mkdir(recordingRoot, { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    // 台账写不进去 = 这次清理对用户不可见，必须留痕（判据 5 的反面）
    logger.warn('cleanup ledger write failed; this cleanup is not user-visible', {
      file, error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 设置页 / 导出勾选框读的那份状态。不含任何音频内容，只有计数与路径。 */
export interface VoiceRecordingOverview {
  /** 录音根目录绝对路径，供「打开录音文件夹」用。 */
  dir: string;
  count: number;
  totalBytes: number;
  /** 最近一次清理；从没清理过为 null。判据 5「清理对用户可见」锚的就是它。 */
  lastCleanup: VoiceRecordingCleanupEntry | null;
  limits: { retentionDays: number; maxBytes: number; maxCalls: number };
}

export async function getVoiceRecordingOverview(root?: string): Promise<VoiceRecordingOverview> {
  const items = await listVoiceRecordings(root);
  const ledger = await readVoiceRecordingCleanupLedger(root);
  return {
    dir: getVoiceRecordingRoot(root),
    count: items.length,
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    lastCleanup: ledger[0] ?? null,
    limits: {
      retentionDays: VOICE_RECORDING_RETENTION_DAYS,
      maxBytes: VOICE_RECORDING_MAX_BYTES,
      maxCalls: VOICE_RECORDING_MAX_CALLS,
    },
  };
}

export interface VoiceRecordingRetentionOptions {
  root?: string;
  now?: number;
  retentionDays?: number;
  maxBytes?: number;
  maxCalls?: number;
}

/**
 * 三重上限逐条判，超限则删最旧。返回 null = 本次什么都没删（不写台账，不制造噪音）。
 *
 * **永远保留最新一条**：它可能正是刚刚开始、还在写的那通电话（挂断后立刻拨下一通的
 * 时序确实存在）。这也让「上限压到 0」不至于把在录的通话删掉。
 */
export async function runVoiceRecordingRetention(
  options: VoiceRecordingRetentionOptions = {},
): Promise<VoiceRecordingCleanupEntry | null> {
  const now = options.now ?? Date.now();
  const maxAgeMs = (options.retentionDays ?? VOICE_RECORDING_RETENTION_DAYS) * DAY_MS;
  const maxBytes = options.maxBytes ?? VOICE_RECORDING_MAX_BYTES;
  const maxCalls = options.maxCalls ?? VOICE_RECORDING_MAX_CALLS;

  const items = await listVoiceRecordings(options.root);
  if (items.length <= 1) return null;

  const byRule: Record<VoiceRecordingCleanupRule, number> = { age: 0, count: 0, bytes: 0 };
  const doomed = new Map<string, VoiceRecordingCleanupRule>();
  // 最新一条永不参与三条判定（见函数注释）。
  const candidates = items.slice(0, -1);

  // ① 保留期：逐条独立判，与另外两条无关。
  for (const item of candidates) {
    if (now - item.modifiedAt > maxAgeMs) doomed.set(item.dir, 'age');
  }

  // ② 条数：在①之后的存量上判，从最旧开始删到不超限。
  let aliveCount = items.length - doomed.size;
  for (const item of candidates) {
    if (aliveCount <= maxCalls) break;
    if (doomed.has(item.dir)) continue;
    doomed.set(item.dir, 'count');
    aliveCount -= 1;
  }

  // ③ 体积：同样在存量上判，从最旧开始删到总量不超限。
  let aliveBytes = items.reduce((sum, item) => (doomed.has(item.dir) ? sum : sum + item.bytes), 0);
  for (const item of candidates) {
    if (aliveBytes <= maxBytes) break;
    if (doomed.has(item.dir)) continue;
    doomed.set(item.dir, 'bytes');
    aliveBytes -= item.bytes;
  }

  if (doomed.size === 0) return null;

  let freedBytes = 0;
  let deleted = 0;
  for (const item of items) {
    const rule = doomed.get(item.dir);
    if (!rule) continue;
    try {
      await fs.promises.rm(item.dir, { recursive: true, force: true });
      deleted += 1;
      freedBytes += item.bytes;
      byRule[rule] += 1;
    } catch (error) {
      logger.warn('recording delete failed', {
        dir: item.dir, error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (deleted === 0) return null;

  const entry: VoiceRecordingCleanupEntry = { at: now, deleted, freedBytes, byRule };
  await appendCleanupLedger(options.root, entry);
  logger.info('voice recording cleanup', entry);
  return entry;
}
