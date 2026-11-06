// ============================================================================
// PluginsSettings formatDate 时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1）：
// 插件安装时间 / marketplace 更新时间改走 utils/formatDateTime(value, lang)，
// 纯 helper 加第三个 lang 参数（调用方 PluginsSettings 传 UI language）；
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { formatDate } from '../../../src/renderer/components/features/settings/tabs/PluginsSettings.helpers';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

// 本地时区构造（无时区后缀的 ISO 串按本地时区解析），任何 TZ 下字段都是构造值本身。
const INSTALLED_AT = '2026-11-09T16:05:00';
const UPDATED_AT = '2026-11-09T17:30:00';

describe('PluginsSettings formatDate（跟随 UI language）', () => {
  it('zh：24 小时制带年份，无 AM/PM', () => {
    expect(formatDate(INSTALLED_AT, zh.settings.plugins.date, 'zh')).toBe('2026/11/09 16:05');
    expect(formatDate(UPDATED_AT, zh.settings.plugins.date, 'zh')).toBe('2026/11/09 17:30');
  });

  it('en：维持 en-US 原样（英文 UI 行为不变）', () => {
    expect(formatDate(INSTALLED_AT, en.settings.plugins.date, 'en')).toBe('11/9/2026, 4:05:00 PM');
    expect(formatDate(UPDATED_AT, en.settings.plugins.date, 'en')).toBe('11/9/2026, 5:30:00 PM');
  });

  it('缺值/非法值维持原口径（labels.unknown / 原样返回）', () => {
    expect(formatDate(undefined, zh.settings.plugins.date, 'zh')).toBe('未知');
    expect(formatDate(undefined, en.settings.plugins.date, 'en')).toBe('Unknown');
    expect(formatDate('not-a-date', zh.settings.plugins.date, 'zh')).toBe('not-a-date');
  });
});
