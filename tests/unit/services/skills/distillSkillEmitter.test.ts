import { describe, expect, it, vi } from 'vitest';
import { emitSkillAsset } from '../../../../src/main/services/skills/distillSkillEmitter';

const NOW = Date.UTC(2026, 5, 12, 9, 0, 0);

describe('distillSkillEmitter', () => {
  it('manual（draft=false）→ 走 SkillCreate 通道，返回真实路径并激活', async () => {
    const skillCreate = vi.fn(async () => ({
      ok: true as const,
      output: 'created',
      meta: { name: 'weekly-report', scope: 'user', path: '/home/.code-agent/skills/weekly-report/SKILL.md' },
    }));

    const result = await emitSkillAsset(
      { name: 'weekly-report', description: '每周报告', body: '# 步骤\n1. ...' },
      { draft: false, now: NOW, deps: { skillCreate } },
    );

    expect(skillCreate).toHaveBeenCalledOnce();
    const [args] = skillCreate.mock.calls[0];
    expect(args).toMatchObject({ name: 'weekly-report', description: '每周报告', content: '# 步骤\n1. ...' });
    expect(result.activated).toBe(true);
    expect(result.location).toBe('/home/.code-agent/skills/weekly-report/SKILL.md');
  });

  it('SkillCreate 通道返回失败（如已存在）→ 抛错给上游记 emit-failed', async () => {
    const skillCreate = vi.fn(async () => ({
      ok: false as const,
      error: 'Skill "weekly-report" 已存在（来源: user, 路径: /x）',
      code: 'SKILL_EXISTS',
    }));

    await expect(
      emitSkillAsset(
        { name: 'weekly-report', description: 'd', body: 'b' },
        { draft: false, now: NOW, deps: { skillCreate } },
      ),
    ).rejects.toThrow(/已存在/);
  });

  it('auto（draft=true）→ 走 skillDraftQueue 入队（origin llm-review），不激活', async () => {
    const enqueueDraft = vi.fn(async () => ({
      id: 'weekly-report-123',
      name: 'weekly-report',
      description: 'd',
      patternKey: 'distill:weekly-report',
      toolSequence: [],
      occurrences: 2,
      origin: 'llm-review' as const,
      sessionId: 'distill-run',
      createdAt: NOW,
      status: 'pending' as const,
    }));

    const result = await emitSkillAsset(
      { name: 'weekly-report', description: 'd', body: 'skill body', occurrences: 2 },
      { draft: true, now: NOW, deps: { enqueueDraft } },
    );

    expect(enqueueDraft).toHaveBeenCalledOnce();
    const [input] = enqueueDraft.mock.calls[0];
    expect(input).toMatchObject({
      name: 'weekly-report',
      patternKey: 'distill:weekly-report',
      origin: 'llm-review',
      body: 'skill body',
      occurrences: 2,
      timestamp: NOW,
    });
    expect(result.activated).toBe(false);
    expect(result.location).toContain('weekly-report-123');
  });

  it('草稿队列拒收（重复/低价值名/曾被拒）→ 抛错而非静默吞掉', async () => {
    const enqueueDraft = vi.fn(async () => null);
    await expect(
      emitSkillAsset({ name: 'weekly-report', description: 'd', body: 'b' }, { draft: true, now: NOW, deps: { enqueueDraft } }),
    ).rejects.toThrow(/拒收|rejected/i);
  });
});
