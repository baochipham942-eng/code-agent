import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SKILL_CHANNELS } from '../../../src/shared/ipc/channels';

// skill.ipc.ts 是 skill:* 通道的注册中枢：仓库管理 / skill 启停 / 会话挂载 /
// 推荐目录 / SkillsMP 社区搜索 / combo 录制 / 草稿确认队列，全是瘦 try-catch 包装
// 委派给各 service。这里 mock 所有 service，逐通道验证「委派 + 成功副作用（刷新
// discovery）+ 错误重抛」，并对 handleSkillsMPSearch 覆盖 fetch 全部错误分支。

const svc = vi.hoisted(() => {
  const repo = {
    initialize: vi.fn(async () => {}),
    getLocalLibraries: vi.fn(() => [{ id: 'lib1' }]),
    downloadRepository: vi.fn(async () => ({ success: true })),
    updateRepository: vi.fn(async () => ({ success: true, hasUpdates: true })),
    removeRepository: vi.fn(async () => {}),
    addCustomRepository: vi.fn(async () => ({ success: true })),
    isSkillEnabled: vi.fn(() => true),
    enableSkill: vi.fn(),
    disableSkill: vi.fn(),
  };
  const discovery = {
    getWorkingDirectory: vi.fn(() => '/work'),
    ensureInitialized: vi.fn(async () => {}),
    refreshLibraries: vi.fn(async () => {}),
    getAllSkills: vi.fn(() => [{ name: 'pdf' }, { name: 'excel' }]),
    registerSkillsToToolSearch: vi.fn(),
    initialize: vi.fn(async () => {}),
  };
  const session = {
    mountSkill: vi.fn(async () => true),
    unmountSkill: vi.fn(() => true),
    getMountedSkills: vi.fn(() => [{ name: 'pdf' }]),
    recommendSkills: vi.fn(async () => [{ name: 'excel' }]),
  };
  const cloud = { getSkillCatalog: vi.fn(() => ({ repositories: [{ id: 'cloud-repo' }], categories: [] })) };
  const config = { getServiceApiKey: vi.fn(() => 'key-123') };
  const recorder = {
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    markTurn: vi.fn(),
    checkSuggestion: vi.fn(() => ({ suggested: false })),
    saveAsSkill: vi.fn(async () => ({ success: true })),
    getRecording: vi.fn(() => ({ sessionId: 's', toolNames: new Set(['read', 'write']) })),
  };
  const drafts = {
    listSkillDrafts: vi.fn(async () => [{ id: 'd1' }]),
    confirmSkillDraft: vi.fn(async () => ({ success: true })),
    rejectSkillDraft: vi.fn(async () => ({ success: true })),
  };
  return { repo, discovery, session, cloud, config, recorder, drafts };
});

vi.mock('../../../src/main/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => svc.repo,
}));
vi.mock('../../../src/main/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => svc.discovery,
}));
vi.mock('../../../src/main/services/skills/sessionSkillService', () => ({
  getSessionSkillService: () => svc.session,
}));
vi.mock('../../../src/main/services/skills/skillRepositories', () => ({
  RECOMMENDED_REPOSITORIES: [{ id: 'builtin-repo' }],
}));
vi.mock('../../../src/main/services/cloud', () => ({
  getCloudConfigService: () => svc.cloud,
}));
vi.mock('../../../src/main/services/core/configService', () => ({
  getConfigService: () => svc.config,
}));
vi.mock('../../../src/main/services/skills/comboRecorder', () => ({
  getComboRecorder: () => svc.recorder,
}));
vi.mock('../../../src/main/services/skills/skillDraftQueue', () => ({
  listSkillDrafts: (...a: unknown[]) => svc.drafts.listSkillDrafts(...a),
  confirmSkillDraft: (...a: unknown[]) => svc.drafts.confirmSkillDraft(...a),
  rejectSkillDraft: (...a: unknown[]) => svc.drafts.rejectSkillDraft(...a),
}));
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerSkillHandlers } from '../../../src/main/ipc/skill.ipc';

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;

function register() {
  const handlers = new Map<string, HandlerFn>();
  registerSkillHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  return (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args);
}

let call: ReturnType<typeof register>;

