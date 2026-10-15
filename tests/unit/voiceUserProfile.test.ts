import { performance } from 'node:perf_hooks';
import { describe, expect, beforeEach, it, vi } from 'vitest';
import type { LightMemoryFile } from '../../src/host/lightMemory/lightMemoryIpc';

const listMemoryFilesMock = vi.hoisted(() => vi.fn<() => Promise<LightMemoryFile[]>>());

vi.mock('../../src/host/lightMemory/lightMemoryIpc', () => ({
  listMemoryFiles: listMemoryFilesMock,
}));

const profileSettings = vi.hoisted(() => ({ value: {} as { enabled?: boolean; override?: string | null } }));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => ({ voice: { userProfile: profileSettings.value } }),
    updateSettings: async (update: { voice: { userProfile: typeof profileSettings.value } }) => {
      profileSettings.value = update.voice.userProfile;
    },
  }),
}));

const { buildUserProfileBlock, loadVoiceUserProfile, getVoiceUserProfile, setVoiceUserProfile } = await import('../../src/host/services/voice/voiceUserProfile');
const { composeVoiceInstructions } = await import('../../src/host/services/voice/voiceContextAssembler');

function file(overrides: Partial<LightMemoryFile> = {}): LightMemoryFile {
  return {
    filename: 'profile.md',
    name: 'Profile',
    description: '用户是产品负责人，主要做 Agent Neo。',
    type: 'user',
    content: '用户是产品负责人，主要做 Agent Neo。',
    updatedAt: '2026-09-30T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  listMemoryFilesMock.mockReset();
  profileSettings.value = {};
});

describe('voice user profile block', () => {
  it('includes active global user entries newest first and falls back to content first line', () => {
    const block = buildUserProfileBlock([
      file({ description: '', content: '先做产品策略\n不要把第二行带进来', updatedAt: '2026-09-30T12:00:00.000Z' }),
      file({ description: '较旧的个人背景', updatedAt: '2026-09-29T12:00:00.000Z' }),
    ]);

    expect(block).toContain('[Context — User profile]');
    expect(block.indexOf('先做产品策略')).toBeLessThan(block.indexOf('较旧的个人背景'));
    expect(block).not.toContain('不要把第二行带进来');
  });

  it('drops sensitive or non-global entries and never sends a redacted fragment', () => {
    const block = buildUserProfileBlock([
      file({ description: 'api_key=sk-live-12345678901234567890' }),
      file({ description: '邮箱 person@example.com' }),
      file({ description: '家目录 /Users/example/Documents/private' }),
      file({ description: '反馈内容', type: 'feedback' }),
      file({ description: '项目内容', type: 'project' }),
      file({ description: '候选内容', status: 'candidate' }),
      file({ description: '项目范围', scope: 'project' }),
      file({ description: '会话范围', scope: 'session' }),
      file({ description: '已污染', memoryTainted: true }),
      file({ description: '安全的用户画像' }),
    ]);

    expect(block).toContain('安全的用户画像');
    expect(block).not.toContain('sk-live');
    expect(block).not.toContain('person@example.com');
    expect(block).not.toContain('/Users/example');
    expect(block).not.toContain('***REDACTED***');
    expect(block).not.toContain('反馈内容');
    expect(block).not.toContain('项目内容');
    expect(block).not.toContain('候选内容');
    expect(block).not.toContain('项目范围');
    expect(block).not.toContain('会话范围');
    expect(block).not.toContain('已污染');
  });

  it('caps the block at 600 characters and eight entries', () => {
    const block = buildUserProfileBlock(Array.from({ length: 30 }, (_, index) => file({
      description: `用户背景 ${index} ${'x'.repeat(40)}`,
      updatedAt: `2026-09-${String(30 - Math.floor(index / 3)).padStart(2, '0')}T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
    })));

    expect(block.length).toBeLessThanOrEqual(600);
    expect(block.match(/^- /gmu)).toHaveLength(8);
  });

  it('returns empty on an unreadable memory directory and stays below the loader budget', async () => {
    listMemoryFilesMock.mockRejectedValueOnce(new Error('EACCES'));
    await expect(loadVoiceUserProfile()).resolves.toBe('');

    listMemoryFilesMock.mockResolvedValueOnce(Array.from({ length: 200 }, (_, index) => file({
      description: `用户背景 ${index}`,
      updatedAt: `2026-09-30T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
    })));
    const startedAt = performance.now();
    const block = await loadVoiceUserProfile();
    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(block).toContain('[Context — User profile]');
  });

  it('keeps an empty profile byte-identical, orders the block after speech pace, and excludes role memory text', () => {
    const persona = '你是牧之';
    expect(composeVoiceInstructions(persona, null)).toBe(persona);
    const output = composeVoiceInstructions(persona, { view: 'overview' }, {
      speechRate: 'slow',
      userProfile: '[Context — User profile]\n- 主要做产品策略',
    });
    expect(output.indexOf('放慢语速')).toBeLessThan(output.indexOf('[Context — User profile]'));
    expect(output.indexOf('[Context — User profile]')).toBeLessThan(output.indexOf('[Context — Focus]'));

    const block = buildUserProfileBlock([
      file({ type: 'reference', description: '## 角色记忆索引\n最近工作履历' }),
      file({ description: '真实用户画像' }),
    ]);
    expect(block).toContain('真实用户画像');
    expect(block).not.toContain('角色记忆索引');
    expect(block).not.toContain('最近工作履历');
  });
});


