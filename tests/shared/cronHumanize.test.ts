// ============================================================================
// cron/every 调度 → 人话文案（shared 纯函数，host 自动化记录与 renderer 通知共用）。
// humanize 覆盖面经公共入口 formatCronExpressionLabel 验证（翻译不了的形态
// 落「自定义时间 · 原文」回退），不直接 import 模块内构件。
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  formatCronExpressionLabel,
  humanizeEverySchedule,
} from '../../src/shared/cronHumanize';

describe('humanize 覆盖面（经 formatCronExpressionLabel 验证）', () => {
  it('每天定点：30 8 * * *', () => {
    expect(formatCronExpressionLabel('30 8 * * *', undefined, 'zh')).toBe('每天 08:30');
    expect(formatCronExpressionLabel('30 8 * * *', undefined, 'en')).toBe('Daily at 08:30');
  });

  it('工作日定点：0 15 * * 1-5', () => {
    expect(formatCronExpressionLabel('0 15 * * 1-5', undefined, 'zh')).toBe('工作日 15:00');
    expect(formatCronExpressionLabel('0 15 * * 1-5', undefined, 'en')).toBe('Weekdays at 15:00');
  });

  it('每周单天：30 17 * * 4', () => {
    expect(formatCronExpressionLabel('30 17 * * 4', undefined, 'zh')).toBe('每周四 17:30');
    expect(formatCronExpressionLabel('30 17 * * 4', undefined, 'en')).toBe('Weekly on Thursday at 17:30');
    expect(formatCronExpressionLabel('0 9 * * 0', undefined, 'zh')).toBe('每周日 09:00');
  });

  it('每月 D 号：0 9 1 * *', () => {
    expect(formatCronExpressionLabel('0 9 1 * *', undefined, 'zh')).toBe('每月 1 号 09:00');
    expect(formatCronExpressionLabel('0 9 1 * *', undefined, 'en')).toBe('Monthly on day 1 at 09:00');
    expect(formatCronExpressionLabel('30 17 15 * *', undefined, 'zh')).toBe('每月 15 号 17:30');
    expect(formatCronExpressionLabel('30 17 15 * *', undefined, 'en')).toBe('Monthly on day 15 at 17:30');
    expect(formatCronExpressionLabel('0 9 31 * *', undefined, 'zh')).toBe('每月 31 号 09:00');
    // 前导零归一
    expect(formatCronExpressionLabel('0 9 05 * *', undefined, 'zh')).toBe('每月 5 号 09:00');
  });

  it('每 N 分钟：*/15 * * * *', () => {
    expect(formatCronExpressionLabel('*/15 * * * *', undefined, 'zh')).toBe('每 15 分钟');
    expect(formatCronExpressionLabel('*/15 * * * *', undefined, 'en')).toBe('Every 15 minutes');
    expect(formatCronExpressionLabel('*/1 * * * *', undefined, 'en')).toBe('Every minute');
  });

  it('每 N 小时：0 */2 * * *', () => {
    expect(formatCronExpressionLabel('0 */2 * * *', undefined, 'zh')).toBe('每 2 小时');
    expect(formatCronExpressionLabel('0 */2 * * *', undefined, 'en')).toBe('Every 2 hours');
    expect(formatCronExpressionLabel('30 */1 * * *', undefined, 'en')).toBe('Every hour');
  });

  it('覆盖不了的形态走「自定义时间」回退，绝不瞎猜', () => {
    // 多天列表、带日/月段、范围小时、6 段表达式、乱码
    expect(formatCronExpressionLabel('0 9 * * 1,3,5', undefined, 'zh')).toBe('自定义时间 · 0 9 * * 1,3,5');
    expect(formatCronExpressionLabel('0 9 * 6 *', undefined, 'zh')).toBe('自定义时间 · 0 9 * 6 *');
    expect(formatCronExpressionLabel('0 9-17 * * *', undefined, 'zh')).toBe('自定义时间 · 0 9-17 * * *');
    expect(formatCronExpressionLabel('0 9 * * * *', undefined, 'zh')).toBe('自定义时间 · 0 9 * * * *');
    expect(formatCronExpressionLabel('not a cron', undefined, 'zh')).toBe('自定义时间 · not a cron');
    // 超界
    expect(formatCronExpressionLabel('99 8 * * *', undefined, 'zh')).toBe('自定义时间 · 99 8 * * *');
    expect(formatCronExpressionLabel('0 25 * * *', undefined, 'zh')).toBe('自定义时间 · 0 25 * * *');
    expect(formatCronExpressionLabel('*/0 * * * *', undefined, 'zh')).toBe('自定义时间 · */0 * * * *');
    // 每月 D 号的边界：0 / 32 / 乱码 / dayOfWeek 同时受限（cron 语义变 OR，不猜）
    expect(formatCronExpressionLabel('0 9 0 * *', undefined, 'zh')).toBe('自定义时间 · 0 9 0 * *');
    expect(formatCronExpressionLabel('0 9 32 * *', undefined, 'zh')).toBe('自定义时间 · 0 9 32 * *');
    expect(formatCronExpressionLabel('0 9 1,15 * *', undefined, 'zh')).toBe('自定义时间 · 0 9 1,15 * *');
    expect(formatCronExpressionLabel('0 9 1 * 1', undefined, 'zh')).toBe('自定义时间 · 0 9 1 * 1');
    // 步进形态带日/周限制不翻译
    expect(formatCronExpressionLabel('*/15 * 2 * *', undefined, 'zh')).toBe('自定义时间 · */15 * 2 * *');
    expect(formatCronExpressionLabel('*/15 * * * 1-5', undefined, 'zh')).toBe('自定义时间 · */15 * * * 1-5');
  });

  it('容忍首尾空白与连续空格', () => {
    expect(formatCronExpressionLabel('  30   8  *  *  * ', undefined, 'zh')).toBe('每天 08:30');
  });
});

