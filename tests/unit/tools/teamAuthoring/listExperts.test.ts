import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({ knownRoles: vi.fn() }));
vi.mock('../../../../src/host/services/team/teamRecipeService', () => ({ getTeamRecipeService: () => service }));

import { listExpertsModule } from '../../../../src/host/tools/modules/teamAuthoring/listExperts';
import { listExpertsSchema } from '../../../../src/host/tools/modules/teamAuthoring/listExperts.schema';

const allow = vi.fn(async () => ({ allow: true }));
const context = () => ({ abortSignal: { aborted: false } });

describe('list_experts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.knownRoles.mockResolvedValue([{ roleId: '研究员', displayName: '研究专家', description: '研究行业动态' }]);
  });

  it('以只读、plan 可用的 schema 注册', () => {
    expect(listExpertsSchema).toMatchObject({
      name: 'list_experts',
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    });
  });

  const runTool = async () =>
    (await listExpertsModule.createHandler()).execute({}, context() as never, allow as never);

  it('返回人类可读名册和结构化 meta', async () => {
    const result = await runTool();

    expect(result).toMatchObject({
      ok: true,
      output: '研究员（研究专家） — 研究行业动态',
      meta: { roles: [{ roleId: '研究员', displayName: '研究专家', description: '研究行业动态' }] },
    });
  });

  // 2026-07-23：用户实测「模型只念花名（青禾/牧之），不知道是干什么的」。
  // profession 数据一直都有，只是名册没带出来。
  describe('花名后面必须带上职业', () => {
    it('花名与 roleId 一致时只补职业', async () => {
      service.knownRoles.mockResolvedValue([
        { roleId: '青禾', displayName: '青禾', description: '陪你从选题到成稿', profession: '内容主理人' },
      ]);
      expect(await runTool()).toMatchObject({ output: '青禾（内容主理人） — 陪你从选题到成稿' });
    });

    it('花名与 roleId 不同时两者都带，花名在前', async () => {
      service.knownRoles.mockResolvedValue([
        { roleId: 'researcher', displayName: '溯真', description: '把问题查穿', profession: '行业研究员' },
      ]);
      expect(await runTool()).toMatchObject({ output: 'researcher（溯真 · 行业研究员） — 把问题查穿' });
    });

    it('没有职业也没有独立花名时不留空括号', async () => {
      service.knownRoles.mockResolvedValue([
        { roleId: '小助手', displayName: '小助手', description: '打杂' },
      ]);
      expect(await runTool()).toMatchObject({ output: '小助手 — 打杂' });
    });
  });

  it('空名册给出明确引导，不返回空串', async () => {
    service.knownRoles.mockResolvedValue([]);
    const result = await (await listExpertsModule.createHandler()).execute({}, context() as never, allow as never);

    expect(result).toMatchObject({ ok: true, output: '本机还没有可用专家，请先建一个角色。', meta: { roles: [] } });
  });
});
