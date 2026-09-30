import { performance } from 'node:perf_hooks';
import { describe, expect, beforeEach, it, vi } from 'vitest';
import type { LightMemoryFile } from '../../src/host/lightMemory/lightMemoryIpc';

const listMemoryFilesMock = vi.hoisted(() => vi.fn<() => Promise<LightMemoryFile[]>>());

vi.mock('../../src/host/lightMemory/lightMemoryIpc', () => ({
  listMemoryFiles: listMemoryFilesMock,
}));

const { buildUserProfileBlock, loadVoiceUserProfile } = await import('../../src/host/services/voice/voiceUserProfile');
const { composeVoiceInstructions } = await import('../../src/host/services/voice/voiceContextAssembler');

function file(overrides: Partial<LightMemoryFile> = {}): LightMemoryFile {
  return {
    filename: 'profile.md',
    name: 'Profile',
    description: '林晨是产品负责人，主要做 Agent Neo。',
    type: 'user',
    content: '林晨是产品负责人，主要做 Agent Neo。',
    updatedAt: '2026-09-30T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  listMemoryFilesMock.mockReset();
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
      file({ description: '邮箱 linchen@example.com' }),
      file({ description: '家目录 /Users/linchen/Documents/private' }),
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
    expect(block).not.toContain('linchen@example.com');
    expect(block).not.toContain('/Users/linchen');
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
