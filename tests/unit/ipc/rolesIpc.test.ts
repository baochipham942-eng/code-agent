// ============================================================================
// Roles IPC Handler Tests — domain:roles 的 list / detail / deleteMemory / updateMemory
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/host/config/configPaths', () => ({
  CONFIG_DIR_NEW: '.code-agent',
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  // serviceRegistry 经 sessionAutomation→sessionManager 链拉入时会读取 `logger` 默认实例，
  // 这里一并导出，避免「No "logger" export」模块加载错误。
  return { createLogger: () => stub, logger: stub };
});

// agentRegistry 返回固定的 agent 列表（研究员有定义，孤儿角色没有）
// 注意：预设角色（研究员）安装到用户目录后 registry 报 source: 'user'，
// list action 需要对照 BUILTIN_ROLE_IDS 改写为 'builtin'
vi.mock('../../../src/host/agent/agentRegistry', () => ({
  listAllAgents: () => [
    {
      id: '研究员',
      name: '调研、信息收集、报告产出专家',
      description: '调研、信息收集、报告产出专家',
      source: 'user',
      modelTier: 'balanced',
      readonly: false,
      tools: [],
    },
    {
      id: '自定义角色',
      name: '用户自建的角色',
      description: '用户自建的角色',
      source: 'user',
      modelTier: 'balanced',
      readonly: false,
      tools: [],
    },
  ],
  resolveAgent: () => undefined,
}));

// configService：有状态 mock（setProactivity 写入 → detail 读出）
const mockSettingsStore = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const mockUpdateSettings = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/core/configService', () => {
  const deepMerge = (base: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...base };
    for (const [key, value] of Object.entries(updates)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = deepMerge((result[key] ?? {}) as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  };
  return {
    getConfigService: () => ({ onSettingsUpdated: vi.fn(),
      getSettings: () => mockSettingsStore.value,
      getApiKey: () => '',
      updateSettings: mockUpdateSettings.mockImplementation(async (updates: Record<string, unknown>) => {
        mockSettingsStore.value = deepMerge(mockSettingsStore.value, updates);
      }),
    }),
  };
});

// cronService：setProactivity 后立即同步 cadence job
const mockCronCreateJob = vi.hoisted(() => vi.fn(async (def: unknown) => ({ ...(def as object), id: 'job-1' })));
const mockCronDeleteJob = vi.hoisted(() => vi.fn(async () => true));
const mockCronListJobs = vi.hoisted(() => vi.fn<() => unknown[]>(() => []));
const mockCronRows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('../../../src/host/cron/cronService', () => ({
  getCronService: () => ({
    listJobs: mockCronListJobs,
    createJob: mockCronCreateJob,
    updateJob: vi.fn(),
    deleteJob: mockCronDeleteJob,
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({ prepare: () => ({ all: () => mockCronRows.value }) }),
  }),
}));

// revealMemoryFolder 动态 import host/platform 调 shell.showItemInFolder；
// 其余导出原样透传，只替这一个方法（打样：vitest-fs-spy-vs-module-mock）。
const mockShowItemInFolder = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/platform')>();
  return { ...actual, shell: { ...actual.shell, showItemInFolder: mockShowItemInFolder } };
});

