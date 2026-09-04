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
import { renderAgentCatalogSection } from '../../../src/host/tools/modules/multiagent/agentDescription';
import { taskSchema } from '../../../src/host/tools/modules/multiagent/task.schema';
import { spawnAgentSchema } from '../../../src/host/tools/modules/multiagent/spawnAgent.schema';

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
inputs:
  - 目标文件路径
outputs:
  - markdown 报告
---

你是自定义 agent。
`;

const WEEKLY_MD = `---
name: 周报专家
description: 写周报
tools: [Read]
model: balanced
connectors:
  - tmeet-mcp|core|读取会议纪要，整理进周报
  - lark|optional|把周报发到群里
---

你是周报专家。
`;

describe('listAllAgentsWithRoleFlag', () => {
  beforeEach(async () => {
    mockDirs.agents = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-md-'));
    await fs.writeFile(path.join(mockDirs.agents, '研究员.md'), ROLE_MD);
    await fs.writeFile(path.join(mockDirs.agents, 'my-agent.md'), CUSTOM_MD);
    await fs.writeFile(path.join(mockDirs.agents, '周报专家.md'), WEEKLY_MD);
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

  it('listAllAgents 投影透出声明式 inputs/outputs', async () => {
    const entries = await listAllAgentsWithRoleFlag();
    expect(entries.find((e) => e.id === 'my-agent')).toMatchObject({
      inputs: ['目标文件路径'],
      outputs: ['markdown 报告'],
    });
  });

  // 底栏「专家带的连接器」靠 list 这条已有缓存拿数据，不另开 roles detail 往返；
  // 字段掉了底栏那颗组合图标就整个消失，所以在投影这一层咬住。
  it('listAllAgents 投影透出专家声明的推荐连接器；没声明的不带字段', async () => {
    const entries = await listAllAgentsWithRoleFlag();
    expect(entries.find((e) => e.id === '周报专家')?.connectors).toEqual([
      { id: 'tmeet-mcp', level: 'core', reason: '读取会议纪要，整理进周报' },
      { id: 'lark', level: 'optional', reason: '把周报发到群里' },
    ]);
    expect(entries.find((e) => e.id === 'my-agent')?.connectors).toBeUndefined();
  });

  it('Task/spawn_agent 动态描述列出 registry 里的自定义 agent 和 I/O 契约', () => {
    const taskDescription = taskSchema.dynamicDescription?.();
    const taskProps = taskSchema.inputSchema.properties as Record<string, { description?: string }>;
    const spawnProps = spawnAgentSchema.inputSchema.properties as Record<string, { description?: string }>;

    expect(taskDescription).toContain('- my-agent: 普通自定义 agent (inputs: 目标文件路径; outputs: markdown 报告)');
    expect(taskDescription).not.toBe('Available agent types: coder, reviewer, explore, plan, awaiter');
    expect(taskProps.subagent_type.description).toContain('my-agent');
    expect(spawnAgentSchema.dynamicDescription?.()).toContain('- my-agent: 普通自定义 agent (inputs: 目标文件路径; outputs: markdown 报告)');
    expect(spawnProps.role.description).toContain('my-agent');
  });

  it('动态 agent catalog 在 registry 为空或异常时 fallback 且不抛错', () => {
    expect(renderAgentCatalogSection(
      'Available agent types: coder, reviewer, explore, plan, awaiter',
      () => [],
    )).toBe('Available agent types: coder, reviewer, explore, plan, awaiter');
    expect(renderAgentCatalogSection(
      'Available agent types: coder, reviewer, explore, plan, awaiter',
      () => { throw new Error('registry unavailable'); },
    )).toBe('Available agent types: coder, reviewer, explore, plan, awaiter');
  });
});
