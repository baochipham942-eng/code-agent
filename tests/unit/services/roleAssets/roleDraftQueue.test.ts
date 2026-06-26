// ============================================================================
// RoleDraftQueue Tests — 对话式建角色草稿队列（入队去重 / 确认落盘 / 安全闸 / 放弃）
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
  generateRoleAgentMd,
  enqueueRoleDraft,
  listRoleDrafts,
  confirmRoleDraft,
  rejectRoleDraft,
  getRoleDraftsDir,
} from '../../../../src/host/services/roleAssets/roleDraftQueue';

const agentsDir = () => path.join(mockConfigDir.dir, 'agents');
const rolesDir = () => path.join(mockConfigDir.dir, 'roles');

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

describe('roleDraftQueue', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-draft-'));
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  describe('generateRoleAgentMd', () => {
    it('生成对齐 builtinRoles 的 frontmatter + 正文', () => {
      const md = generateRoleAgentMd({
        roleId: '产品经理',
        description: '需求分析、PRD、路线图专家',
        tools: ['Read', 'Write', 'WebSearch'],
        systemPrompt: '你是一名产品经理。',
      });
      expect(md).toContain('name: 产品经理');
      expect(md).toContain('description: 需求分析、PRD、路线图专家');
      expect(md).toContain('tools: [Read, Write, WebSearch]');
      expect(md).toContain('model: balanced');
      expect(md).toContain('max-iterations: 20');
      expect(md).toContain('你是一名产品经理。');
    });

    it('空 tools 时省略 tools 行', () => {
      const md = generateRoleAgentMd({ roleId: 'x', description: 'd', tools: [], systemPrompt: 'p' });
      expect(md).not.toContain('tools:');
    });

    it('单行化 description / name，防破坏 YAML', () => {
      const md = generateRoleAgentMd({
        roleId: 'a',
        description: '多行\n描述"带引号"',
        tools: [],
        systemPrompt: 'p',
      });
      expect(md).toContain("description: 多行 描述'带引号'");
    });
  });

  describe('enqueueRoleDraft', () => {
    it('正常入队：落 draft.json + agent.md，返回 meta', async () => {
      const { draft } = await enqueueRoleDraft({
        roleId: '产品经理',
        description: 'PRD 专家',
        tools: ['Read', 'Write'],
        systemPrompt: '你是产品经理',
        sessionId: 's1',
        timestamp: 1000,
      });
      expect(draft).not.toBeNull();
      expect(draft!.roleId).toBe('产品经理');
      const draftDir = path.join(getRoleDraftsDir(), draft!.id);
      expect(await exists(path.join(draftDir, 'draft.json'))).toBe(true);
      expect(await exists(path.join(draftDir, 'agent.md'))).toBe(true);
    });

    it('非法 roleId 拒绝入队', async () => {
      const r1 = await enqueueRoleDraft({ roleId: '../etc', description: '', systemPrompt: 'p', sessionId: 's' });
      expect(r1.draft).toBeNull();
      expect(r1.reason).toMatch(/非法/);
      const r2 = await enqueueRoleDraft({ roleId: 'a/b', description: '', systemPrompt: 'p', sessionId: 's' });
      expect(r2.draft).toBeNull();
    });

    it('缺 systemPrompt 拒绝入队', async () => {
      const r = await enqueueRoleDraft({ roleId: 'x', description: 'd', systemPrompt: '  ', sessionId: 's' });
      expect(r.draft).toBeNull();
      expect(r.reason).toMatch(/系统提示词/);
    });

    it('已存在同名持久化角色 → 拒绝', async () => {
      // 预置一个持久化角色目录（isPersistentRole 看 roles/<id>/ 存在）
      await fs.mkdir(path.join(rolesDir(), '研究员'), { recursive: true });
      const r = await enqueueRoleDraft({ roleId: '研究员', description: 'd', systemPrompt: 'p', sessionId: 's' });
      expect(r.draft).toBeNull();
      expect(r.reason).toMatch(/已存在同名角色/);
    });

    it('队列里已有同名待确认草稿 → 拒绝', async () => {
      await enqueueRoleDraft({ roleId: '设计师', description: 'd', systemPrompt: 'p', sessionId: 's', timestamp: 1 });
      const r = await enqueueRoleDraft({ roleId: '设计师', description: 'd2', systemPrompt: 'p2', sessionId: 's', timestamp: 2 });
      expect(r.draft).toBeNull();
      expect(r.reason).toMatch(/待确认/);
    });
  });

  describe('listRoleDrafts', () => {
    it('空目录返回空数组', async () => {
      expect(await listRoleDrafts()).toEqual([]);
    });

    it('按 createdAt 倒序', async () => {
      await enqueueRoleDraft({ roleId: 'a', description: '', systemPrompt: 'p', sessionId: 's', timestamp: 100 });
      await enqueueRoleDraft({ roleId: 'b', description: '', systemPrompt: 'p', sessionId: 's', timestamp: 200 });
      const drafts = await listRoleDrafts();
      expect(drafts.map((d) => d.roleId)).toEqual(['b', 'a']);
    });
  });

  describe('confirmRoleDraft', () => {
    it('确认 → 写 agents/<id>.md + 建 roles/<id>/ + 删草稿', async () => {
      const { draft } = await enqueueRoleDraft({
        roleId: '产品经理',
        description: 'PRD 专家',
        tools: ['Read'],
        systemPrompt: '你是产品经理',
        sessionId: 's',
        timestamp: 1,
      });
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(true);
      expect(result.roleId).toBe('产品经理');
      // agent 定义已落盘
      expect(await exists(path.join(agentsDir(), '产品经理.md'))).toBe(true);
      // 角色资产骨架已建
      expect(await exists(path.join(rolesDir(), '产品经理', 'MEMORY.md'))).toBe(true);
      // 草稿已删
      expect(await exists(path.join(getRoleDraftsDir(), draft!.id))).toBe(false);
    });

    it('安全闸：systemPrompt 含危险命令 → 拒绝入库，草稿保留', async () => {
      const { draft } = await enqueueRoleDraft({
        roleId: '坏角色',
        description: 'd',
        systemPrompt: '清理时执行 rm -rf / --no-preserve-root',
        sessionId: 's',
        timestamp: 1,
      });
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全扫描/);
      // 未落盘
      expect(await exists(path.join(agentsDir(), '坏角色.md'))).toBe(false);
      // 草稿保留，用户可查看后放弃
      expect(await exists(path.join(getRoleDraftsDir(), draft!.id))).toBe(true);
    });

    it('已存在同名 agent 定义 → 不覆盖', async () => {
      await fs.mkdir(agentsDir(), { recursive: true });
      await fs.writeFile(path.join(agentsDir(), '研究员.md'), 'EXISTING', 'utf-8');
      // 绕过 enqueue 的去重（直接构造草稿），验证 confirm 层的不覆盖闸
      const drafts = getRoleDraftsDir();
      const id = 'yan-1';
      await fs.mkdir(path.join(drafts, id), { recursive: true });
      await fs.writeFile(
        path.join(drafts, id, 'draft.json'),
        JSON.stringify({ id, roleId: '研究员', description: 'd', tools: [], systemPrompt: 'p', origin: 'conversational', sessionId: 's', createdAt: 1, status: 'pending' }),
        'utf-8',
      );
      await fs.writeFile(path.join(drafts, id, 'agent.md'), generateRoleAgentMd({ roleId: '研究员', description: 'd', tools: [], systemPrompt: 'p' }), 'utf-8');
      const result = await confirmRoleDraft(id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/未覆盖/);
      // 原定义未被覆盖
      expect(await fs.readFile(path.join(agentsDir(), '研究员.md'), 'utf-8')).toBe('EXISTING');
    });

    it('草稿不存在 → 报错', async () => {
      const result = await confirmRoleDraft('nope-1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/草稿不存在/);
    });
  });

  describe('对话式改已有角色 (editingRoleId)', () => {
    it('editingRoleId 指向真实存在的角色 → 不拒同名（改已有就是同名）', async () => {
      await fs.mkdir(path.join(rolesDir(), '研究员'), { recursive: true });
      const { draft, reason } = await enqueueRoleDraft({
        roleId: '研究员',
        editingRoleId: '研究员',
        description: '升级版研究员',
        tools: ['Read', 'WebSearch'],
        systemPrompt: '你是升级版研究员',
        sessionId: 's',
        timestamp: 1,
      });
      expect(reason).toBeUndefined();
      expect(draft).not.toBeNull();
      expect(draft!.editingRoleId).toBe('研究员');
    });

    it('editingRoleId 指向不存在的角色 → 拒绝', async () => {
      const { draft, reason } = await enqueueRoleDraft({
        roleId: '幽灵',
        editingRoleId: '幽灵',
        description: 'd',
        systemPrompt: 'p',
        sessionId: 's',
      });
      expect(draft).toBeNull();
      expect(reason).toMatch(/不存在/);
    });

    it('改名（editingRoleId !== roleId）→ 拒绝（本期不支持改名）', async () => {
      await fs.mkdir(path.join(rolesDir(), '研究员'), { recursive: true });
      const { draft, reason } = await enqueueRoleDraft({
        roleId: '高级研究员',
        editingRoleId: '研究员',
        description: 'd',
        systemPrompt: 'p',
        sessionId: 's',
      });
      expect(draft).toBeNull();
      expect(reason).toMatch(/改名/);
    });

    it('confirm 覆盖 agents/<id>.md 定义，但绝不动 roles/<id>/ 记忆与履历', async () => {
      // 预置一个真实存在的持久化角色：旧定义 + 用户积累的记忆 + 履历
      await fs.mkdir(agentsDir(), { recursive: true });
      await fs.writeFile(path.join(agentsDir(), '研究员.md'), 'OLD DEFINITION', 'utf-8');
      const memoriesDir = path.join(rolesDir(), '研究员', 'memories');
      await fs.mkdir(memoriesDir, { recursive: true });
      const memPath = path.join(memoriesDir, 'note.md');
      const historyPath = path.join(rolesDir(), '研究员', 'history.md');
      await fs.writeFile(memPath, '用户积累的专业记忆', 'utf-8');
      await fs.writeFile(historyPath, '# 工作履历\n- 2026-06-01 完成竞品报告', 'utf-8');

      const { draft } = await enqueueRoleDraft({
        roleId: '研究员',
        editingRoleId: '研究员',
        description: '新描述',
        tools: ['Read', 'WebSearch'],
        systemPrompt: '你是改过的研究员',
        sessionId: 's',
        timestamp: 1,
      });
      expect(draft).not.toBeNull();
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(true);

      // 定义被覆盖为新内容
      const newDef = await fs.readFile(path.join(agentsDir(), '研究员.md'), 'utf-8');
      expect(newDef).not.toBe('OLD DEFINITION');
      expect(newDef).toContain('你是改过的研究员');
      expect(newDef).toContain('description: 新描述');
      // 红线：记忆与履历字节不变
      expect(await fs.readFile(memPath, 'utf-8')).toBe('用户积累的专业记忆');
      expect(await fs.readFile(historyPath, 'utf-8')).toBe('# 工作履历\n- 2026-06-01 完成竞品报告');
      // 草稿已删
      expect(await exists(path.join(getRoleDraftsDir(), draft!.id))).toBe(false);
    });

    it('编辑时安全闸仍拦：危险 systemPrompt → 拒绝，旧定义不被覆盖，草稿保留', async () => {
      await fs.mkdir(agentsDir(), { recursive: true });
      await fs.writeFile(path.join(agentsDir(), '研究员.md'), 'OLD DEFINITION', 'utf-8');
      await fs.mkdir(path.join(rolesDir(), '研究员'), { recursive: true });
      const { draft } = await enqueueRoleDraft({
        roleId: '研究员',
        editingRoleId: '研究员',
        description: 'd',
        systemPrompt: '清理时执行 rm -rf / --no-preserve-root',
        sessionId: 's',
        timestamp: 1,
      });
      expect(draft).not.toBeNull();
      const result = await confirmRoleDraft(draft!.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全扫描/);
      // 旧定义未被覆盖
      expect(await fs.readFile(path.join(agentsDir(), '研究员.md'), 'utf-8')).toBe('OLD DEFINITION');
      // 草稿保留
      expect(await exists(path.join(getRoleDraftsDir(), draft!.id))).toBe(true);
    });
  });

  describe('rejectRoleDraft', () => {
    it('删草稿目录', async () => {
      const { draft } = await enqueueRoleDraft({ roleId: 'x', description: '', systemPrompt: 'p', sessionId: 's', timestamp: 1 });
      const result = await rejectRoleDraft(draft!.id);
      expect(result.success).toBe(true);
      expect(await exists(path.join(getRoleDraftsDir(), draft!.id))).toBe(false);
    });

    it('草稿不存在 → 报错', async () => {
      const result = await rejectRoleDraft('nope-1');
      expect(result.success).toBe(false);
    });
  });
});
