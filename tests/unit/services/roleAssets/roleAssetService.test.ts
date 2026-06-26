// ============================================================================
// Role Asset Service Tests — 角色绑定检测 / 三层记忆读写 / 履历 / 注入块
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

import {
  isSafeRoleId,
  getProjectKey,
  getRoleDir,
} from '../../../../src/host/services/roleAssets/roleAssetPaths';
import {
  isPersistentRole,
  listPersistentRoles,
  ensureRoleAssetDirs,
  ensureProjectMemoryDirs,
  writeScopedMemory,
  readScopedMemory,
  deleteScopedMemory,
  listScopedMemories,
  loadScopedMemoryIndex,
  appendRoleHistory,
  loadRoleHistory,
  buildRoleContextBlock,
  instantiateRole,
} from '../../../../src/host/services/roleAssets/roleAssetService';

describe('roleAssetPaths', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-assets-'));
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  describe('isSafeRoleId', () => {
    it('accepts Chinese role names', () => {
      expect(isSafeRoleId('研究员')).toBe(true);
      expect(isSafeRoleId('数据分析师')).toBe(true);
    });

    it('accepts ascii role names', () => {
      expect(isSafeRoleId('researcher')).toBe(true);
    });

    it('rejects path traversal', () => {
      expect(isSafeRoleId('..')).toBe(false);
      expect(isSafeRoleId('../etc')).toBe(false);
      expect(isSafeRoleId('a/b')).toBe(false);
      expect(isSafeRoleId('a\\b')).toBe(false);
      expect(isSafeRoleId('')).toBe(false);
      expect(isSafeRoleId('  ')).toBe(false);
    });
  });

  describe('getRoleDir', () => {
    it('builds role dir under roles root', () => {
      expect(getRoleDir('研究员')).toBe(path.join(mockConfigDir.dir, 'roles', '研究员'));
    });

    it('throws on unsafe role id', () => {
      expect(() => getRoleDir('../x')).toThrow('Invalid role id');
    });
  });

  describe('getProjectKey', () => {
    it('is stable for the same path', () => {
      expect(getProjectKey('/tmp/workspace-a')).toBe(getProjectKey('/tmp/workspace-a'));
    });

    it('differs for different paths', () => {
      expect(getProjectKey('/tmp/workspace-a')).not.toBe(getProjectKey('/tmp/workspace-b'));
    });

    it('normalizes relative segments', () => {
      expect(getProjectKey('/tmp/a/../a')).toBe(getProjectKey('/tmp/a'));
    });
  });
});

