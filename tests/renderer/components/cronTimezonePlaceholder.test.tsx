// @vitest-environment jsdom
// ============================================================================
// cron 时区输入框的灰色占位（N-FIX-CRON-TZ-PLACEHOLDER-MANUAL-CWD ①）：
// 空时区存 undefined，host 侧 croner 按本机时区调度，所以占位符必须显示
// 本机真实时区（localCronTimezone），而不是写死 Asia/Shanghai 去骗非上海用户。
// 直接渲染 CronScheduleFields（字段本体组件），把 Intl 时区探针 spy 到固定值断言。
// ============================================================================
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronScheduleFields } from '../../../src/renderer/components/features/cron/CronScheduleFields';

function spyTimezone(timeZone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    locale: 'en-US',
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone,
  });
}

function renderCronFields(): void {
  render(
    <CronScheduleFields
      draft={{
        scheduleType: 'cron',
        atDatetime: '',
        everyInterval: '',
        everyUnit: 'minutes',
        everyStartAt: '',
        everyEndAt: '',
        cronExpression: '0 9 * * *',
        cronTimezone: '',
        runsOn: 'local',
      }}
      setField={() => undefined}
      errors={{}}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('CronScheduleFields 时区占位符', () => {
  it('空时区输入框的灰色占位显示本机真实时区（America/Los_Angeles）', () => {
    spyTimezone('America/Los_Angeles');
    renderCronFields();
    expect(screen.getByPlaceholderText('America/Los_Angeles')).toBeTruthy();
    // 写死上海的老行为必须消失，否则灰字与实际触发时区不一致。
    expect(screen.queryByPlaceholderText('Asia/Shanghai')).toBeNull();
  });

  it('占位符跟随系统时区探针取值，不是烘焙进组件的常量', () => {
    spyTimezone('Europe/Berlin');
    renderCronFields();
    expect(screen.getByPlaceholderText('Europe/Berlin')).toBeTruthy();
  });
});
