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

  it('返回人类可读名册和结构化 meta', async () => {
    const result = await (await listExpertsModule.createHandler()).execute({}, context() as never, allow as never);

    expect(result).toMatchObject({
      ok: true,
      output: '研究员 — 研究专家：研究行业动态',
      meta: { roles: [{ roleId: '研究员', displayName: '研究专家', description: '研究行业动态' }] },
    });
  });

  it('空名册给出明确引导，不返回空串', async () => {
    service.knownRoles.mockResolvedValue([]);
    const result = await (await listExpertsModule.createHandler()).execute({}, context() as never, allow as never);

    expect(result).toMatchObject({ ok: true, output: '本机还没有可用专家，请先建一个角色。', meta: { roles: [] } });
  });
});
