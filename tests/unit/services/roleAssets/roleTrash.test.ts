// ============================================================================
// RoleTrash Tests — 用户自建角色的可撤销删除（N-ROLE-CREATE-DIRECT-DELETE）
// ② 四类不可删的稳定拒绝码 + 文件字节不动；③ 整份还原字节一致 + 冲突不覆盖；
// ④ 假时钟 retention（29 天留 / 31 天清）
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// 角色包安装记录：默认无包（null）；pack 用例单独置真值
const packState = vi.hoisted(() => ({ value: null as { locallyModified: boolean } | null }));
vi.mock('../../../../src/host/services/roleAssets/rolePackInstallService', () => ({
  getInstalledRolePackState: (_roleId: string) => packState.value,
}));

import {
  trashUserRole,
  restoreTrashedRole,
} from '../../../../src/host/services/roleAssets/roleTrash';
import { listPersistentRoles } from '../../../../src/host/services/roleAssets/roleAssetService';
import { ROLE_ASSETS } from '../../../../src/shared/constants';

const agentsDir = () => path.join(mockConfigDir.dir, 'agents');
const rolesDir = () => path.join(mockConfigDir.dir, 'roles');
// 回收站根目录与 roleTrash.getRolesTrashRootDir 同源推导（configPaths 已 mock 到
// mockConfigDir.dir）；守卫/清理逻辑只经公开 API（trashUserRole / restoreTrashedRole）
// 驱动，不 import 模块内部函数（knip production 出口棘轮：只导真有人 import 的）。
const trashDir = () => path.join(mockConfigDir.dir, ROLE_ASSETS.TRASH_DIR_NAME);

