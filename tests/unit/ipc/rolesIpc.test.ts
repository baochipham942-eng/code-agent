// ============================================================================
// Roles IPC Handler Tests — domain:roles 的 list / detail / deleteMemory / updateMemory
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// agentRegistry 返回固定的 agent 列表（研究员有定义，孤儿角色没有）
// 注意：预设角色（研究员）安装到用户目录后 registry 报 source: 'user'，
// list action 需要对照 BUILTIN_ROLE_IDS 改写为 'builtin'
vi.mock('../../../src/main/agent/agentRegistry', () => ({
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
}));

import { registerRolesHandlers } from '../../../src/main/ipc/roles.ipc';
import {
  ensureRoleAssetDirs,
  writeScopedMemory,
  appendRoleHistory,
  listScopedMemories,
} from '../../../src/main/services/roleAssets/roleAssetService';
import type { RolePanelDetail, RolePanelEntry } from '../../../src/shared/contract/roleAssets';

// 捕获注册的 handler，模拟 ipcMain
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

  describe('unknown action', () => {
    it('returns UNKNOWN_ACTION', async () => {
      const res = await invoke('nope');
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('UNKNOWN_ACTION');
    });
  });
});