describe('humanizeEverySchedule', () => {
  it('zh：每 N <中文单位>', () => {
    expect(humanizeEverySchedule(30, 'minutes', 'zh')).toBe('每 30 分钟');
    expect(humanizeEverySchedule(2, 'hours', 'zh')).toBe('每 2 小时');
    expect(humanizeEverySchedule(1, 'days', 'zh')).toBe('每 1 天');
    expect(humanizeEverySchedule(45, 'seconds', 'zh')).toBe('每 45 秒');
  });

  it('en：单复数', () => {
    expect(humanizeEverySchedule(1, 'hours', 'en')).toBe('Every hour');
    expect(humanizeEverySchedule(3, 'hours', 'en')).toBe('Every 3 hours');
    expect(humanizeEverySchedule(1, 'days', 'en')).toBe('Every day');
  });

  it('未知 unit 原样带上', () => {
    expect(humanizeEverySchedule(3, 'weeks', 'zh')).toBe('每 3 weeks');
  });
});

describe('formatCronExpressionLabel', () => {
  it('每天定点（FB-326 反例）：17 8 * * * → 每天 08:17，不带时区后缀', () => {
    expect(formatCronExpressionLabel('17 8 * * *', 'Asia/Shanghai', 'zh')).toBe('每天 08:17');
    expect(formatCronExpressionLabel('17 8 * * *', 'Asia/Shanghai', 'en')).toBe('Daily at 08:17');
    expect(formatCronExpressionLabel('17 8 * * *', undefined, 'zh')).toBe('每天 08:17');
  });

  it('常见形态各类都翻成人话', () => {
    expect(formatCronExpressionLabel('0 9 * * 1-5', 'Asia/Shanghai', 'zh')).toBe('工作日 09:00');
    expect(formatCronExpressionLabel('0 9 * * 1-5', 'Asia/Shanghai', 'en')).toBe('Weekdays at 09:00');
    expect(formatCronExpressionLabel('30 17 * * 4', undefined, 'zh')).toBe('每周四 17:30');
    expect(formatCronExpressionLabel('30 17 * * 4', undefined, 'en')).toBe('Weekly on Thursday at 17:30');
    expect(formatCronExpressionLabel('0 9 1 * *', 'Asia/Shanghai', 'zh')).toBe('每月 1 号 09:00');
    expect(formatCronExpressionLabel('0 9 1 * *', 'Asia/Shanghai', 'en')).toBe('Monthly on day 1 at 09:00');
    expect(formatCronExpressionLabel('*/15 * * * *', undefined, 'zh')).toBe('每 15 分钟');
    expect(formatCronExpressionLabel('*/15 * * * *', undefined, 'en')).toBe('Every 15 minutes');
    expect(formatCronExpressionLabel('0 */2 * * *', 'UTC', 'zh')).toBe('每 2 小时');
    expect(formatCronExpressionLabel('0 */2 * * *', 'UTC', 'en')).toBe('Every 2 hours');
  });

  it('复杂表达式回退「自定义时间 · 原文[ · 时区]」，绝不瞎猜', () => {
    expect(formatCronExpressionLabel('0 9 1,15 * *', 'Asia/Shanghai', 'zh'))
      .toBe('自定义时间 · 0 9 1,15 * * · Asia/Shanghai');
    expect(formatCronExpressionLabel('0 9 1,15 * *', 'Asia/Shanghai', 'en'))
      .toBe('Custom schedule · 0 9 1,15 * * · Asia/Shanghai');
    expect(formatCronExpressionLabel('0 9 * * 1,3,5', undefined, 'zh')).toBe('自定义时间 · 0 9 * * 1,3,5');
    expect(formatCronExpressionLabel('0 9 * * 1,3,5', undefined, 'en')).toBe('Custom schedule · 0 9 * * 1,3,5');
    expect(formatCronExpressionLabel('0 9 * 6 *', 'UTC', 'zh')).toBe('自定义时间 · 0 9 * 6 * · UTC');
    expect(formatCronExpressionLabel('0 9 * * * *', undefined, 'zh')).toBe('自定义时间 · 0 9 * * * *');
  });
});
