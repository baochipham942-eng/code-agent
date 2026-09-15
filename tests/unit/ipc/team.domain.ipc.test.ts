import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// team.ipc.ts 派发特征测试（RQ-183 续作·TEAM 刀迁表前钉住 switch 形态；派发层原本零测试）：派发层 9 个 action（计数以切块断言为准）。
// - knownRoles / listDrafts / recipeList 原样回传
// - confirmDraft / rejectDraft：缺 draftId → INVALID_ARGS 'draftId is required'；有参委派
// - recipeCreate：缺 recipe → INVALID_ARGS；recipeDelete：缺 recipeId → INVALID_ARGS，删到 → { success: true }（无 data 键），没删到 → NOT_FOUND
// - recipeUpdate：缺 recipeId 或 recipe → INVALID_ARGS；update 回空 → NOT_FOUND；否则回传
// - launchRecipe：缺 sessionId / recipeId、topic 非字符串 → INVALID_ARGS；excludeMemberKeys 非数组 → undefined，数组只留字符串
// - 未知 action → UNKNOWN_ACTION + `Unknown team action: <action>`；抛错 → TEAM_RECIPE_LAUNCH_ERROR：Error 取 message、非 Error 取 String(error)
// 迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  launch: vi.fn(async (_a: unknown): Promise<unknown> => ({ launched: true })),
  svc: {
    knownRoles: vi.fn(async (): Promise<unknown> => ['pm', 'dev']),
    create: vi.fn(async (_r: unknown): Promise<unknown> => ({ id: 'r1' })),
    delete: vi.fn((_id: string): boolean => true),
    list: vi.fn((): unknown => [{ id: 'r1' }]),
    update: vi.fn(async (_id: string, _r: unknown): Promise<unknown> => ({ id: 'r1', v: 2 })),
  },
  confirm: vi.fn(async (_id: string): Promise<unknown> => ({ confirmed: true })),
  listDrafts: vi.fn(async (): Promise<unknown> => [{ draftId: 'd1' }]),
  reject: vi.fn(async (_id: string): Promise<unknown> => ({ rejected: true })),
}));

vi.mock('../../../src/host/services/team/teamRecipeLaunchService', () => ({ launchTeamRecipe: (a: unknown) => h.launch(a) }));
vi.mock('../../../src/host/services/team/teamRecipeService', () => ({ getTeamRecipeService: () => h.svc }));
vi.mock('../../../src/host/services/team/teamRecipeDraftQueue', () => ({
  confirmTeamRecipeDraft: (id: string) => h.confirm(id),
  listTeamRecipeDrafts: () => h.listDrafts(),
  rejectTeamRecipeDraft: (id: string) => h.reject(id),
}));

import { registerTeamHandlers } from '../../../src/host/ipc/team.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;
const invalid = (message: string) => ({ success: false, error: { code: 'INVALID_ARGS', message } });
const notFound = { success: false, error: { code: 'NOT_FOUND', message: 'team recipe not found' } };