beforeEach(() => {
  vi.clearAllMocks();
  // 重置默认返回值 + 实现（clearAllMocks 不会清掉 mockImplementation/mockRejectedValue，
  // 故被测试改成 reject/throw 的桩必须在此显式复位，否则污染后续测试）
  svc.repo.initialize.mockResolvedValue(undefined);
  svc.repo.removeRepository.mockResolvedValue(undefined);
  svc.discovery.ensureInitialized.mockResolvedValue(undefined);
  svc.discovery.refreshLibraries.mockResolvedValue(undefined);
  svc.discovery.registerSkillsToToolSearch.mockReturnValue(undefined);
  svc.discovery.initialize.mockResolvedValue(undefined);
  svc.repo.getLocalLibraries.mockReturnValue([{ id: 'lib1' }]);
  svc.repo.downloadRepository.mockResolvedValue({ success: true });
  svc.repo.updateRepository.mockResolvedValue({ success: true, hasUpdates: true });
  svc.repo.addCustomRepository.mockResolvedValue({ success: true });
  svc.repo.isSkillEnabled.mockReturnValue(true);
  svc.discovery.getWorkingDirectory.mockReturnValue('/work');
  svc.discovery.getAllSkills.mockReturnValue([{ name: 'pdf' }, { name: 'excel' }]);
  svc.session.mountSkill.mockResolvedValue(true);
  svc.session.unmountSkill.mockReturnValue(true);
  svc.session.getMountedSkills.mockReturnValue([{ name: 'pdf' }]);
  svc.session.recommendSkills.mockResolvedValue([{ name: 'excel' }]);
  svc.cloud.getSkillCatalog.mockReturnValue({ repositories: [{ id: 'cloud-repo' }], categories: [] });
  svc.config.getServiceApiKey.mockReturnValue('key-123');
  svc.recorder.checkSuggestion.mockReturnValue({ suggested: false });
  svc.recorder.saveAsSkill.mockResolvedValue({ success: true });
  svc.recorder.getRecording.mockReturnValue({ sessionId: 's', toolNames: new Set(['read', 'write']) });
  svc.drafts.listSkillDrafts.mockResolvedValue([{ id: 'd1' }]);
  svc.drafts.confirmSkillDraft.mockResolvedValue({ success: true });
  svc.drafts.rejectSkillDraft.mockResolvedValue({ success: true });
  call = register();
});

describe('仓库管理', () => {
  it('REPO_LIST initialize 后返回本地库', async () => {
    expect(await call(SKILL_CHANNELS.REPO_LIST)).toEqual([{ id: 'lib1' }]);
    expect(svc.repo.initialize).toHaveBeenCalled();
  });

  it('REPO_DOWNLOAD 成功后刷新 discovery', async () => {
    const repo = { id: 'r' } as never;
    expect(await call(SKILL_CHANNELS.REPO_DOWNLOAD, repo)).toEqual({ success: true });
    expect(svc.repo.downloadRepository).toHaveBeenCalledWith(repo);
    expect(svc.discovery.refreshLibraries).toHaveBeenCalled();
  });

  it('REPO_DOWNLOAD 失败不刷新 discovery', async () => {
    svc.repo.downloadRepository.mockResolvedValue({ success: false });
    await call(SKILL_CHANNELS.REPO_DOWNLOAD, {} as never);
    expect(svc.discovery.refreshLibraries).not.toHaveBeenCalled();
  });

  it('REPO_UPDATE 有更新才刷新', async () => {
    await call(SKILL_CHANNELS.REPO_UPDATE, 'r1');
    expect(svc.discovery.refreshLibraries).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    svc.repo.updateRepository.mockResolvedValue({ success: true, hasUpdates: false });
    await call(SKILL_CHANNELS.REPO_UPDATE, 'r1');
    expect(svc.discovery.refreshLibraries).not.toHaveBeenCalled();
  });

  it('REPO_REMOVE 删后总刷新', async () => {
    await call(SKILL_CHANNELS.REPO_REMOVE, 'r1');
    expect(svc.repo.removeRepository).toHaveBeenCalledWith('r1');
    expect(svc.discovery.refreshLibraries).toHaveBeenCalled();
  });

  it('REPO_ADD_CUSTOM 成功后刷新', async () => {
    expect(await call(SKILL_CHANNELS.REPO_ADD_CUSTOM, 'http://x', 'mine')).toEqual({ success: true });
    expect(svc.repo.addCustomRepository).toHaveBeenCalledWith('http://x', 'mine');
    expect(svc.discovery.refreshLibraries).toHaveBeenCalled();
  });

  it('service 抛错时 handler 重抛', async () => {
    svc.repo.initialize.mockRejectedValue(new Error('boom'));
    await expect(call(SKILL_CHANNELS.REPO_LIST)).rejects.toThrow('boom');
  });
});

