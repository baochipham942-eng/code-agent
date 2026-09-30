import { describe, expect, it } from 'vitest';
import { buildCronAgentPrompt } from '../../../src/host/cron/cronAgentPrompt';
import { groupRunsByTask, parseCronRunDigest } from '../../../src/shared/cronRunDigest';

describe('parseCronRunDigest', () => {
  it('extracts the summary and multiple artifact links from the first block', () => {
    expect(parseCronRunDigest(
      'ignored <cron_summary>\n完成日报\nartifact: /tmp/report.md\nARTIFACT: https://example.com/report\n</cron_summary> ignored',
    )).toEqual({
      summary: '完成日报',
      artifacts: ['/tmp/report.md', 'https://example.com/report'],
    });
  });

  it('returns an empty artifact list when there is no complete block', () => {
    expect(parseCronRunDigest('没有摘要')).toEqual({ artifacts: [] });
    expect(() => parseCronRunDigest('<cron_summary>未闭合')).not.toThrow();
    expect(parseCronRunDigest('<cron_summary>未闭合')).toEqual({ artifacts: [] });
  });

  it('caps an over-long summary at 1000 characters and ignores content outside the block', () => {
    const summary = 'a'.repeat(1001);
    expect(parseCronRunDigest(`外部文字<cron_summary>${summary}</cron_summary>外部文字`)).toEqual({
      summary: 'a'.repeat(1000),
      artifacts: [],
    });
  });

  it('limits extracted artifacts to ten lines', () => {
    const body = Array.from({ length: 12 }, (_, index) => `artifact: /tmp/${index}`).join('\n');
    expect(parseCronRunDigest(`<CRON_SUMMARY>${body}</CRON_SUMMARY>`).artifacts).toEqual(
      Array.from({ length: 10 }, (_, index) => `/tmp/${index}`),
    );
  });
});

describe('buildCronAgentPrompt delivery digest instruction', () => {
  it('includes the digest instruction in both modes and keeps snapshot guidance enabled', () => {
    const enabled = buildCronAgentPrompt('检查', null, true, new Date('2026-09-30T00:00:00.000Z'));
    const disabled = buildCronAgentPrompt('检查', null, false, new Date('2026-09-30T00:00:00.000Z'));

    expect(enabled).toContain('<cron_summary>...</cron_summary>');
    expect(enabled).toContain('artifact: <path>');
    expect(enabled).toContain('<cron_snapshot>...</cron_snapshot>');
    expect(disabled).toContain('<cron_summary>...</cron_summary>');
    expect(disabled).toContain('artifact: <path>');
  });
});

describe('groupRunsByTask', () => {
  it('groups cron and heartbeat runs by origin id, newest first', () => {
    const old = { id: 's-old', updatedAt: 10, origin: { kind: 'cron' as const, id: 'job-a' } };
    const newest = { id: 's-new', updatedAt: 30, origin: { kind: 'heartbeat' as const, id: 'job-a' } };
    const other = { id: 's-other', updatedAt: 20, origin: { kind: 'cron' as const, id: 'job-b' } };
    const result = groupRunsByTask([old, newest, other]);

    expect(result.groups['job-a']).toMatchObject({
      runCount: 2,
      latestSessionId: 's-new',
      runs: [newest, old],
    });
    expect(result.groups['job-b']).toMatchObject({ runCount: 1, latestSessionId: 's-other' });
  });

  it('passes non-cron sessions through in their original order', () => {
    const manual = { id: 'manual', updatedAt: 30, origin: { kind: 'manual' as const } };
    const noOrigin = { id: 'plain', updatedAt: 20 };
    const cron = { id: 'cron', updatedAt: 10, origin: { kind: 'cron' as const, id: 'job-a' } };

    expect(groupRunsByTask([manual, noOrigin, cron]).ungrouped).toEqual([manual, noOrigin]);
  });
});
