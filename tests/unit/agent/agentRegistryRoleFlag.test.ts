// ============================================================================
// listAllAgentsWithRoleFlag — 角色条目标记（/agent 面板 roles 分组的数据源）
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockDirs = vi.hoisted(() => ({ agents: '' }));

vi.mock('../../../src/host/config/configPaths', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentsMdDir: () => ({ user: mockDirs.agents, project: undefined }),
}));

vi.mock('../../../src/host/services/roleAssets/roleAssetService', () => ({
  listPersistentRoles: async () => ['研究员'],
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  initAgentRegistry,
  disposeAgentRegistry,
  listAllAgentsWithRoleFlag,
} from '../../../src/host/agent/agentRegistry';

const ROLE_MD = `---
name: 研究员
description: 调研专家
tools: [Read, Grep]
model: balanced
---

你是研究员。
`;

const CUSTOM_MD = `---
name: my-agent
description: 普通自定义 agent
tools: [Read]
model: balanced
---

你是自定义 agent。
`;

describe('listAllAgentsWithRoleFlag', () => {
  beforeEach(async () => {
    mockDirs.agents = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-md-'));
    await fs.writeFile(path.join(mockDirs.agents, '研究员.md'), ROLE_MD);
    await fs.writeFile(path.join(mockDirs.agents, 'my-agent.md'), CUSTOM_MD);
    await initAgentRegistry(undefined);
  });

  afterEach(async () => {
    await disposeAgentRegistry();
    await fs.rm(mockDirs.agents, { recursive: true, force: true });
  });

  it('roles 目录同名条目标记 isRole，普通自定义与内置不标', async () => {
    const entries = await listAllAgentsWithRoleFlag();
    expect(entries.find((e) => e.id === '研究员')?.isRole).toBe(true);
    expect(entries.find((e) => e.id === 'my-agent')?.isRole).toBeUndefined();
    expect(entries.find((e) => e.id === 'coder')?.isRole).toBeUndefined();
  });
});