describe('skill 启停', () => {
  it('SKILL_LIST 附带全局启用状态', async () => {
    svc.repo.isSkillEnabled.mockImplementation((n: string) => n === 'pdf');
    const result = (await call(SKILL_CHANNELS.SKILL_LIST)) as Array<{ name: string; enabled: boolean }>;
    expect(result).toEqual([
      { name: 'pdf', enabled: true },
      { name: 'excel', enabled: false },
    ]);
  });

  it('SKILL_ENABLE 启用并刷新 ToolSearch 注册表', async () => {
    await call(SKILL_CHANNELS.SKILL_ENABLE, 'pdf');
    expect(svc.repo.enableSkill).toHaveBeenCalledWith('pdf');
    expect(svc.discovery.registerSkillsToToolSearch).toHaveBeenCalled();
  });

  it('SKILL_DISABLE 禁用并刷新注册表', async () => {
    await call(SKILL_CHANNELS.SKILL_DISABLE, 'pdf');
    expect(svc.repo.disableSkill).toHaveBeenCalledWith('pdf');
    expect(svc.discovery.registerSkillsToToolSearch).toHaveBeenCalled();
  });

  it('注册表刷新失败被吞掉（warn 不抛）', async () => {
    svc.discovery.registerSkillsToToolSearch.mockImplementation(() => {
      throw new Error('reg fail');
    });
    await expect(call(SKILL_CHANNELS.SKILL_ENABLE, 'pdf')).resolves.toBeUndefined();
  });
});

describe('会话挂载', () => {
  it('SESSION_MOUNT 委派并返回布尔', async () => {
    expect(await call(SKILL_CHANNELS.SESSION_MOUNT, 's1', 'pdf', 'lib1')).toBe(true);
    expect(svc.session.mountSkill).toHaveBeenCalledWith('s1', 'pdf', 'lib1', 'manual');
  });

  it('SESSION_UNMOUNT / SESSION_LIST 同步委派', async () => {
    expect(await call(SKILL_CHANNELS.SESSION_UNMOUNT, 's1', 'pdf')).toBe(true);
    expect(await call(SKILL_CHANNELS.SESSION_LIST, 's1')).toEqual([{ name: 'pdf' }]);
  });

  it('SESSION_RECOMMEND 缺 userInput 传空串', async () => {
    await call(SKILL_CHANNELS.SESSION_RECOMMEND, 's1');
    expect(svc.session.recommendSkills).toHaveBeenCalledWith('s1', '');
  });
});

describe('推荐目录', () => {
  it('RECOMMENDED_REPOS 云端优先', async () => {
    expect(await call(SKILL_CHANNELS.RECOMMENDED_REPOS)).toEqual([{ id: 'cloud-repo' }]);
  });

  it('RECOMMENDED_REPOS 云端异常降级到内置', async () => {
    svc.cloud.getSkillCatalog.mockImplementation(() => {
      throw new Error('no cloud');
    });
    expect(await call(SKILL_CHANNELS.RECOMMENDED_REPOS)).toEqual([{ id: 'builtin-repo' }]);
  });

  it('CATALOG 返回完整目录', async () => {
    expect(await call(SKILL_CHANNELS.CATALOG)).toMatchObject({ repositories: [{ id: 'cloud-repo' }] });
  });
});

