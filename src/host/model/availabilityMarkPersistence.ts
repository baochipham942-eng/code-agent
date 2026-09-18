// ============================================================================
// Availability Mark Persistence - 模型级可用性标记跨重启持久化
// ============================================================================
// 模型级标记（停用 / 不存在）不自愈：上游下架的模型只在标记活着的窗口里被
// pickCompanionDefaultModel 回避，重启即空 ⇒ 回落链把「从未调用过」的已停用模型当好
// 模型选中，手机预选一个死模型，下一次执行必炸。内存为真源 + 变更即落盘 + 重启回灌
// （模式参照 modelOverridePersistence）。provider 级标记**不**持久化：网络/auth/quota
// 是瞬态，维持内存 + 30 分钟 TTL。
// 单测里 getProviderHealthMonitor() 保持纯内存（vi.resetModules 拿新实例互不串盘）；
// 生产由宿主启动时 armModelMarkPersistence() 接线（webServer boot）。

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../services/infra/logger';
import { getUserConfigDir } from '../config/configPaths';
import type { AvailabilityMark } from './providerHealthMonitor';

const logger = createLogger('AvailabilityMarkPersistence');

const FILE_NAME = 'model-availability-marks.json';

/** 盘上只认模型级标记；字段形状不对的条目整条丢弃，不带病回灌。 */
function parseStored(raw: string): Array<[string, AvailabilityMark]> | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const marks = (value as { marks?: unknown }).marks;
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) return null;
  const out: Array<[string, AvailabilityMark]> = [];
  for (const [key, entry] of Object.entries(marks as Record<string, unknown>)) {
    const mark = entry as Partial<AvailabilityMark> | null;
    if (!key.includes('\0') || mark?.scope !== 'model') continue;
    if (mark.kind !== 'model' && mark.kind !== 'auth' && mark.kind !== 'network' && mark.kind !== 'quota') continue;
    if (typeof mark.at !== 'number' || !Number.isFinite(mark.at)) continue;
    out.push([key, { scope: 'model', kind: mark.kind, at: mark.at }]);
  }
  return out;
}

/** monitor 侧只依赖这个最小面：回灌一次、之后每次变更整份交回。 */
export interface ModelMarkStore {
  load(): Array<[string, AvailabilityMark]> | null;
  persist(entries: readonly (readonly [string, AvailabilityMark])[]): void;
}

export function createModelMarkFileStore(filePath: string = path.join(getUserConfigDir(), FILE_NAME)): ModelMarkStore {
  return {
    load() {
      try {
        return parseStored(fs.readFileSync(filePath, 'utf-8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('Cannot read persisted model availability marks; starting empty', { filePath, error: String(error) });
        }
        return null;
      }
    },
    persist(entries) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ version: 1, marks: Object.fromEntries(entries) }));
      } catch (error) {
        // 落盘失败只影响下次重启：本轮内存标记照常生效（fail-open 行为不变、失败留痕）。
        logger.warn('Cannot persist model availability marks; in-memory marks still govern this run', { filePath, error: String(error) });
      }
    },
  };
}
