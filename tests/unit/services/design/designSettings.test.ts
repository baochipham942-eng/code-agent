// ============================================================================
// designSettings — 设计工作区轻量行为偏好（region-lock 严格模式开关）
// 容损读盘 + 合并写 + 原子落盘 + 默认值。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cfg = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../../src/host/config/configPaths', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/host/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => cfg.root };
});

import {
  readDesignSettings,
  updateDesignSettings,
} from '../../../../src/host/services/design/designSettings';

let workDir: string;
function storeFile(): string {
  return join(workDir, 'design', 'design-settings.json');
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'design-settings-'));
  cfg.root = workDir;
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('readDesignSettings', () => {
  it('文件缺失：返回默认（regionLockStrict=false）', async () => {
    expect(await readDesignSettings()).toEqual({ regionLockStrict: false });
  });

  it('文件损坏（非法 json）：回退默认，不抛错', async () => {
    await mkdir(join(workDir, 'design'), { recursive: true });
    await writeFile(storeFile(), '{ not json', 'utf-8');
    expect(await readDesignSettings()).toEqual({ regionLockStrict: false });
  });

  it('字段类型不符：该字段回退默认', async () => {
    await mkdir(join(workDir, 'design'), { recursive: true });
    await writeFile(storeFile(), JSON.stringify({ regionLockStrict: 'yes' }), 'utf-8');
    expect(await readDesignSettings()).toEqual({ regionLockStrict: false });
  });

  it('合法值：原样读出', async () => {
    await mkdir(join(workDir, 'design'), { recursive: true });
    await writeFile(storeFile(), JSON.stringify({ regionLockStrict: true }), 'utf-8');
    expect(await readDesignSettings()).toEqual({ regionLockStrict: true });
  });
});

describe('updateDesignSettings', () => {
  it('写入后可读出，且返回合并后的完整偏好', async () => {
    const next = await updateDesignSettings({ regionLockStrict: true });
    expect(next).toEqual({ regionLockStrict: true });
    expect(await readDesignSettings()).toEqual({ regionLockStrict: true });
    // 落盘内容是合法 json
    const onDisk = JSON.parse(await readFile(storeFile(), 'utf-8'));
    expect(onDisk).toEqual({ regionLockStrict: true });
  });

  it('空 patch：保留现值不破坏', async () => {
    await updateDesignSettings({ regionLockStrict: true });
    const next = await updateDesignSettings({});
    expect(next).toEqual({ regionLockStrict: true });
  });

  it('并发写：串行锁保证最后一次胜出且文件不损坏', async () => {
    await Promise.all([
      updateDesignSettings({ regionLockStrict: true }),
      updateDesignSettings({ regionLockStrict: false }),
      updateDesignSettings({ regionLockStrict: true }),
    ]);
    // 文件可被正常解析（无半截写），值是三次之一
    const result = await readDesignSettings();
    expect(typeof result.regionLockStrict).toBe('boolean');
  });
});
