import { describe, expect, it } from 'vitest';
import { splitCronRunMessage } from '../../../src/shared/cronRunMessage';

describe('splitCronRunMessage', () => {
  it('hides snapshots, unwraps alerts, and turns the summary into a card payload', () => {
    const segments = splitCronRunMessage([
      '正文开头',
      '<cron_snapshot>',
      '内部快照不应出现',
      '</cron_snapshot>',
      '<cron_alert>',
      '新发现的冲突',
      '</cron_alert>',
      '正文中间',
      '<cron_summary>',
      'urgency: fyi',
      '本周汇总完成',
      'artifact: report.md',
      'artifact: /tmp/extra.txt',
      '</cron_summary>',
      '正文结尾',
    ].join('\n'));

    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'alert', 'text', 'summary', 'text']);
    expect(segments.map((segment) => segment.text).join('\n')).not.toContain('内部快照');
    expect(segments.map((segment) => segment.text).join('\n')).not.toContain('urgency:');
    expect(segments.map((segment) => segment.text).join('\n')).not.toContain('<cron_');
    expect(segments[1]).toEqual({ kind: 'alert', text: '新发现的冲突', artifacts: [] });
    expect(segments[3]).toEqual({
      kind: 'summary',
      text: '本周汇总完成',
      artifacts: ['report.md', '/tmp/extra.txt'],
    });
  });

  it('drops an unclosed snapshot and keeps an unclosed alert body without the tag', () => {
    const snapshot = splitCronRunMessage('可见<cron_snapshot>秘密');
    expect(snapshot).toEqual([{ kind: 'text', text: '可见', artifacts: [] }]);
    const alert = splitCronRunMessage('前缀<cron_alert>还在写');
    expect(alert).toEqual([
      { kind: 'text', text: '前缀', artifacts: [] },
      { kind: 'alert', text: '还在写', artifacts: [] },
    ]);
  });
});
