// ============================================================================
// designSettings —— 设计工作区的轻量行为偏好（设置页配置，非模型/端点 CRUD）
// ----------------------------------------------------------------------------
// IA 原则：行为偏好的「配置」归设置页（VisualModelsSettings 的一致性段），
// 设计页/画布只消费这些开关，不放增删。当前仅一项：
//   regionLockStrict —— 局部重绘一致性严格模式（best-effort 升可选硬保证）。
//
//   <getUserConfigDir>/design/design-settings.json   { regionLockStrict: boolean }
//
// 与 customVideoModelRegistry 同构：原子写（tmp+rename）+ 变更串行锁 + 读盘 sanitize 容损。
// ============================================================================

import { promises as fsp } from 'fs';
import path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import { REGION_LOCK } from '../../../shared/constants/designWorkspace';

export interface DesignSettings {
  /**
   * 局部重绘一致性严格模式。
   * false（默认）= best-effort：sharp 不可用 / 一致性闸出错时降级写模型原图，不阻断编辑。
   * true = 硬保证：region-lock 无法强制执行时响亮失败，拒绝产出未经一致性保证的图。
   */
  regionLockStrict: boolean;
}

const STORE_FILE = 'design-settings.json';

function defaults(): DesignSettings {
  return { regionLockStrict: REGION_LOCK.STRICT_DEFAULT };
}

function storePath(): string {
  return path.join(getUserConfigDir(), 'design', STORE_FILE);
}

// 读盘 sanitize：缺字段/类型不符/文件损坏一律回退默认，绝不让坏 json 阻断设计功能。
function sanitize(value: unknown): DesignSettings {
  const base = defaults();
  if (!value || typeof value !== 'object') return base;
  const v = value as Record<string, unknown>;
  return {
    regionLockStrict: typeof v.regionLockStrict === 'boolean' ? v.regionLockStrict : base.regionLockStrict,
  };
}

/** 读取设计偏好；文件缺失或损坏返回默认值。 */
export async function readDesignSettings(): Promise<DesignSettings> {
  try {
    const raw = await fsp.readFile(storePath(), 'utf-8');
    return sanitize(JSON.parse(raw));
  } catch {
    return defaults();
  }
}

// 变更串行锁（防并发读改写丢更新），对齐 customVideoModelRegistry。
let mutationChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 合并写入设计偏好（只覆盖 patch 给出的字段），返回合并后的完整偏好。
 * 串行锁内做「读现值 → 合并 → 原子落盘」，read-your-writes 一致。
 */
export async function updateDesignSettings(patch: Partial<DesignSettings>): Promise<DesignSettings> {
  return withLock(async () => {
    const current = await readDesignSettings();
    const next: DesignSettings = {
      regionLockStrict:
        typeof patch.regionLockStrict === 'boolean' ? patch.regionLockStrict : current.regionLockStrict,
    };
    const target = storePath();
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const json = JSON.stringify(next, null, 2);
    const tmp = `${target}.${Date.now().toString(36)}.tmp`;
    try {
      await fsp.writeFile(tmp, json, 'utf-8');
      await fsp.rename(tmp, target);
    } catch {
      await fsp.writeFile(target, json, 'utf-8');
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
    return next;
  });
}
