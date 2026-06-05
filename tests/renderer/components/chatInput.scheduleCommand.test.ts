import { describe, expect, it } from 'vitest';
import {
  isScheduleCommand,
  parseScheduleCommand,
} from '../../../src/renderer/components/features/chat/ChatInput/parseScheduleCommand';

describe('/schedule command helpers', () => {
  it('detects only the schedule slash command', () => {
    expect(isScheduleCommand('/schedule 每天早上8点跑市场调研')).toBe(true);
    expect(isScheduleCommand('  /schedule 备份数据库')).toBe(true);
    expect(isScheduleCommand('/scheduled')).toBe(false);
    expect(isScheduleCommand('/sched 备份')).toBe(false);
  });

  it('extracts the natural-language description', () => {
    expect(parseScheduleCommand('/schedule 每天早上8点跑市场调研并汇报')).toEqual({
      description: '每天早上8点跑市场调研并汇报',
    });
  });

  it('keeps an empty description empty so the submit layer can show usage', () => {
    expect(parseScheduleCommand('/schedule')).toEqual({ description: '' });
    expect(parseScheduleCommand('/schedule   ')).toEqual({ description: '' });
  });

  it('returns null for non-schedule input', () => {
    expect(parseScheduleCommand('/loop 巡检')).toBeNull();
  });
});
