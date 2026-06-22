import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  deleteBrand,
  getActiveBrand,
  getActiveBrandSync,
  getBrand,
  listBrands,
  saveBrand,
  setActiveBrand,
} from '../../../../src/main/services/design/brandRegistry';
import { directionTokens } from '../../../../src/design/direction-tokens';

// getUserConfigDir() = process.env.CODE_AGENT_HOME / '.code-agent'，每次调用读 env，
// 故把 CODE_AGENT_HOME 指向临时目录即可隔离 registry（不污染真实 ~/.code-agent）。
let tmpHome: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.CODE_AGENT_HOME;
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'brand-registry-'));
  process.env.CODE_AGENT_HOME = tmpHome;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CODE_AGENT_HOME;
  else process.env.CODE_AGENT_HOME = prevHome;
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

const draft = (over?: Record<string, unknown>) => ({
  name: 'Porsche 数字化',
  tokens: directionTokens.premium,
  keep: ['克制留白'],
  change: [],
  doNotCopy: ['不要渐变按钮'],
  source: 'manual' as const,
  ...over,
});

describe('brandRegistry', () => {
  it('starts empty', async () => {
    const index = await listBrands();
    expect(index.brands).toEqual([]);
    expect(index.activeId).toBeUndefined();
  });

  it('serializes concurrent saves without orphaning (MED-2 mutex)', async () => {
    // 并发 saveBrand：无锁时各自读到同一空 index、各写 brand.json、最后 index 只剩末写者那一个
    // （前几个成孤儿，listBrands 看不到、删不掉）。有 mutex 串行化后 index 应含全部。
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
    const saved = await Promise.all(names.map((name) => saveBrand(draft({ name }))));
    const index = await listBrands();
    expect(index.brands).toHaveLength(names.length);
    for (const { id } of saved) {
      expect(index.brands.some((b) => b.id === id)).toBe(true);
      expect(await getBrand(id)).not.toBeNull();
    }
  });

  it('save → list → getBrand round-trip', async () => {
    const { id } = await saveBrand(draft());
    expect(id).toMatch(/^porsche-/);

    const index = await listBrands();
    expect(index.brands).toHaveLength(1);
    expect(index.brands[0]).toMatchObject({ id, name: 'Porsche 数字化' });
    expect(typeof index.brands[0].updatedAt).toBe('number');

    const brand = await getBrand(id);
    expect(brand?.name).toBe('Porsche 数字化');
    expect(brand?.tokens).toEqual(directionTokens.premium);
    expect(brand?.doNotCopy).toEqual(['不要渐变按钮']);
    expect(brand?.createdAt).toBeGreaterThan(0);
  });

  it('setActive → getActiveBrand / getActiveBrandSync return that brand', async () => {
    const { id } = await saveBrand(draft());
    await setActiveBrand(id);

    expect((await listBrands()).activeId).toBe(id);
    const active = await getActiveBrand();
    expect(active?.id).toBe(id);
    const activeSync = getActiveBrandSync();
    expect(activeSync?.id).toBe(id);
    expect(activeSync?.tokens).toEqual(directionTokens.premium);
  });

  it('getActiveBrand returns null when none active', async () => {
    await saveBrand(draft());
    expect(await getActiveBrand()).toBeNull();
    expect(getActiveBrandSync()).toBeNull();
  });

  it('editing an existing id preserves createdAt and overwrites', async () => {
    const { id } = await saveBrand(draft());
    const first = await getBrand(id);
    await new Promise((r) => setTimeout(r, 5));
    await saveBrand(draft({ id, name: 'Porsche 数字化', doNotCopy: ['改了'] }));
    const second = await getBrand(id);
    expect((await listBrands()).brands).toHaveLength(1);
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.doNotCopy).toEqual(['改了']);
    expect(second?.updatedAt).toBeGreaterThanOrEqual(first?.updatedAt ?? 0);
  });

  it('setActive then deleteBrand clears active and removes entry', async () => {
    const { id } = await saveBrand(draft());
    await setActiveBrand(id);
    expect((await listBrands()).activeId).toBe(id);

    await deleteBrand(id);
    const index = await listBrands();
    expect(index.brands).toEqual([]);
    expect(index.activeId).toBeUndefined();
    expect(await getBrand(id)).toBeNull();
    expect(getActiveBrandSync()).toBeNull();
  });

  it('deleting a non-active brand keeps the active pointer intact', async () => {
    const a = await saveBrand(draft({ name: 'A' }));
    const b = await saveBrand(draft({ name: 'B' }));
    await setActiveBrand(a.id);
    await deleteBrand(b.id);
    const index = await listBrands();
    expect(index.activeId).toBe(a.id);
    expect(index.brands.map((x) => x.id)).toEqual([a.id]);
  });

  it('setActiveBrand(null) clears the active pointer', async () => {
    const { id } = await saveBrand(draft());
    await setActiveBrand(id);
    await setActiveBrand(null);
    expect((await listBrands()).activeId).toBeUndefined();
  });

  it('setActiveBrand with unknown id does not set active', async () => {
    await saveBrand(draft());
    await setActiveBrand('does-not-exist');
    expect((await listBrands()).activeId).toBeUndefined();
  });

  it('saveBrand rejects empty name and invalid tokens', async () => {
    await expect(saveBrand(draft({ name: '   ' }))).rejects.toThrow();
    await expect(
      saveBrand(draft({ tokens: { palette: {}, fonts: {}, posture: '' } as never })),
    ).rejects.toThrow();
  });

  // ── 路径穿越加固（adversarial audit HIGH FIX 1+2）─────────────────────────────
  // saveBrand/deleteBrand/getBrand 接受 caller 给的 id，path.join(brandsRoot(), id)
  // 在 id='../../...' 时逃出 brands 目录 → 任意写 / 任意递归删。修复后必须被拒/无操作，
  // 且不在 brands 目录外写入或删除任何 sentinel。
  it('saveBrand 显式传穿越 id：拒绝且不在 brands 外写文件', async () => {
    // sentinel：brands 父目录（design/）下一个不该被 saveBrand 创建的目标。
    const sentinelDir = path.join(tmpHome, '.code-agent', 'design');
    await fsp.mkdir(sentinelDir, { recursive: true });
    const traversalId = '../../../../evil';
    await expect(saveBrand(draft({ id: traversalId }))).rejects.toThrow();
    // 不该在 brands 目录外创建 evil/ 目录或文件
    const escaped = path.join(tmpHome, 'evil');
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(path.join(sentinelDir, '..', '..', '..', '..', 'evil'))).toBe(false);
    // index 也不该记录这条
    expect((await listBrands()).brands).toEqual([]);
  });

  it('saveBrand 显式传含点/斜杠的脏 id：拒绝', async () => {
    await expect(saveBrand(draft({ id: 'a/b' }))).rejects.toThrow();
    await expect(saveBrand(draft({ id: 'a.b' }))).rejects.toThrow();
    await expect(saveBrand(draft({ id: 'UPPER' }))).rejects.toThrow();
  });

  it('deleteBrand 传穿越 id：no-op，不删 brands 外任何东西', async () => {
    const { id } = await saveBrand(draft());
    // 在 brands 父目录放一个 sentinel 文件，模拟「被穿越删除」的目标
    const root = path.join(tmpHome, '.code-agent', 'design', 'brands');
    const sentinel = path.join(root, '..', 'sentinel.txt');
    await fsp.writeFile(sentinel, 'keep me', 'utf-8');

    await deleteBrand('../sentinel');
    await deleteBrand('../../../../tmp/evil');
    // sentinel 仍在；合法品牌也未被波及
    expect(existsSync(sentinel)).toBe(true);
    expect(await getBrand(id)).not.toBeNull();
    await fsp.rm(sentinel, { force: true });
  });

  it('deleteBrand 一个不在 index 的 id：no-op，不动磁盘', async () => {
    const { id } = await saveBrand(draft());
    // 偷偷在 brands 下建一个不在 index 的目录，确认不被 deleteBrand 删
    const root = path.join(tmpHome, '.code-agent', 'design', 'brands');
    const orphanDir = path.join(root, 'orphan');
    await fsp.mkdir(orphanDir, { recursive: true });
    await fsp.writeFile(path.join(orphanDir, 'brand.json'), '{}', 'utf-8');

    await deleteBrand('orphan');
    expect(existsSync(orphanDir)).toBe(true);
    // 合法品牌仍在
    expect(await getBrand(id)).not.toBeNull();
  });

  it('getBrand 传穿越 id：返回 null（不读 brands 外文件）', async () => {
    await expect(getBrand('../../../../etc/hosts')).resolves.toBeNull();
    expect(await getBrand('a/b')).toBeNull();
  });
});