import { registerRolesHandlers, sanitizeLastWork } from '../../../src/host/ipc/roles.ipc';
import {
  ensureRoleAssetDirs,
  writeScopedMemory,
  appendRoleHistory,
  listScopedMemories,
} from '../../../src/host/services/roleAssets/roleAssetService';
import type { RolePanelDetail, RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import { BUILTIN_ROLES, installBuiltinRoles } from '../../../src/host/services/roleAssets/builtinRoles';

// 捕获注册的 handler，模拟 ipcHost
type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let registeredHandler: Handler;

const mockIpcMain = {
  handle: (_channel: string, handler: Handler) => {
    registeredHandler = handler;
  },
} as unknown as Parameters<typeof registerRolesHandlers>[0];

async function invoke<T>(action: string, payload?: unknown): Promise<IPCResponse<T>> {
  return registeredHandler(null, { action, payload }) as Promise<IPCResponse<T>>;
}

describe('roles.ipc (domain:roles)', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roles-ipc-'));
    mockSettingsStore.value = {};
    mockCronRows.value = [];
    mockCronListJobs.mockReturnValue([]);
    vi.clearAllMocks();
    registerRolesHandlers(mockIpcMain);
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  describe('list', () => {
    it('returns empty list when no persistent roles', async () => {
      const res = await invoke<RolePanelEntry[]>('list');
      expect(res.success).toBe(true);
      expect(res.data).toEqual([]);
    });

    it('lists roles with memory count / last work / agent info', async () => {
      await ensureRoleAssetDirs('研究员');
      await writeScopedMemory(
        { scope: 'role', roleId: '研究员' },
        { filename: 'a.md', name: 'A', description: 'da', content: 'ca' },
      );
      await writeScopedMemory(
        { scope: 'role', roleId: '研究员' },
        { filename: 'b.md', name: 'B', description: 'db', content: 'cb' },
      );
      await appendRoleHistory('研究员', {
        date: '2026-06-03',
        artifactLabel: 'Q2 报告',
        artifactRef: '-',
        summary: '产出报告',
      });

      const res = await invoke<RolePanelEntry[]>('list');
      expect(res.success).toBe(true);
      expect(res.data?.length).toBe(1);
      const entry = res.data![0];
      expect(entry.roleId).toBe('研究员');
      expect(entry.description).toContain('调研');
      expect(entry.memoryCount).toBe(2);
      expect(entry.lastWork).toBe('2026-06-03 产出报告');
    });

    it('returns null last work when a role has no history', async () => {
      await ensureRoleAssetDirs('研究员');
      const res = await invoke<RolePanelEntry[]>('list');
      expect(res.success).toBe(true);
      expect(res.data?.[0].lastWork).toBeNull();
    });

    it('marks builtin roles as builtin even when registry reports user source', async () => {
      // 预设角色安装到用户目录后 agentRegistry 报 source: 'user'，
      // 面板应显示"预设"而不是"自建"
      await ensureRoleAssetDirs('研究员');
      const res = await invoke<RolePanelEntry[]>('list');
      expect(res.success).toBe(true);
      expect(res.data![0].roleId).toBe('研究员');
      expect(res.data![0].source).toBe('builtin');
    });

    it('keeps user source for non-builtin roles', async () => {
      await ensureRoleAssetDirs('自定义角色');
      const res = await invoke<RolePanelEntry[]>('list');
      expect(res.success).toBe(true);
      expect(res.data![0].roleId).toBe('自定义角色');
      expect(res.data![0].source).toBe('user');
    });

    it('marks roles without agent definition as orphan', async () => {
      await ensureRoleAssetDirs('孤儿角色');
      const res = await invoke<RolePanelEntry[]>('list');
      expect(res.success).toBe(true);
      expect(res.data![0].source).toBe('orphan');
    });

    it('uses custom agent frontmatter visual, while builtin compiled visual wins', async () => {
      await ensureRoleAssetDirs('自定义角色');
      await ensureRoleAssetDirs('研究员');
      const agentsDir = path.join(mockConfigDir.dir, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, '自定义角色.md'), '---\nname: 自定义角色\ndisplay-name: 小满\nprofession: 增长顾问\ntags:\n  - 增长\nquick-prompts:\n  - 帮我看增长，给建议\n---\n正文', 'utf-8');
      await fs.writeFile(path.join(agentsDir, '研究员.md'), '---\nname: 研究员\ndisplay-name: 冒牌研究员\n---\n正文', 'utf-8');

      const res = await invoke<RolePanelEntry[]>('list');
      expect(res.data?.find((entry) => entry.roleId === '自定义角色')).toMatchObject({ displayName: '小满', profession: '增长顾问', tags: ['增长'], quickPrompts: ['帮我看增长，给建议'] });
      expect(res.data?.find((entry) => entry.roleId === '研究员')?.displayName).toBe('研究员');
    });
  });

  describe('listBoundCronJobs', () => {
    it('only returns cron jobs whose action binds the requested role, preserving agent and role wake types', async () => {
      mockCronRows.value = [
        { id: 'agent-for-role', name: '晨报', schedule: JSON.stringify({ type: 'every', interval: 1, unit: 'days' }), action: JSON.stringify({ type: 'agent', agentType: 'general', prompt: '晨报', roleId: '研究员' }), enabled: 1, last_run_at: 100 },
        { id: 'wake-for-role', name: '主动巡检', schedule: JSON.stringify({ type: 'cron', expression: '0 9 * * *' }), action: JSON.stringify({ type: 'role-wake', roleId: '研究员' }), enabled: 0, last_run_at: null },
        { id: 'other-role', name: '别人的任务', schedule: JSON.stringify({ type: 'every', interval: 1, unit: 'hours' }), action: JSON.stringify({ type: 'agent', agentType: 'general', prompt: 'x', roleId: '别的角色' }), enabled: 1, last_run_at: null },
      ];
      mockCronListJobs.mockReturnValue([{ id: 'agent-for-role', nextRunAt: 200 }]);

      const res = await invoke<import('../../../src/shared/contract/roleAssets').RoleBoundCronJob[]>('listBoundCronJobs', { roleId: '研究员' });

      expect(res.success).toBe(true);
      expect(res.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'agent-for-role', actionType: 'agent', nextRunAt: 200, lastRunAt: 100 }),
        expect.objectContaining({ id: 'wake-for-role', actionType: 'role_wake' }),
      ]));
      expect(res.data?.map((job) => job.id)).not.toContain('other-role');
    });

    it('skips malformed action JSON and actions without roleId without failing the lookup', async () => {
      mockCronRows.value = [
        { id: 'bad-json', name: '坏数据', schedule: JSON.stringify({ type: 'every', interval: 1, unit: 'hours' }), action: '{', enabled: 1, last_run_at: null },
        { id: 'no-role', name: '未绑定', schedule: JSON.stringify({ type: 'every', interval: 1, unit: 'hours' }), action: JSON.stringify({ type: 'agent', agentType: 'general', prompt: 'x' }), enabled: 1, last_run_at: null },
      ];

      const res = await invoke('listBoundCronJobs', { roleId: '研究员' });

      expect(res).toMatchObject({ success: true, data: [] });
    });
  });

  describe('detail', () => {
    it('requires roleId', async () => {
      const res = await invoke('detail');
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('INVALID_ARGS');
    });

    it('returns definition / memories / history', async () => {
      await ensureRoleAssetDirs('研究员');
      // 写入 agent 定义文件
      const agentsDir = path.join(mockConfigDir.dir, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, '研究员.md'), '---\nname: 研究员\n---\n\n你是研究员', 'utf-8');

      await writeScopedMemory(
        { scope: 'role', roleId: '研究员' },
        { filename: 'knowledge.md', name: '知识', description: '一条知识', content: '内容' },
      );
      await appendRoleHistory('研究员', {
        date: '2026-06-03',
        artifactLabel: '报告',
        artifactRef: '-',
        summary: 'x',
      });

      const res = await invoke<RolePanelDetail>('detail', { roleId: '研究员' });
      expect(res.success).toBe(true);
      expect(res.data?.definition).toContain('你是研究员');
      expect(res.data?.memories.length).toBe(1);
      expect(res.data?.memories[0].filename).toBe('knowledge.md');
      expect(res.data?.history.length).toBe(1);
      // 主动性配置：无任何配置时为出厂默认 silent
      expect(res.data?.proactivity.level).toBe('silent');
    });

    it('returns null definition when agent md missing', async () => {
      await ensureRoleAssetDirs('孤儿角色');
      const res = await invoke<RolePanelDetail>('detail', { roleId: '孤儿角色' });
      expect(res.success).toBe(true);
      expect(res.data?.definition).toBeNull();
    });

    it('tracks built-in edits against the installed factory definition and clears them on restore', async () => {
      const role = BUILTIN_ROLES.find((candidate) => candidate.id === '牧之')!;
      const installed = await installBuiltinRoles();
      expect(installed.installedAgents).toContain(role.id);

      const fresh = await invoke<RolePanelDetail>('detail', { roleId: role.id });
      expect(fresh.data?.locallyModified).toBe(false);

      const update = await invoke('updateVisual', {
        roleId: role.id,
        visual: { displayName: '改过的牧之' },
      });
      expect(update.success).toBe(true);
      const modified = await invoke<RolePanelDetail>('detail', { roleId: role.id });
      expect(modified.data?.locallyModified).toBe(true);

      const restore = await invoke('restoreFactory', { roleId: role.id });
      expect(restore.success).toBe(true);
      const restored = await invoke<RolePanelDetail>('detail', { roleId: role.id });
      expect(restored.data?.locallyModified).toBe(false);
    });

    it('omits locallyModified when a built-in definition file or factory template is missing', async () => {
      const activeRole = BUILTIN_ROLES.find((candidate) => candidate.id === '牧之')!;
      await ensureRoleAssetDirs(activeRole.id);
      const missingFile = await invoke<RolePanelDetail>('detail', { roleId: activeRole.id });
      expect(missingFile.data?.locallyModified).toBeUndefined();

      const agentsDir = path.join(mockConfigDir.dir, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, '研究员.md'), '---\nname: 研究员\n---\n退役定义', 'utf8');
      await ensureRoleAssetDirs('研究员');
      const retired = await invoke<RolePanelDetail>('detail', { roleId: '研究员' });
      expect(retired.data?.locallyModified).toBeUndefined();
    });
  });

  describe('deleteMemory', () => {
    it('deletes a role memory (E2E 验收 4 的后端路径)', async () => {
      await ensureRoleAssetDirs('研究员');
      await writeScopedMemory(
        { scope: 'role', roleId: '研究员' },
        { filename: 'to-delete.md', name: 'D', description: 'dd', content: 'cc' },
      );

      const res = await invoke('deleteMemory', { roleId: '研究员', filename: 'to-delete.md' });
      expect(res.success).toBe(true);

      const remaining = await listScopedMemories({ scope: 'role', roleId: '研究员' });
      expect(remaining.length).toBe(0);
    });

    it('requires roleId and filename', async () => {
      const res = await invoke('deleteMemory', { roleId: '研究员' });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('INVALID_ARGS');
    });
  });

  describe('updateMemory', () => {
    it('overwrites memory content', async () => {
      await ensureRoleAssetDirs('研究员');
      await writeScopedMemory(
        { scope: 'role', roleId: '研究员' },
        { filename: 'evolve.md', name: 'E', description: 'de', content: '旧内容' },
      );

      const res = await invoke('updateMemory', {
        roleId: '研究员',
        filename: 'evolve.md',
        name: 'E',
        description: 'de',
        content: '新内容',
      });
      expect(res.success).toBe(true);

      const memories = await listScopedMemories({ scope: 'role', roleId: '研究员' });
      expect(memories[0].content).toContain('新内容');
    });
  });

  describe('exportMemories（N-ROLE-MEMORY-EXPORT：全部记忆汇成一份 Markdown 落「下载」）', () => {
    // handleSaveTextToDownloads 直写 os.homedir()/Downloads——测试里换成临时目录，别污染真机
    let fakeHome: string;
    let homedirSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'roles-export-'));
      homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    });

    afterEach(() => {
      homedirSpy.mockRestore();
      return fs.rm(fakeHome, { recursive: true, force: true });
    });

    it('writes one Markdown digest covering every memory, in the order the detail page shows', async () => {
      await ensureRoleAssetDirs('研究员');
      await writeScopedMemory(
        { scope: 'role', roleId: '研究员' },
        { filename: 'alpha.md', name: 'Alpha 记忆', description: '调研偏好', content: 'alpha 正文' },
      );
      await writeScopedMemory(
        { scope: 'role', roleId: '研究员' },
        { filename: 'beta.md', name: 'Beta 记忆', description: '写作风格', content: 'beta 正文' },
      );

      const res = await invoke<{ filePath: string; count: number }>('exportMemories', { roleId: '研究员' });
      expect(res.success).toBe(true);
      expect(res.data?.count).toBe(2);

      // 「下载」目录里只落了这一个文件，名字带角色名与日期戳
      const downloads = await fs.readdir(path.join(fakeHome, 'Downloads'));
      expect(downloads.length).toBe(1);
      expect(path.basename(res.data!.filePath)).toMatch(/研究员-memories-\d{4}-\d{2}-\d{2}\.md$/);
      expect(downloads[0]).toBe(path.basename(res.data!.filePath));

      const text = await fs.readFile(res.data!.filePath, 'utf-8');
      // 页眉：角色 / 导出时间 / 条数 / 本地范围说明
      expect(text).toContain('# 研究员 Memories');
      expect(text).toContain('- Role ID: 研究员');
      expect(text).toContain('- Memories: 2');
      expect(text).toMatch(/- Exported at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(text).toContain('local memories only; the cloud copy is not included');

      // 逐条字段：与 detail 页同源（listScopedMemories），顺序也一致
      const listed = await listScopedMemories({ scope: 'role', roleId: '研究员' });
      expect(listed.length).toBe(2);
      const headingPositions = listed.map((memory) => text.indexOf(`## ${memory.name}`));
      expect(headingPositions[0]).toBeGreaterThanOrEqual(0);
      expect(headingPositions[1]).toBeGreaterThan(headingPositions[0]);
      for (const memory of listed) {
        expect(text).toContain(memory.name);
        expect(text).toContain(memory.description);
        expect(text).toContain(memory.filename);
        expect(text).toContain(memory.content);
        expect(text).toMatch(new RegExp(`- Last modified: ${memory.updatedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      }
    });

    it('refuses to export and writes nothing when the role has no memories', async () => {
      await ensureRoleAssetDirs('研究员');

      const res = await invoke<{ filePath: string }>('exportMemories', { roleId: '研究员' });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('NOTHING_TO_EXPORT');
      expect(res.error?.message).toBe('This role has no memories to export');

      const downloads = await fs.readdir(path.join(fakeHome, 'Downloads')).catch(() => [] as string[]);
      expect(downloads).toEqual([]);
    });

    it('requires roleId', async () => {
      const res = await invoke('exportMemories', {});
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('INVALID_ARGS');
    });
  });

  describe('revealMemoryFolder（N-ROLE-MEMORY-EXPORT：在文件管理器中定位记忆目录）', () => {
    it('reveals the absolute role memories dir via shell.showItemInFolder', async () => {
      await ensureRoleAssetDirs('研究员');

      const res = await invoke('revealMemoryFolder', { roleId: '研究员' });
      expect(res.success).toBe(true);
      expect(mockShowItemInFolder).toHaveBeenCalledWith(
        path.join(mockConfigDir.dir, 'roles', '研究员', 'memories'),
      );
    });

    it('rejects missing and path-traversing roleIds without touching the shell', async () => {
      const missing = await invoke('revealMemoryFolder', {});
      expect(missing.success).toBe(false);
      expect(missing.error?.code).toBe('INVALID_ARGS');

      // 路径穿越 roleId：getRoleMemoriesDir 内的 assertSafeRoleId 抛错 → 路由层包成 ROLES_ERROR
      const traversal = await invoke('revealMemoryFolder', { roleId: '../evil' });
      expect(traversal.success).toBe(false);
      expect(traversal.error?.code).toBe('ROLES_ERROR');

      expect(mockShowItemInFolder).not.toHaveBeenCalled();
    });
  });

  describe('updateVisual', () => {
    it('changes only target frontmatter keys and keeps unknown fields and body byte-for-byte', async () => {
      await ensureRoleAssetDirs('自定义角色');
      const agentsDir = path.join(mockConfigDir.dir, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      const body = '人设正文，必须保持不动。\n\n第二段。';
      await fs.writeFile(path.join(agentsDir, '自定义角色.md'), `---\nname: 自定义角色\nunknown-key: 不认识也要留下\ntools:\n  - Read\n---\n${body}`, 'utf-8');

      const res = await invoke('updateVisual', {
        roleId: '自定义角色',
        visual: { displayName: '小满', profession: '增长顾问', icon: 'Megaphone', category: 'content-marketing', tags: ['增长', '实验'], quickPrompts: ['帮我看增长，给建议'] },
      });
      expect(res.success).toBe(true);
      const saved = await fs.readFile(path.join(agentsDir, '自定义角色.md'), 'utf-8');
      expect(saved).toContain('unknown-key: 不认识也要留下');
      expect(saved).toContain('tags:\n  - 增长\n  - 实验');
      expect(saved).toContain('quick-prompts:\n  - 帮我看增长，给建议');
      expect(saved.slice(saved.indexOf('---\n', 4) + 4)).toBe(body);
    });
  });

  describe('E6-3 装备 / 正文 / 出厂还原', () => {
    it('装备保存保留未知 frontmatter 和正文，正文保存不触碰 frontmatter', async () => {
      const agentsDir = path.join(mockConfigDir.dir, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      const definitionPath = path.join(agentsDir, '自定义角色.md');
      const frontmatter = '---\nname: 自定义角色\nunknown-key: keep\nskills: [old]\ntools: [Read]\nmodel: fast\nmax-iterations: 3\n---';
      await fs.writeFile(definitionPath, `${frontmatter}\n旧正文`, 'utf8');

      const equipment = await invoke('updateEquipment', { roleId: '自定义角色', equipment: { skills: ['commit'], tools: ['Read'], model: 'powerful', engine: 'codex_cli', maxIterations: 22 } });
      expect(equipment.success).toBe(true);
      const afterEquipment = await fs.readFile(definitionPath, 'utf8');
      expect(afterEquipment).toContain('unknown-key: keep');
      expect(afterEquipment).toContain('skills:\n  - commit');
      expect(afterEquipment).toContain('engine: codex_cli');
      expect(afterEquipment.endsWith('\n旧正文')).toBe(true);

      const modelOnly = await invoke('updateEquipment', { roleId: '自定义角色', equipment: { skills: ['commit'], tools: ['Read'], model: 'fast', maxIterations: 22 } });
      expect(modelOnly.success).toBe(true);
      const afterModelOnly = await fs.readFile(definitionPath, 'utf8');
      expect(afterModelOnly).toContain('engine: codex_cli');

      const body = await invoke('updateDefinitionBody', { roleId: '自定义角色', body: '新正文\n第二行' });
      expect(body.success).toBe(true);
      const afterBody = await fs.readFile(definitionPath, 'utf8');
      expect(afterBody.slice(0, afterBody.indexOf('---', 4) + 3)).toBe(afterModelOnly.slice(0, afterModelOnly.indexOf('---', 4) + 3));
      expect(afterBody.endsWith('新正文\n第二行')).toBe(true);
    });

    it('拒绝不在 manifest 中的 engine', async () => {
      const res = await invoke('updateEquipment', {
        roleId: '自定义角色',
        equipment: { skills: [], tools: [], model: 'balanced', engine: 'imaginary_cli', maxIterations: 30 },
      });

      expect(res.success).toBe(false);
      expect(res.error?.message).toContain('Invalid agent engine');
    });

    it('内置角色还原逐字回到 BUILTIN_ROLES，且不动记忆履历；自建角色不提供还原入口', async () => {
      const role = BUILTIN_ROLES[0]!;
      const agentsDir = path.join(mockConfigDir.dir, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, `${role.id}.md`), `${role.agentMd}\n本地改动`, 'utf8');
      await ensureRoleAssetDirs(role.id);
      await writeScopedMemory({ scope: 'role', roleId: role.id }, { filename: 'keep.md', name: '保留', description: '使用痕迹', content: '不可删除' });
      await appendRoleHistory(role.id, { date: '2026-07-23', artifactLabel: '合作记录', artifactRef: '-', summary: '已经合作过' });

      const restore = await invoke('restoreFactory', { roleId: role.id });
      expect(restore.success).toBe(true);
      expect(await fs.readFile(path.join(agentsDir, `${role.id}.md`), 'utf8')).toBe(role.agentMd);
      expect((await listScopedMemories({ scope: 'role', roleId: role.id })).map((item) => item.filename)).toContain('keep.md');
      const builtinDetail = await invoke<RolePanelDetail>('detail', { roleId: role.id });
      expect(builtinDetail.data?.restore?.available).toBe(true);

      const customDetail = await invoke<RolePanelDetail>('detail', { roleId: '自定义角色' });
      expect(customDetail.data?.restore).toBeUndefined();
      // 变异守卫：若把自建角色也标记为可还原，这条断言应直接红。
      expect(customDetail.data?.restore?.available).not.toBe(true);
    });
  });

  describe('writeProjectMemory（资料库归档摘要 → 项目层记忆）', () => {
    it('writes a project-scope memory', async () => {
      const res = await invoke<{ path: string }>('writeProjectMemory', {
        workspacePath: '/tmp/demo-workspace',
        name: '周报定稿',
        description: '本周进展摘要',
        content: '正文',
      });
      expect(res.success).toBe(true);
      expect(res.data?.path).toContain('.md');

      const memories = await listScopedMemories({ scope: 'project', workspacePath: '/tmp/demo-workspace' });
      expect(memories.length).toBe(1);
      expect(memories[0].name).toBe('周报定稿');
      expect(memories[0].description).toBe('本周进展摘要');
    });

    it('重复归档同名产物覆盖同一条记忆，不产生重复条目', async () => {
      await invoke('writeProjectMemory', {
        workspacePath: '/tmp/demo-workspace', name: '周报定稿', description: 'v1', content: 'c1',
      });
      await invoke('writeProjectMemory', {
        workspacePath: '/tmp/demo-workspace', name: '周报定稿', description: 'v2', content: 'c2',
      });

      const memories = await listScopedMemories({ scope: 'project', workspacePath: '/tmp/demo-workspace' });
      expect(memories.length).toBe(1);
      expect(memories[0].content).toContain('c2');
    });

    it('requires workspacePath, name, description, content', async () => {
      const res = await invoke('writeProjectMemory', { workspacePath: '/tmp/x', name: 'n' });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('INVALID_ARGS');
    });
  });

  describe('bindings（E3 专家资料架）', () => {
    it('listBindings 空资料架返回空数组；addBinding→list→removeBinding 回环', async () => {
      const empty = await invoke<unknown[]>('listBindings', { roleId: '研究员' });
      expect(empty.success).toBe(true);
      expect(empty.data).toEqual([]);

      const boundFile = path.join(mockConfigDir.dir, 'bound.md');
      await fs.writeFile(boundFile, 'x', 'utf-8');
      const added = await invoke<{ id: string; kind: string }>('addBinding', {
        roleId: '研究员', kind: 'file', target: boundFile, mode: 'always',
      });
      expect(added.success).toBe(true);

      const listed = await invoke<Array<{ id: string }>>('listBindings', { roleId: '研究员' });
      expect(listed.data).toHaveLength(1);

      const removed = await invoke('removeBinding', { roleId: '研究员', bindingId: added.data!.id });
      expect(removed.success).toBe(true);
      const after = await invoke<unknown[]>('listBindings', { roleId: '研究员' });
      expect(after.data).toEqual([]);
    });

    it('addBinding 不再要求 scope；旧 renderer 多带的 scope 被忽略且不回写', async () => {
      const boundFile = path.join(mockConfigDir.dir, 'bound.md');
      await fs.writeFile(boundFile, 'x', 'utf-8');

      const noScope = await invoke<Record<string, unknown>>('addBinding', {
        roleId: '研究员', kind: 'file', target: boundFile, mode: 'always',
      });
      expect(noScope.success).toBe(true);
      expect(noScope.data).not.toHaveProperty('scope');

      const strayScope = await invoke<Record<string, unknown>>('addBinding', {
        roleId: '研究员', kind: 'file', target: boundFile, mode: 'on_demand', scope: 'project',
      });
      expect(strayScope.success).toBe(true);
      expect(strayScope.data).not.toHaveProperty('scope');

      // 同 kind+target 幂等去重：stray scope 没有生成第二条，也没有把 scope 写进文件
      const listed = await invoke<Array<Record<string, unknown>>>('listBindings', { roleId: '研究员' });
      expect(listed.data).toHaveLength(1);
      expect(listed.data![0]).not.toHaveProperty('scope');
    });

    it('addBinding 缺参 / 路径不存在都报错', async () => {
      const missingArgs = await invoke('addBinding', { roleId: '研究员', kind: 'file' });
      expect(missingArgs.success).toBe(false);
      expect(missingArgs.error?.code).toBe('INVALID_ARGS');
      expect(missingArgs.error?.message).toBe('roleId, kind, target, mode are required');

      const badPath = await invoke('addBinding', {
        roleId: '研究员', kind: 'file', target: path.join(mockConfigDir.dir, 'nope.md'), mode: 'always',
      });
      expect(badPath.success).toBe(false);
    });
  });

  describe('setProactivity（设置页开启主动性，docs/designs/role-proactivity.md §4）', () => {
    it('写入 settings 覆盖 + 立即同步 cadence cron + detail 反映新值', async () => {
      await ensureRoleAssetDirs('研究员');

      // 出厂默认 silent
      const before = await invoke<RolePanelDetail>('detail', { roleId: '研究员' });
      expect(before.data?.proactivity.level).toBe('silent');

      // 设置页开启每日简报
      const res = await invoke<{ proactivity: { level: string } }>('setProactivity', {
        roleId: '研究员',
        level: 'daily',
      });
      expect(res.success).toBe(true);
      expect(res.data?.proactivity.level).toBe('daily');

      // settings 写入了 per-role 覆盖
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        roleAssets: { proactivity: { roles: { 研究员: { level: 'daily' } } } },
      });
      // cadence cron 立即注册（不用等重启）
      expect(mockCronCreateJob).toHaveBeenCalledWith(
        expect.objectContaining({ action: { type: 'role-wake', roleId: '研究员' } }),
      );

      // detail 反映新值
      const after = await invoke<RolePanelDetail>('detail', { roleId: '研究员' });
      expect(after.data?.proactivity.level).toBe('daily');
    });

    it('关闭（改回 silent）后 detail 反映 silent', async () => {
      await ensureRoleAssetDirs('研究员');
      await invoke('setProactivity', { roleId: '研究员', level: 'daily' });
      await invoke('setProactivity', { roleId: '研究员', level: 'silent' });

      const detail = await invoke<RolePanelDetail>('detail', { roleId: '研究员' });
      expect(detail.data?.proactivity.level).toBe('silent');
    });

    it('话题包含/排除写入 settings 后 detail 仍能读回（重启同源：settings 持久化）', async () => {
      await ensureRoleAssetDirs('研究员');
      const res = await invoke<{ proactivity: { topicsInclude?: string[]; topicsExclude?: string[] } }>('setProactivity', {
        roleId: '研究员',
        level: 'daily',
        topicsInclude: ['项目进度', ' 项目进度 ', ''],
        topicsExclude: ['八卦'],
      });
      expect(res.success).toBe(true);
      expect(res.data?.proactivity.topicsInclude).toEqual(['项目进度']);
      expect(res.data?.proactivity.topicsExclude).toEqual(['八卦']);

      const detail = await invoke<RolePanelDetail>('detail', { roleId: '研究员' });
      expect(detail.data?.proactivity.topicsInclude).toEqual(['项目进度']);
      expect(detail.data?.proactivity.topicsExclude).toEqual(['八卦']);
    });

    it('免打扰时段可以被显式 null 清除（省略字段会被深合并保留，等于永远关不掉）', async () => {
      await ensureRoleAssetDirs('研究员');
      await invoke('setProactivity', {
        roleId: '研究员',
        level: 'daily',
        quietHours: { start: '22:00', end: '08:00' },
      });
      const set = await invoke<RolePanelDetail>('detail', { roleId: '研究员' });
      expect(set.data?.proactivity.quietHours).toEqual({ start: '22:00', end: '08:00' });

      await invoke('setProactivity', { roleId: '研究员', level: 'daily', quietHours: null });

      const cleared = await invoke<RolePanelDetail>('detail', { roleId: '研究员' });
      expect(cleared.data?.proactivity.quietHours ?? null).toBeNull();
    });

    it('校验 level 取值', async () => {
      const res = await invoke('setProactivity', { roleId: '研究员', level: 'always-on' });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('INVALID_ARGS');
    });

    it('requires roleId', async () => {
      const res = await invoke('setProactivity', { level: 'daily' });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('INVALID_ARGS');
    });
  });

  describe('deleteRole / restoreDeletedRole（N-ROLE-CREATE-DIRECT-DELETE）', () => {
    async function seedUser(roleId: string, marker: string) {
      const agentsDir = path.join(mockConfigDir.dir, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      const definition = `---\nname: ${roleId}\ndescription: ${marker}\n---\n\n${roleId} 的人设 ${marker}\n`;
      await fs.writeFile(path.join(agentsDir, `${roleId}.md`), definition, 'utf-8');
      const roleDir = path.join(mockConfigDir.dir, 'roles', roleId);
      await fs.mkdir(path.join(roleDir, 'memories'), { recursive: true });
      await fs.writeFile(path.join(roleDir, 'MEMORY.md'), `# ${roleId} 索引\n`, 'utf-8');
      await fs.writeFile(path.join(roleDir, 'history.md'), `- 2026-06-03 | 报告 | ${marker}\n`, 'utf-8');
      await fs.writeFile(path.join(roleDir, 'memories', 'a.md'), `---\nname: a\n---\n正文 ${marker}\n`, 'utf-8');
      return { definition, roleDir };
    }

    it('① 删除用户角色：定义与资产目录都进回收站，roster 与 agents 目录一致', async () => {
      const seeded = await seedUser('自定义角色', '待删');
      await seedUser('幸存角色', '留下');

      const res = await invoke<{ trashId: string }>('deleteRole', { roleId: '自定义角色' });
      expect(res.success).toBe(true);
      expect(typeof res.data?.trashId).toBe('string');

      // 定义与资产目录都不在原位，进了 roles-trash/<trashId>/
      const agentsDir = path.join(mockConfigDir.dir, 'agents');
      expect(await fs.readdir(agentsDir)).toEqual(['幸存角色.md']);
      expect(await fs.readdir(path.join(mockConfigDir.dir, 'roles'))).toEqual(['幸存角色']);
      const entry = path.join(mockConfigDir.dir, 'roles-trash', res.data!.trashId);
      expect(await fs.readFile(path.join(entry, 'agent.md'), 'utf-8')).toBe(seeded.definition);
      expect(await fs.readFile(path.join(entry, '自定义角色', 'memories', 'a.md'), 'utf-8')).toContain('待删');
      const meta = JSON.parse(await fs.readFile(path.join(entry, 'meta.json'), 'utf-8'));
      expect(meta.roleId).toBe('自定义角色');

      // roster（handleList）与 agents 目录一一对应：被删角色不再被列出
      const list = await invoke<RolePanelEntry[]>('list');
      expect(list.data?.map((entryItem) => entryItem.roleId)).toEqual(['幸存角色']);
    });

    it('② 内置 / 退役内置 / 装包角色以稳定 code 拒绝，文件字节不动', async () => {
      const builtin = await seedUser('数据分析师', '内置');
      const retired = await seedUser('研究员', '退役');
      await seedUser('包角色', '包');
      // role-packs.json：装包记录存在 → getInstalledRolePackState 返回非 null
      await fs.writeFile(path.join(mockConfigDir.dir, 'role-packs.json'), JSON.stringify({
        包角色: {
          packVersion: '1.0.0', installedAgentMdHash: 'deadbeef', installState: 'complete',
          missingSkills: [], installedSkills: [], installedAt: '2026-11-01T00:00:00Z', publisher: 'official',
        },
      }, null, 2), 'utf-8');
      const packDefinition = await fs.readFile(path.join(mockConfigDir.dir, 'agents', '包角色.md'), 'utf-8');

      const resBuiltin = await invoke('deleteRole', { roleId: '数据分析师' });
      expect(resBuiltin.success).toBe(false);
      expect(resBuiltin.error?.code).toBe('ROLE_DELETE_BUILTIN');

      const resRetired = await invoke('deleteRole', { roleId: '研究员' });
      expect(resRetired.success).toBe(false);
      expect(resRetired.error?.code).toBe('ROLE_DELETE_BUILTIN');

      const resPack = await invoke('deleteRole', { roleId: '包角色' });
      expect(resPack.success).toBe(false);
      expect(resPack.error?.code).toBe('ROLE_DELETE_PACK_INSTALLED');

      // 文件保持原样（字节一致），回收站也没有被创建
      expect(await fs.readFile(path.join(mockConfigDir.dir, 'agents', '数据分析师.md'), 'utf-8')).toBe(builtin.definition);
      expect(await fs.readFile(path.join(mockConfigDir.dir, 'agents', '研究员.md'), 'utf-8')).toBe(retired.definition);
      expect(await fs.readFile(path.join(mockConfigDir.dir, 'agents', '包角色.md'), 'utf-8')).toBe(packDefinition);
      expect(await fs.readdir(path.join(mockConfigDir.dir, 'roles', '数据分析师'))).toContain('MEMORY.md');
      expect(await fs.access(path.join(mockConfigDir.dir, 'roles-trash')).then(() => true, () => false)).toBe(false);
    });

    it('③ IPC 还原回环：restoreDeletedRole 把定义原样放回', async () => {
      const seeded = await seedUser('撤销角色', '撤销标记');
      const deleted = await invoke<{ trashId: string }>('deleteRole', { roleId: '撤销角色' });
      expect(deleted.success).toBe(true);

      const restored = await invoke<{ roleId: string }>('restoreDeletedRole', { trashId: deleted.data!.trashId });
      expect(restored.success).toBe(true);
      expect(restored.data?.roleId).toBe('撤销角色');
      expect(await fs.readFile(path.join(mockConfigDir.dir, 'agents', '撤销角色.md'), 'utf-8')).toBe(seeded.definition);
      expect(await fs.readFile(path.join(mockConfigDir.dir, 'roles', '撤销角色', 'history.md'), 'utf-8')).toContain('撤销标记');

      // 老的还原出厂测试用例语义不回退：自建角色没有 restore 信息
      const detail = await invoke<RolePanelDetail>('detail', { roleId: '撤销角色' });
      expect(detail.data?.isBuiltin).toBe(false);
    });

    it('缺参 / 未知条目返回稳定错误', async () => {
      const noRole = await invoke('deleteRole');
      expect(noRole.success).toBe(false);
      expect(noRole.error?.code).toBe('INVALID_ARGS');

      const noTrashId = await invoke('restoreDeletedRole');
      expect(noTrashId.success).toBe(false);
      expect(noTrashId.error?.code).toBe('INVALID_ARGS');

      const unknown = await invoke('restoreDeletedRole', { trashId: 'role-not-exist' });
      expect(unknown.success).toBe(false);
      expect(unknown.error?.code).toBe('ROLE_TRASH_NOT_FOUND');
    });
  });

  describe('unknown action', () => {
    it('returns UNKNOWN_ACTION', async () => {
      const res = await invoke('nope');
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('UNKNOWN_ACTION');
    });
  });
});

describe('sanitizeLastWork', () => {
  it('removes internal labels and leaked work directories from a history row', () => {
    expect(sanitizeLastWork('- 2026-07-22 | Directory: wt-e4a6fix | [工作目录: /private/tmp/xx/yy] 修复了侧栏对齐'))
      .toBe('2026-07-22 修复了侧栏对齐');
  });

  it('cleans absolute paths from an unstructured row', () => {
    expect(sanitizeLastWork('- 检查 /Users/linchen/project 和 C:\\workspace\\secret 后完成'))
      .toBe('检查 和 后完成');
  });

  it('falls back to the cleaned label when the summary only contains a path', () => {
    expect(sanitizeLastWork('- 2026-07-22 | 完成竞品报告 | ~/projects/private-report.md'))
      .toBe('2026-07-22 完成竞品报告');
  });
});
