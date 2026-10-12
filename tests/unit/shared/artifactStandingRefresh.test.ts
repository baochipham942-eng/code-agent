import { describe, expect, it } from 'vitest';
import { parseCronRunDigest } from '../../../src/shared/cronRunDigest';
import {
  buildStandingRefreshJobInput,
  findStandingRefreshJob,
  getArtifactRefreshMetadata,
  type StandingRefreshRef,
} from '../../../src/shared/artifactStandingRefresh';

const REF: StandingRefreshRef = {
  path: '/tmp/weekly-report.html',
  instruction: 'Refresh the numbers and rewrite the conclusion.',
  cadence: 'daily',
};

describe('buildStandingRefreshJobInput（payload 形状）', () => {
  it('hourly 走 every 1 小时，无 timezone 字段', () => {
    const input = buildStandingRefreshJobInput({ ...REF, cadence: 'hourly' }, '/tmp');
    expect(input.scheduleType).toBe('every');
    expect(input.schedule).toEqual({ type: 'every', interval: 1, unit: 'hours' });
    expect('timezone' in input.schedule).toBe(false);
  });

  it('daily 走 cron 0 9 * * *，weekly 走 cron 0 9 * * 1，都不固定时区', () => {
    const daily = buildStandingRefreshJobInput({ ...REF, cadence: 'daily' }, '/tmp');
    const weekly = buildStandingRefreshJobInput({ ...REF, cadence: 'weekly' }, '/tmp');
    expect(daily.scheduleType).toBe('cron');
    expect(daily.schedule).toEqual({ type: 'cron', expression: '0 9 * * *' });
    expect(weekly.schedule).toEqual({ type: 'cron', expression: '0 9 * * 1' });
    expect('timezone' in daily.schedule).toBe(false);
    expect('timezone' in weekly.schedule).toBe(false);
  });

  it('本地执行、默认启用、打 artifact-refresh 标签、名字来自文件名', () => {
    const input = buildStandingRefreshJobInput(REF, '/tmp');
    expect(input.runsOn).toBe('local');
    expect(input.enabled).toBe(true);
    expect(input.tags).toContain('artifact-refresh');
    expect(input.name).toBe('Refresh weekly-report.html');
  });

  it('metadata.artifactRefresh 完整在场（path/instruction/cadence）', () => {
    const input = buildStandingRefreshJobInput(REF, '/tmp');
    expect(input.metadata?.artifactRefresh).toEqual({
      path: '/tmp/weekly-report.html',
      instruction: 'Refresh the numbers and rewrite the conclusion.',
      cadence: 'daily',
    });
  });

  it('action 是 agent，prompt 点名绝对路径、含指令、并禁止写新文件', () => {
    const input = buildStandingRefreshJobInput(REF, '/tmp/workdir');
    expect(input.action.type).toBe('agent');
    if (input.action.type !== 'agent') throw new Error('unreachable');
    expect(input.action.agentType).toBe('default');
    const prompt = input.action.prompt;
    expect(prompt).toContain('/tmp/weekly-report.html');
    // 读与写都必须指向同一个绝对路径
    expect(prompt.match(/\/tmp\/weekly-report\.html/g)).toHaveLength(2);
    expect(prompt).toContain('Refresh the numbers and rewrite the conclusion.');
    expect(prompt).toContain('/tmp/workdir');
    expect(prompt).toMatch(/Never create a new file/i);
    expect(prompt).toMatch(/same file/i);
  });

  it('与 HANDOFF 交付契约兼容：以 artifact 行结尾的 cron_summary 能解析回该路径', () => {
    const input = buildStandingRefreshJobInput(REF, '/tmp');
    if (input.action.type !== 'agent') throw new Error('unreachable');
    const reply = [
      '已按指令更新周报。',
      '<cron_summary>',
      '更新了本周数据与结论。',
      `artifact: ${REF.path}`,
      '</cron_summary>',
    ].join('\n');
    const digest = parseCronRunDigest(reply);
    expect(digest.artifacts).toEqual([REF.path]);
    expect(digest.summary).toBe('更新了本周数据与结论。');
    // prompt 本身不得有与交付指令相抵触的措辞
    expect(input.action.prompt).not.toMatch(/do not (append|add)|不要(追加|添加)/i);
  });
});

describe('getArtifactRefreshMetadata（metadata 判读）', () => {
  it('合法形状完整读出，含 lastRefreshFailed', () => {
    expect(getArtifactRefreshMetadata({
      artifactRefresh: {
        path: '/tmp/a.json',
        instruction: 'keep it fresh',
        cadence: 'weekly',
        lastRefreshFailed: { at: 123, reason: 'agent run failed: boom' },
      },
    })).toEqual({
      path: '/tmp/a.json',
      instruction: 'keep it fresh',
      cadence: 'weekly',
      lastRefreshFailed: { at: 123, reason: 'agent run failed: boom' },
    });
  });

  it('形状不对（缺 path / cadence 非法 / 非 object / 缺整个键）一律 undefined', () => {
    expect(getArtifactRefreshMetadata(undefined)).toBeUndefined();
    expect(getArtifactRefreshMetadata({})).toBeUndefined();
    expect(getArtifactRefreshMetadata({ artifactRefresh: 'nope' })).toBeUndefined();
    expect(getArtifactRefreshMetadata({ artifactRefresh: { instruction: 'x', cadence: 'daily' } })).toBeUndefined();
    expect(getArtifactRefreshMetadata({ artifactRefresh: { path: '/tmp/a', instruction: 'x', cadence: 'monthly' } })).toBeUndefined();
    expect(getArtifactRefreshMetadata({ artifactRefresh: { path: '/tmp/a', instruction: 'x', cadence: 'daily', lastRefreshFailed: { at: 'soon' } } })
      ?.lastRefreshFailed).toBeUndefined();
  });
});

describe('findStandingRefreshJob（job 匹配）', () => {
  const job = (id: string, path: string, updatedAt: number) => ({
    id,
    enabled: true,
    updatedAt,
    metadata: { artifactRefresh: { path, instruction: `instruction for ${id}`, cadence: 'daily' } },
  });

  it('按路径命中并带回任务与指令', () => {
    const found = findStandingRefreshJob([job('j1', '/tmp/report.md', 1)], '/tmp/report.md');
    expect(found?.job.id).toBe('j1');
    expect(found?.refresh.instruction).toBe('instruction for j1');
  });

  it('尾分隔符不影响命中；不匹配则 undefined', () => {
    expect(findStandingRefreshJob([job('j1', '/tmp/report.md', 1)], '/tmp/report.md/')?.job.id).toBe('j1');
    expect(findStandingRefreshJob([job('j1', '/tmp/report.md', 1)], '/tmp/other.md')).toBeUndefined();
  });

  it('同路径多条时取 updatedAt 最新的那条', () => {
    const found = findStandingRefreshJob(
      [job('old', '/tmp/report.md', 1), job('new', '/tmp/report.md', 2)],
      '/tmp/report.md',
    );
    expect(found?.job.id).toBe('new');
  });
});