/** 建一个完整的用户自建角色：定义 + 资产目录（记忆 / 索引 / 履历 / 期望 / 资料架） */
async function seedUserRole(roleId: string, marker = 'v1'): Promise<Record<string, string>> {
  const definition = `---\nname: ${roleId}\ndescription: ${marker}\n---\n\n${roleId} 的人设 ${marker}\n`;
  const files: Record<string, string> = {
    [`agents/${roleId}.md`]: definition,
    [`roles/${roleId}/MEMORY.md`]: `# ${roleId} 角色记忆索引 ${marker}\n`,
    [`roles/${roleId}/history.md`]: `- 2026-06-03 | 报告 | 产出 ${marker}\n`,
    [`roles/${roleId}/USER.md`]: `期望原话 ${marker}\n`,
    [`roles/${roleId}/bindings.json`]: JSON.stringify([{ id: 'b1', kind: 'skill', target: 'xlsx', mode: 'on_demand', createdAt: 1 }], null, 2),
    [`roles/${roleId}/memories/a.md`]: `---\nname: a\n---\n记忆正文 ${marker}\n`,
    [`roles/${roleId}/memories/b.md`]: `---\nname: b\n---\n另一条 ${marker}\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(mockConfigDir.dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf-8');
  }
  return files;
}

/** 递归读取目录下所有文件的字节内容（快照 / round-trip 比对用） */
async function snapshotDir(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else out[path.relative(root, child)] = await fs.readFile(child, 'utf-8');
    }
  }
  await walk(root);
  return out;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

const DAY = 24 * 60 * 60 * 1000;

describe('roleTrash', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-trash-'));
    packState.value = null;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  describe('② 不可删角色：稳定拒绝码 + 文件字节不动', () => {
    it('在装内置角色（数据分析师）拒绝 ROLE_DELETE_BUILTIN', async () => {
      const files = await seedUserRole('数据分析师');
      const before = await snapshotDir(mockConfigDir.dir);

      const result = await trashUserRole('数据分析师');

      expect(result).toMatchObject({ success: false, code: 'ROLE_DELETE_BUILTIN' });
      expect(await snapshotDir(mockConfigDir.dir)).toEqual(before);
      expect(Object.keys(files).length).toBeGreaterThan(0);
    });

    it('退役内置角色（研究员）同样拒绝 ROLE_DELETE_BUILTIN', async () => {
      await seedUserRole('研究员');
      const before = await snapshotDir(mockConfigDir.dir);

      const result = await trashUserRole('研究员');

      expect(result).toMatchObject({ success: false, code: 'ROLE_DELETE_BUILTIN' });
      expect(await snapshotDir(mockConfigDir.dir)).toEqual(before);
    });

    it('装了角色包的角色拒绝 ROLE_DELETE_PACK_INSTALLED', async () => {
      packState.value = { locallyModified: true };
      await seedUserRole('包角色');
      const before = await snapshotDir(mockConfigDir.dir);

      const result = await trashUserRole('包角色');

      expect(result).toMatchObject({ success: false, code: 'ROLE_DELETE_PACK_INSTALLED' });
      expect(await snapshotDir(mockConfigDir.dir)).toEqual(before);
    });

    it('孤儿角色（无定义文件）拒绝 ROLE_DELETE_ORPHAN', async () => {
      await seedUserRole('孤儿角色');
      await fs.rm(path.join(agentsDir(), '孤儿角色.md'));
      const before = await snapshotDir(mockConfigDir.dir);

      const result = await trashUserRole('孤儿角色');

      expect(result).toMatchObject({ success: false, code: 'ROLE_DELETE_ORPHAN' });
      expect(await snapshotDir(mockConfigDir.dir)).toEqual(before);
    });

    it('角色目录不存在拒绝 ROLE_DELETE_NOT_FOUND；非法 id 拒绝 ROLE_DELETE_INVALID_ID', async () => {
      expect(await trashUserRole('不存在的角色')).toMatchObject({ success: false, code: 'ROLE_DELETE_NOT_FOUND' });
      expect(await trashUserRole('a/b')).toMatchObject({ success: false, code: 'ROLE_DELETE_INVALID_ID' });
    });
  });

  describe('① 删除：定义与资产目录都移入回收站，持久角色名册不再列它', () => {
    it('移入 roles-trash/<trashId>/（agent.md + 角色目录 + meta.json）', async () => {
      await seedUserRole('临时角色');

      const result = await trashUserRole('临时角色', new Date('2026-11-04T10:00:00Z'));

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(await exists(path.join(agentsDir(), '临时角色.md'))).toBe(false);
      expect(await exists(path.join(rolesDir(), '临时角色'))).toBe(false);
      expect(await listPersistentRoles()).not.toContain('临时角色');

      const entry = path.join(trashDir(), result.trashId);
      expect(await exists(path.join(entry, 'agent.md'))).toBe(true);
      expect(await exists(path.join(entry, '临时角色', 'memories', 'a.md'))).toBe(true);
      const meta = JSON.parse(await fs.readFile(path.join(entry, 'meta.json'), 'utf-8'));
      expect(meta).toEqual({ roleId: '临时角色', deletedAt: '2026-11-04T10:00:00.000Z' });
    });
  });

  describe('③ 还原：逐文件字节一致；roleId 被占用时拒绝且不覆盖', () => {
    it('round-trip 每个文件字节一致（memories / USER.md / history / MEMORY.md / bindings.json / 定义）', async () => {
      const files = await seedUserRole('撤销角色', '唯一标记');
      const beforeAgents = await snapshotDir(agentsDir());
      const beforeRoles = await snapshotDir(rolesDir());

      const trashed = await trashUserRole('撤销角色');
      expect(trashed.success).toBe(true);
      if (!trashed.success) return;
      expect(await snapshotDir(agentsDir())).toEqual({}); // agents/ 与 roles/ 里什么都没剩
      expect(await snapshotDir(rolesDir())).toEqual({});

      const restored = await restoreTrashedRole(trashed.trashId);
      expect(restored).toMatchObject({ success: true, roleId: '撤销角色' });
      expect(await snapshotDir(agentsDir())).toEqual(beforeAgents);
      expect(await snapshotDir(rolesDir())).toEqual(beforeRoles);
      for (const rel of Object.keys(files)) {
        expect(await exists(path.join(mockConfigDir.dir, rel)), rel).toBe(true);
      }
      // 还原完回收站条目清空
      expect(await fs.readdir(trashDir())).toEqual([]);
    });

    it('目标 roleId 已重新存在时拒绝 ROLE_RESTORE_CONFLICT，双方文件都不动', async () => {
      await seedUserRole('冲突角色', '旧版');
      const trashed = await trashUserRole('冲突角色');
      expect(trashed.success).toBe(true);
      if (!trashed.success) return;
      // 用户重建了同名角色
      await seedUserRole('冲突角色', '新版');
      const before = await snapshotDir(mockConfigDir.dir);

      const restored = await restoreTrashedRole(trashed.trashId);

      expect(restored).toMatchObject({ success: false, code: 'ROLE_RESTORE_CONFLICT' });
      expect(await snapshotDir(mockConfigDir.dir)).toEqual(before); // 新角色一个字节没被覆盖
      // 回收站条目保留（用户处理完冲突前不销毁证据）
      expect(await exists(path.join(trashDir(), trashed.trashId, 'agent.md'))).toBe(true);
      expect(await restoreTrashedRole('没有这个条目')).toMatchObject({ success: false, code: 'ROLE_TRASH_NOT_FOUND' });
    });
  });

  describe('④ retention：假时钟 29 天保留 / 31 天清除', () => {
    it('29 天仍在，31 天被惰性清掉', async () => {
      const t0 = new Date('2026-11-04T10:00:00Z').getTime();
      await seedUserRole('过期角色');
      const trashed = await trashUserRole('过期角色', new Date(t0));
      expect(trashed.success).toBe(true);
      if (!trashed.success) return;

      // 29 天：仍在保留期内（purge 经 trash/restore 惰性触发，此处用 restore 驱动）
      expect(await restoreTrashedRole(trashed.trashId, new Date(t0 + 29 * DAY))).toMatchObject({ success: true });
      // 重新删一次，验证 31 天边界：restore 先惰性 purge 过期条目，条目已不存在 → 稳定拒绝
      const trashedAgain = await trashUserRole('过期角色', new Date(t0));
      expect(trashedAgain.success).toBe(true);
      if (!trashedAgain.success) return;

      expect(await restoreTrashedRole(trashedAgain.trashId, new Date(t0 + 31 * DAY))).toMatchObject({ success: false, code: 'ROLE_TRASH_NOT_FOUND' });
      // 拒绝的原因是条目真的被清掉了（目录已不在），而不是 restore 自己按时间拒绝
      expect(await exists(path.join(trashDir(), trashedAgain.trashId))).toBe(false);
    });

    it('没有 meta.json 的残骸目录（删除中途崩掉的半成品）直接清掉', async () => {
      // 先删正常角色（这次 trash 自带的惰性 purge 无事可做），再伪造删除中途崩掉的残骸，
      // 让 restore 成为触发清理的那次调用
      await seedUserRole('带残骸角色');
      const trashed = await trashUserRole('带残骸角色');
      if (!trashed.success) return;
      await fs.mkdir(path.join(trashDir(), 'role-debris'), { recursive: true });
      await fs.writeFile(path.join(trashDir(), 'role-debris', 'agent.md'), '残骸', 'utf-8');

      expect(await restoreTrashedRole(trashed.trashId)).toMatchObject({ success: true });

      expect(await exists(path.join(trashDir(), 'role-debris'))).toBe(false);
    });
  });
});
