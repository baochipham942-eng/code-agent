// ============================================================================
// Skills auto sync - 启动时把 Codex/Cursor 新增的技能复制进 Neo（N-EXTHISTORY-IMPORT-SYNC-CONTENT-SKILLS）
// ============================================================================
//
// 仅 mode==='on' 才跑；单飞。只处理 handled 台账里没有的来源技能，处理过的名字
// （复制了 / Neo 已有同名而跳过）都记进台账，撤销或删除后不会被带回。
// 复制走 applyExternalSkillsImport 的 copy-no-overwrite 路径，绝不覆盖、不碰 Neo 技能。

import { createLogger } from '../services/infra/logger';
import { applyExternalSkillsImport } from './skillsImport';
import {
  readSkillsSyncState,
  readSkillsSyncStored,
  writeSkillsSyncStored,
  type SkillsSyncMode,
  type SkillsSyncState,
} from './skillsSyncPreference';

const logger = createLogger('SkillsAutoSync');

let inFlight: Promise<void> | null = null;

export interface SkillsAutoSyncOptions {
  now?: () => number;
}

async function syncRound(options: SkillsAutoSyncOptions): Promise<void> {
  const before = readSkillsSyncStored();
  if (before.mode !== 'on') return;
  const result = await applyExternalSkillsImport(undefined, { trigger: 'auto', excludeNames: before.handled });
  // 台账与模式都以「此刻」落盘值为准：同步进行中用户切到 off/paused 不能被写回拨回 on。
  const current = readSkillsSyncStored();
  const handled = { codex: [...current.handled.codex], cursor: [...current.handled.cursor] };
  for (const item of result.items) {
    // copy-failed 不算处理过：下次启动重试。
    if (item.reason === 'copy-failed') continue;
    if (!handled[item.sourceId].includes(item.name)) handled[item.sourceId].push(item.name);
  }
  writeSkillsSyncStored({
    mode: current.mode,
    handled,
    lastRun: {
      at: (options.now ?? Date.now)(),
      imported: result.copied,
      keptNeo: result.items.filter((item) => item.reason === 'target-name-exists').length,
    },
  });
}

/** mode==='on' 才跑一轮；永不抛，失败只记日志。 */
export function runSkillsAutoSync(options: SkillsAutoSyncOptions = {}): Promise<void> {
  if (!inFlight) {
    inFlight = syncRound(options)
      .catch((err) => {
        logger.warn('Skills auto sync failed', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** 启动入口（不 await 也安全，永不抛）。 */
export function startSkillsAutoSync(): Promise<void> {
  return runSkillsAutoSync();
}

export function getSkillsSyncState(): SkillsSyncState {
  return readSkillsSyncState();
}

/** 设置模式；从 off/paused 切到 on 会立即同步一轮再返回。 */
export async function setSkillsSyncMode(
  mode: SkillsSyncMode,
  options: SkillsAutoSyncOptions = {},
): Promise<SkillsSyncState> {
  const previous = readSkillsSyncStored();
  writeSkillsSyncStored({ ...previous, mode });
  if (mode === 'on' && previous.mode !== 'on') await runSkillsAutoSync(options);
  return readSkillsSyncState();
}
