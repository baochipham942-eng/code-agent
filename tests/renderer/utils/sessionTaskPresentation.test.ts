import { describe, expect, it } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { formatSessionTaskOutput } from '../../../src/renderer/utils/sessionTaskPresentation';

const rawStatus = [
  '1. 写稿 [running] id=session-work-running',
  '2. 校对 [completed] id=session-work-completed',
  '3. 发布 [failed] id=session-work-failed',
  '4. 归档 [cancelled] id=session-work-cancelled',
].join('\n');

const statusMetadata = {
  sessionTask: {
    outcome: 'status',
    tasks: [
      { shortName: '写稿', status: 'running' },
      { shortName: '校对', status: 'completed', detail: '已经核对' },
      { shortName: '发布', status: 'failed', detail: '服务暂时不可用' },
      { shortName: '归档', status: 'cancelled' },
    ],
  },
};

describe('sessionTaskPresentation', () => {
  it('renders structured running, completed, failed, and interrupted statuses in plain zh and en', () => {
    expect(formatSessionTaskOutput(statusMetadata, rawStatus, zh)).toBe([
      '写稿　进行中',
      '校对　已完成：已经核对',
      '发布　失败：服务暂时不可用',
      '归档　已中断',
    ].join('\n'));
    expect(formatSessionTaskOutput(statusMetadata, rawStatus, en)).toBe([
      '写稿　Running',
      '校对　Completed: 已经核对',
      '发布　Failed: 服务暂时不可用',
      '归档　Interrupted',
    ].join('\n'));
  });

  it('renders accepted, queued, and reused outcomes without model-facing ids or outcome tokens', () => {
    expect(formatSessionTaskOutput({
      sessionTask: { outcome: 'accepted', tasks: [{ shortName: '小测', status: 'running' }] },
    }, 'accepted raw id=session-work-a', zh)).toBe('已在后台开始：小测，完成后会告诉你。');
    expect(formatSessionTaskOutput({
      sessionTask: { outcome: 'queued', tasks: [{ shortName: '校对', status: 'queued' }] },
    }, 'queued raw id=session-work-b', en)).toBe('Queued: 校对. It will start automatically when its turn comes.');
    expect(formatSessionTaskOutput({
      sessionTask: { outcome: 'reused', tasks: [{ shortName: '写稿', status: 'running' }] },
    }, 'reused raw id=session-work-c', zh)).toBe('继续跟踪后台任务：写稿　进行中');
  });

  it('preserves the old raw output when sessionTask metadata is absent or invalid', () => {
    expect(formatSessionTaskOutput(undefined, rawStatus, zh)).toBe(rawStatus);
    expect(formatSessionTaskOutput({ sessionTask: { outcome: 'status', tasks: [] } }, rawStatus, en))
      .toBe(rawStatus);
  });
});