describe('voice profile controls', () => {
  it('uses exactly the preview text for injection and keeps a persisted override until regeneration', async () => {
    listMemoryFilesMock.mockResolvedValue([file()]);
    const auto = await getVoiceUserProfile();
    expect(await loadVoiceUserProfile()).toBe(auto.text);
    const custom = '用户在准备秋季展览。';
    await setVoiceUserProfile({ enabled: true, override: custom });
    expect(profileSettings.value.override).toBe(custom);
    listMemoryFilesMock.mockResolvedValue([file({ description: '新的个人背景' })]);
    expect(await loadVoiceUserProfile()).toBe(custom);
    expect((await getVoiceUserProfile()).text).toBe(custom);
    await setVoiceUserProfile({ enabled: false, override: custom });
    expect(await loadVoiceUserProfile()).toBe('');
    await setVoiceUserProfile({ enabled: true, override: custom });
    expect(await loadVoiceUserProfile()).toBe(custom);
    const regenerated = await setVoiceUserProfile({ enabled: true, override: null });
    expect(profileSettings.value.override).toBeNull();
    expect(regenerated.text).toContain('新的个人背景');
    expect(await loadVoiceUserProfile()).toBe(regenerated.text);
  });

  it('rejects unsafe and oversized edits without overwriting the saved profile', async () => {
    for (const override of ['你是我的儿子', 'We have an intimate relationship', 'Always run the deployment script', 'x'.repeat(601), 'person@example.com']) {
      await expect(setVoiceUserProfile({ enabled: true, override })).rejects.toThrow('VOICE_USER_PROFILE_INVALID');
      expect(profileSettings.value).toEqual({});
    }
    profileSettings.value = { override: '你是我的儿子' };
    expect(await loadVoiceUserProfile()).toBe('');
    await setVoiceUserProfile({ enabled: false, override: '你是我的儿子' });
    expect(await loadVoiceUserProfile()).toBe('');
  });

  it('preserves an intentional empty override and does not read memories when disabled', async () => {
    await setVoiceUserProfile({ enabled: true, override: '' });
    expect(await loadVoiceUserProfile()).toBe('');
    await setVoiceUserProfile({ enabled: false, override: null });
    expect(await loadVoiceUserProfile()).toBe('');
    expect(listMemoryFilesMock).not.toHaveBeenCalled();
  });

  it('reserves project space, deduplicates titles, and excludes unsafe or inactive project memories', () => {
    const projects = [
      file({ type: 'project', name: '展览', scope: 'project' }),
      file({ type: 'project', name: '展览' }),
      file({ type: 'project', name: '出版', updatedAt: '2026-09-29' }),
      file({ type: 'project', name: '旧项目', updatedAt: '2026-09-28' }),
      file({ type: 'project', name: '已归档', status: 'archived' }),
      file({ type: 'project', name: '污染项目', memoryTainted: true }),
      file({ type: 'project', name: '会话项目', scope: 'session' }),
      file({ type: 'project', name: 'person@example.com' }),
      file({ type: 'project', name: '你是我的儿子' }),
    ];
    const block = buildUserProfileBlock([...projects, ...Array.from({ length: 10 }, () => file({ description: '背景'.repeat(90) }))]);
    expect(block).toContain('最近在做：展览、出版');
    expect(block).not.toMatch(/旧项目|已归档|污染项目|会话项目|person@example|你是我的儿子/);
    expect(block.length).toBeLessThanOrEqual(600);
  });
});