beforeEach(() => {
  vi.clearAllMocks();
  const handlers = new Map<string, HandlerFn>();
  registerTeamHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.TEAM)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('team.ipc dispatch 特征：只读与草稿', () => {
  it('knownRoles / listDrafts / recipeList 原样回传', async () => {
    expect(await call('knownRoles')).toEqual({ success: true, data: ['pm', 'dev'] });
    expect(await call('listDrafts')).toEqual({ success: true, data: [{ draftId: 'd1' }] });
    expect(await call('recipeList')).toEqual({ success: true, data: [{ id: 'r1' }] });
  });

  it('confirmDraft / rejectDraft：缺 draftId 报错，有参委派', async () => {
    expect(await call('confirmDraft')).toEqual(invalid('draftId is required'));
    expect(await call('rejectDraft', {})).toEqual(invalid('draftId is required'));
    expect(await call('confirmDraft', { draftId: 'd1' })).toEqual({ success: true, data: { confirmed: true } });
    expect(await call('rejectDraft', { draftId: 'd2' })).toEqual({ success: true, data: { rejected: true } });
    expect(h.confirm).toHaveBeenCalledWith('d1');
    expect(h.reject).toHaveBeenCalledWith('d2');
  });
});

describe('team.ipc dispatch 特征：recipe 写入', () => {
  it('recipeCreate 缺 recipe 报错；recipeDelete 缺参 / 删到无 data 键 / 没删到 NOT_FOUND', async () => {
    expect(await call('recipeCreate', {})).toEqual(invalid('recipe is required'));
    expect(await call('recipeCreate', { recipe: { name: 'x' } })).toEqual({ success: true, data: { id: 'r1' } });
    expect(await call('recipeDelete', {})).toEqual(invalid('recipeId is required'));
    const ok = await call('recipeDelete', { recipeId: 'r1' });
    expect(ok).toEqual({ success: true });
    expect(Object.keys(ok)).toEqual(['success']);
    h.svc.delete.mockReturnValueOnce(false);
    expect(await call('recipeDelete', { recipeId: 'r9' })).toEqual(notFound);
  });

  it('recipeUpdate：缺参报错；update 回空 NOT_FOUND；否则回传', async () => {
    expect(await call('recipeUpdate', { recipeId: 'r1' })).toEqual(invalid('recipeId and recipe are required'));
    h.svc.update.mockResolvedValueOnce(null);
    expect(await call('recipeUpdate', { recipeId: 'r1', recipe: { n: 1 } })).toEqual(notFound);
    expect(await call('recipeUpdate', { recipeId: 'r1', recipe: { n: 1 } })).toEqual({ success: true, data: { id: 'r1', v: 2 } });
    expect(h.svc.update).toHaveBeenLastCalledWith('r1', { n: 1 });
  });
});

describe('team.ipc dispatch 特征：launchRecipe 与兜底', () => {
  it('launchRecipe：缺参 / topic 非字符串报错；excludeMemberKeys 非数组 undefined，数组只留字符串', async () => {
    const bad = invalid('sessionId, recipeId and topic are required');
    expect(await call('launchRecipe', { recipeId: 'r1', topic: 't' })).toEqual(bad);
    expect(await call('launchRecipe', { sessionId: 's1', recipeId: 'r1', topic: 3 })).toEqual(bad);
    expect(await call('launchRecipe', { sessionId: 's1', recipeId: 'r1', topic: '', excludeMemberKeys: 'pm' })).toEqual({ success: true, data: { launched: true } });
    expect(h.launch).toHaveBeenLastCalledWith({ sessionId: 's1', recipeId: 'r1', topic: '', excludeMemberKeys: undefined });
    await call('launchRecipe', { sessionId: 's1', recipeId: 'r1', topic: 'x', excludeMemberKeys: ['pm', 2, 'dev'] });
    expect(h.launch).toHaveBeenLastCalledWith({ sessionId: 's1', recipeId: 'r1', topic: 'x', excludeMemberKeys: ['pm', 'dev'] });
  });

  it('未知 action → UNKNOWN_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown team action: bogus' } });
  });

  it('抛 Error → TEAM_RECIPE_LAUNCH_ERROR + message；抛非 Error → String(error)', async () => {
    h.launch.mockRejectedValueOnce(new Error('no members'));
    expect(await call('launchRecipe', { sessionId: 's1', recipeId: 'r1', topic: 'x' })).toEqual({ success: false, error: { code: 'TEAM_RECIPE_LAUNCH_ERROR', message: 'no members' } });
    h.svc.list.mockImplementationOnce(() => { throw 'raw list'; });
    expect(await call('recipeList')).toEqual({ success: false, error: { code: 'TEAM_RECIPE_LAUNCH_ERROR', message: 'raw list' } });
  });
});