describe('roleAssetService', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-assets-'));
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  describe('role binding detection (设计 §4.2)', () => {
    it('returns false when roles/<id>/ does not exist', async () => {
      expect(await isPersistentRole('研究员')).toBe(false);
    });

    it('returns true after ensureRoleAssetDirs (升级为持久角色)', async () => {
      await ensureRoleAssetDirs('研究员');
      expect(await isPersistentRole('研究员')).toBe(true);
    });

    it('returns false again after role dir removed (降回瞬时 agent)', async () => {
      await ensureRoleAssetDirs('研究员');
      await fs.rm(getRoleDir('研究员'), { recursive: true, force: true });
      expect(await isPersistentRole('研究员')).toBe(false);
    });

    it('rejects unsafe role ids without throwing', async () => {
      expect(await isPersistentRole('../etc')).toBe(false);
    });

    it('lists all persistent roles', async () => {
      await ensureRoleAssetDirs('研究员');
      await ensureRoleAssetDirs('数据分析师');
      const roles = await listPersistentRoles();
      expect(roles.sort()).toEqual(['数据分析师', '研究员'].sort());
    });
  });

  describe('ensureRoleAssetDirs', () => {
    it('creates MEMORY.md / memories/ / history.md skeleton', async () => {
      await ensureRoleAssetDirs('研究员');
      const roleDir = getRoleDir('研究员');
      expect((await fs.stat(path.join(roleDir, 'memories'))).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(roleDir, 'MEMORY.md'), 'utf-8')).toContain('研究员');
      expect(await fs.readFile(path.join(roleDir, 'history.md'), 'utf-8')).toContain('工作履历');
    });

    it('is idempotent and preserves existing memory index', async () => {
      await ensureRoleAssetDirs('研究员');
      const indexPath = path.join(getRoleDir('研究员'), 'MEMORY.md');
      await fs.writeFile(indexPath, '# custom index content\n', 'utf-8');
      await ensureRoleAssetDirs('研究员');
      expect(await fs.readFile(indexPath, 'utf-8')).toBe('# custom index content\n');
    });
  });

  describe('scoped memory write/read/delete (角色层)', () => {
    beforeEach(async () => {
      await ensureRoleAssetDirs('研究员');
    });

    it('writes memory file with frontmatter and updates index', async () => {
      await writeScopedMemory(
        { scope: 'role', roleId: '研究员' },
        {
          filename: 'gmv-definition.md',
          name: 'GMV 口径',
          description: '用户的 GMV 不含退款',
          content: '用户业务中 GMV 指标的定义是不含退款的成交总额。',
        },
      );

      const memContent = await fs.readFile(
        path.join(getRoleDir('研究员'), 'memories', 'gmv-definition.md'),
        'utf-8',
      );
      expect(memContent).toContain('name: GMV 口径');
      expect(memContent).toContain('scope: role');
      expect(memContent).toContain('不含退款的成交总额');

      const index = await loadScopedMemoryIndex({ scope: 'role', roleId: '研究员' });
      expect(index).toContain('[gmv-definition.md]');
      expect(index).toContain('用户的 GMV 不含退款');
    });

    it('updates index entry instead of duplicating on overwrite', async () => {
      const target = { scope: 'role' as const, roleId: '研究员' };
      const entry = {
        filename: 'evolving.md',
        name: 'E',
        description: '第一版描述',
        content: 'v1',
      };
      await writeScopedMemory(target, entry);
      await writeScopedMemory(target, { ...entry, description: '第二版描述', content: 'v2' });

      const index = await loadScopedMemoryIndex(target);
      const entries = (index || '').split('\n').filter((l) => l.includes('[evolving.md]'));
      expect(entries.length).toBe(1);
      expect(index).toContain('第二版描述');
    });

    it('reads memory content back', async () => {
      const target = { scope: 'role' as const, roleId: '研究员' };
      await writeScopedMemory(target, {
        filename: 'a.md',
        name: 'A',
        description: 'desc',
        content: 'body text',
      });
      const content = await readScopedMemory(target, 'a.md');
      expect(content).toContain('body text');
    });

    it('returns null for missing memory', async () => {
      expect(await readScopedMemory({ scope: 'role', roleId: '研究员' }, 'nope.md')).toBeNull();
    });

    it('deletes memory and removes index entry (idempotent)', async () => {
      const target = { scope: 'role' as const, roleId: '研究员' };
      await writeScopedMemory(target, {
        filename: 'to-delete.md',
        name: 'D',
        description: 'will be deleted',
        content: 'x',
      });
      expect(await deleteScopedMemory(target, 'to-delete.md')).toBe(true);
      expect(await readScopedMemory(target, 'to-delete.md')).toBeNull();
      const index = await loadScopedMemoryIndex(target);
      expect(index || '').not.toContain('[to-delete.md]');
      // 幂等：再删一次不报错
      expect(await deleteScopedMemory(target, 'to-delete.md')).toBe(false);
    });

    it('lists memories with parsed frontmatter', async () => {
      const target = { scope: 'role' as const, roleId: '研究员' };
      await writeScopedMemory(target, {
        filename: 'one.md',
        name: 'One',
        description: 'first',
        content: 'c1',
      });
      await writeScopedMemory(target, {
        filename: 'two.md',
        name: 'Two',
        description: 'second',
        content: 'c2',
      });
      const files = await listScopedMemories(target);
      expect(files.length).toBe(2);
      const one = files.find((f) => f.filename === 'one.md');
      expect(one?.name).toBe('One');
      expect(one?.description).toBe('first');
      expect(one?.scope).toBe('role');
    });

    it('rejects filename with path separators', async () => {
      await expect(
        writeScopedMemory(
          { scope: 'role', roleId: '研究员' },
          { filename: '../evil.md', name: 'x', description: 'x', content: 'x' },
        ),
      ).rejects.toThrow('path separators');
    });

    it('rejects filename not ending with .md', async () => {
      await expect(
        writeScopedMemory(
          { scope: 'role', roleId: '研究员' },
          { filename: 'evil.txt', name: 'x', description: 'x', content: 'x' },
        ),
      ).rejects.toThrow('.md');
    });
  });

  describe('project memory isolation (设计 §3.4 workspace key)', () => {
    it('isolates memories between two workspaces', async () => {
      const wsA = '/tmp/workspace-a';
      const wsB = '/tmp/workspace-b';

      await writeScopedMemory(
        { scope: 'project', workspacePath: wsA },
        { filename: 'a-only.md', name: 'A', description: 'workspace A 的记忆', content: 'a' },
      );

      const aMemories = await listScopedMemories({ scope: 'project', workspacePath: wsA });
      const bMemories = await listScopedMemories({ scope: 'project', workspacePath: wsB });
      expect(aMemories.length).toBe(1);
      expect(bMemories.length).toBe(0);

      const bIndex = await loadScopedMemoryIndex({ scope: 'project', workspacePath: wsB });
      expect(bIndex).toBeNull();
    });

    it('writes meta.json with original workspace path', async () => {
      await ensureProjectMemoryDirs('/tmp/workspace-a');
      const projectsRoot = path.join(mockConfigDir.dir, 'projects');
      const keys = await fs.readdir(projectsRoot);
      expect(keys.length).toBe(1);
      const meta = JSON.parse(
        await fs.readFile(path.join(projectsRoot, keys[0], 'meta.json'), 'utf-8'),
      );
      expect(meta.workspacePath).toBe(path.resolve('/tmp/workspace-a'));
    });
  });

  describe('role history (设计 §4.3 履历 = 产物清单)', () => {
    it('appends history entries and loads recent ones', async () => {
      await ensureRoleAssetDirs('研究员');
      await appendRoleHistory('研究员', {
        date: '2026-06-03',
        artifactLabel: 'Q2 调研报告',
        artifactRef: 'artifact://doc/abc',
        summary: '产出 12 页调研报告',
      });
      await appendRoleHistory('研究员', {
        date: '2026-06-04',
        artifactLabel: '无产物任务',
        artifactRef: '-',
        summary: '快速问答',
      });

      const history = await loadRoleHistory('研究员');
      expect(history.length).toBe(2);
      expect(history[0]).toContain('[Q2 调研报告](artifact://doc/abc)');
      expect(history[1]).toContain('无产物任务');
      expect(history[1]).not.toContain('](-)');
    });

    it('limits loaded history entries', async () => {
      await ensureRoleAssetDirs('研究员');
      for (let i = 0; i < 15; i++) {
        await appendRoleHistory('研究员', {
          date: '2026-06-03',
          artifactLabel: `任务${i}`,
          artifactRef: '-',
          summary: `第 ${i} 次`,
        });
      }
      const history = await loadRoleHistory('研究员', 5);
      expect(history.length).toBe(5);
      expect(history[4]).toContain('任务14');
    });
  });

  describe('buildRoleContextBlock (设计 §3.3 注入)', () => {
    it('returns null for non-persistent roles (行为零变化)', async () => {
      expect(await buildRoleContextBlock('coder')).toBeNull();
    });

    it('builds block with role memory index for persistent role', async () => {
      await ensureRoleAssetDirs('研究员');
      await writeScopedMemory(
        { scope: 'role', roleId: '研究员' },
        { filename: 'glossary.md', name: '术语', description: '业务术语表', content: '...' },
      );

      const block = await buildRoleContextBlock('研究员');
      expect(block).toContain('<role_assets role="研究员">');
      expect(block).toContain('角色记忆索引');
      expect(block).toContain('[glossary.md]');
      expect(block).toContain('MemoryRead');
    });

    it('includes project memory index when workspace has memories', async () => {
      await ensureRoleAssetDirs('研究员');
      await writeScopedMemory(
        { scope: 'project', workspacePath: '/tmp/ws-x' },
        { filename: 'proj.md', name: 'P', description: '项目专属记忆', content: '...' },
      );

      const block = await buildRoleContextBlock('研究员', '/tmp/ws-x');
      expect(block).toContain('当前项目记忆索引');
      expect(block).toContain('[proj.md]');
    });

    it('excludes other roles memories (角色隔离)', async () => {
      await ensureRoleAssetDirs('研究员');
      await ensureRoleAssetDirs('数据分析师');
      await writeScopedMemory(
        { scope: 'role', roleId: '研究员' },
        { filename: 'researcher-only.md', name: 'R', description: '研究员专属', content: '...' },
      );

      const analystBlock = await buildRoleContextBlock('数据分析师');
      expect(analystBlock).not.toContain('researcher-only.md');
    });

    it('includes recent history', async () => {
      await ensureRoleAssetDirs('研究员');
      await appendRoleHistory('研究员', {
        date: '2026-06-03',
        artifactLabel: '报告A',
        artifactRef: '-',
        summary: '完成调研',
      });
      const block = await buildRoleContextBlock('研究员');
      expect(block).toContain('最近工作履历');
      expect(block).toContain('报告A');
    });
  });

  describe('instantiateRole (设计 §9 → 主动性已实现)', () => {
    it('supports user trigger and returns context block', async () => {
      await ensureRoleAssetDirs('研究员');
      const result = await instantiateRole('研究员', 'user', { task: '调研 AI 市场' });
      expect(result.roleId).toBe('研究员');
      expect(result.contextBlock).toContain('role_assets');
    });

    it('supports cadence/event triggers for persistent roles (角色主动性)', async () => {
      await ensureRoleAssetDirs('研究员');
      const cadence = await instantiateRole('研究员', 'cadence', { task: '主动巡检' });
      expect(cadence.trigger).toBe('cadence');
      expect(cadence.contextBlock).toContain('role_assets');
      const event = await instantiateRole('研究员', 'event', { task: '任务总结' });
      expect(event.trigger).toBe('event');
    });

    it('rejects cadence/event triggers for non-persistent roles', async () => {
      await expect(instantiateRole('不存在的角色', 'cadence', { task: 'x' })).rejects.toThrow('not a persistent role');
    });
  });
});
