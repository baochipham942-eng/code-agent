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
    getConfigService: () => ({
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

vi.mock('../../../src/host/cron/cronService', () => ({
  getCronService: () => ({
    listJobs: () => [],
    createJob: mockCronCreateJob,
    updateJob: vi.fn(),
    deleteJob: mockCronDeleteJob,
  }),
}));

import { registerRolesHandlers } from '../../../src/host/ipc/roles.ipc';
import {
  ensureRoleAssetDirs,
  writeScopedMemory,
  appendRoleHistory,
  listScopedMemories,
} from '../../../src/host/services/roleAssets/roleAssetService';
import type { RolePanelDetail, RolePanelEntry } from '../../../src/shared/contract/roleAssets';

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
      expect(entry.lastWork).toContain('Q2 报告');
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
        roleId: '研究员', kind: 'file', target: boundFile, mode: 'always', scope: 'private',
      });
      expect(added.success).toBe(true);

      const listed = await invoke<Array<{ id: string }>>('listBindings', { roleId: '研究员' });
      expect(listed.data).toHaveLength(1);

      const removed = await invoke('removeBinding', { roleId: '研究员', bindingId: added.data!.id });
      expect(removed.success).toBe(true);
      const after = await invoke<unknown[]>('listBindings', { roleId: '研究员' });
      expect(after.data).toEqual([]);
    });

    it('addBinding 缺参 / 路径不存在都报错', async () => {
      const missingArgs = await invoke('addBinding', { roleId: '研究员', kind: 'file' });
      expect(missingArgs.success).toBe(false);
      expect(missingArgs.error?.code).toBe('INVALID_ARGS');

      const badPath = await invoke('addBinding', {
        roleId: '研究员', kind: 'file', target: path.join(mockConfigDir.dir, 'nope.md'), mode: 'always', scope: 'private',
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

  describe('unknown action', () => {
    it('returns UNKNOWN_ACTION', async () => {
      const res = await invoke('nope');
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('UNKNOWN_ACTION');
    });
  });
});