describe('SkillsMP 社区搜索', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('未配置 API Key → MISSING_API_KEY', async () => {
    svc.config.getServiceApiKey.mockReturnValue(null);
    expect(await call(SKILL_CHANNELS.SKILLSMP_SEARCH, 'pdf')).toMatchObject({
      success: false,
      error: { code: 'MISSING_API_KEY' },
    });
  });

  it('成功响应转换为前端结构并带 total', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          skills: [
            { id: 'sk1', name: 'PDF', author: 'a', description: 'd', githubUrl: 'g', skillUrl: 's', stars: 5, updatedAt: 100 },
          ],
          pagination: { total: 1, page: 1, limit: 10 },
        },
      }),
    })) as never;
    const res = (await call(SKILL_CHANNELS.SKILLSMP_SEARCH, 'pdf', 5)) as {
      success: boolean;
      data: unknown[];
      total: number;
    };
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.total).toBe(1);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('q=pdf&limit=5');
  });

  it('401 → INVALID_API_KEY', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'unauth' })) as never;
    expect(await call(SKILL_CHANNELS.SKILLSMP_SEARCH, 'x')).toMatchObject({
      success: false,
      error: { code: 'INVALID_API_KEY' },
    });
  });

  it('其他 HTTP 错误 → HTTP_ERROR', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'oops' })) as never;
    expect(await call(SKILL_CHANNELS.SKILLSMP_SEARCH, 'x')).toMatchObject({
      success: false,
      error: { code: 'HTTP_ERROR' },
    });
  });

  it('success=false 的响应 → EMPTY_RESPONSE', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: false, error: '空' }) })) as never;
    expect(await call(SKILL_CHANNELS.SKILLSMP_SEARCH, 'x')).toMatchObject({
      success: false,
      error: { code: 'EMPTY_RESPONSE', message: '空' },
    });
  });

  it('超时 → TIMEOUT', async () => {
    global.fetch = vi.fn(async () => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      throw e;
    }) as never;
    expect(await call(SKILL_CHANNELS.SKILLSMP_SEARCH, 'x')).toMatchObject({
      success: false,
      error: { code: 'TIMEOUT' },
    });
  });

  it('其他异常 → NETWORK_ERROR', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as never;
    expect(await call(SKILL_CHANNELS.SKILLSMP_SEARCH, 'x')).toMatchObject({
      success: false,
      error: { code: 'NETWORK_ERROR' },
    });
  });
});

describe('combo 录制', () => {
  it('START/STOP/MARK_TURN 返回 success 并委派', async () => {
    expect(await call(SKILL_CHANNELS.COMBO_START, 's1')).toEqual({ success: true });
    expect(svc.recorder.startRecording).toHaveBeenCalledWith('s1');
    expect(await call(SKILL_CHANNELS.COMBO_STOP, 's1')).toEqual({ success: true });
    expect(await call(SKILL_CHANNELS.COMBO_MARK_TURN, 's1', 'hi')).toEqual({ success: true });
    expect(svc.recorder.markTurn).toHaveBeenCalledWith('s1', 'hi');
  });

  it('CHECK_SUGGESTION 透传 recorder 结果', async () => {
    expect(await call(SKILL_CHANNELS.COMBO_CHECK_SUGGESTION, 's1')).toEqual({ suggested: false });
  });

  it('COMBO_SAVE 委派 saveAsSkill', async () => {
    expect(await call(SKILL_CHANNELS.COMBO_SAVE, 's1', 'name', 'desc', '/wd')).toEqual({ success: true });
    expect(svc.recorder.saveAsSkill).toHaveBeenCalledWith('s1', 'name', 'desc', '/wd');
  });

  it('GET_RECORDING 把 toolNames Set 序列化为数组', async () => {
    expect(await call(SKILL_CHANNELS.COMBO_GET_RECORDING, 's1')).toEqual({
      sessionId: 's',
      toolNames: ['read', 'write'],
    });
  });

  it('GET_RECORDING 无录制返回 null', async () => {
    svc.recorder.getRecording.mockReturnValue(null);
    expect(await call(SKILL_CHANNELS.COMBO_GET_RECORDING, 's1')).toBeNull();
  });
});

describe('草稿确认队列', () => {
  it('DRAFT_LIST 委派', async () => {
    expect(await call(SKILL_CHANNELS.DRAFT_LIST)).toEqual([{ id: 'd1' }]);
  });

  it('DRAFT_CONFIRM 成功后重扫 discovery', async () => {
    expect(await call(SKILL_CHANNELS.DRAFT_CONFIRM, 'd1', '/wd')).toEqual({ success: true });
    expect(svc.discovery.initialize).toHaveBeenCalledWith('/wd');
  });

  it('DRAFT_CONFIRM 失败不重扫', async () => {
    svc.drafts.confirmSkillDraft.mockResolvedValue({ success: false });
    await call(SKILL_CHANNELS.DRAFT_CONFIRM, 'd1');
    expect(svc.discovery.initialize).not.toHaveBeenCalled();
  });

  it('DRAFT_REJECT 委派', async () => {
    expect(await call(SKILL_CHANNELS.DRAFT_REJECT, 'd1')).toEqual({ success: true });
  });

  it('DRAFT_LIST service 抛错重抛', async () => {
    svc.drafts.listSkillDrafts.mockRejectedValue(new Error('db down'));
    await expect(call(SKILL_CHANNELS.DRAFT_LIST)).rejects.toThrow('db down');
  });
});
