// @vitest-environment jsdom
// ============================================================================
// PermissionGrantList 授权时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// grantedOn/expiresOn 模板里的 {date} 改走 utils/formatDateTime(value, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// ============================================================================
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
    off: vi.fn(),
  },
}));

import PermissionGrantList from '../../../src/renderer/components/features/settings/tabs/PermissionGrantList';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const GRANTED_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const EXPIRES_AT = new Date(2026, 10, 9, 17, 30, 0).getTime(); // 2026-11-09 17:30
const ZH = '2026/11/09 16:05';
const ZH_EXPIRES = '2026/11/09 17:30';
const EN = '11/9/2026, 4:05:00 PM';
const EN_EXPIRES = '11/9/2026, 5:30:00 PM';

function grantsPayload() {
  return [
    { id: 'grant-1', kind: 'app' as const, label: '应用 A', source: 'user', grantedAt: GRANTED_AT, expiresAt: EXPIRES_AT },
    { id: 'grant-2', kind: 'tool-session' as const, label: '工具 B', source: 'user', grantedAt: GRANTED_AT, expiresAt: null },
  ];
}

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockResolvedValue(grantsPayload());
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('PermissionGrantList 授权/有效期时间（跟随 UI language）', () => {
  it('zh UI：授权于/有效期至为 24 小时制带年份，无 AM/PM', async () => {
    const { container } = render(<PermissionGrantList />);
    // 行内 meta 用 {' · '} 分隔（多文本节点），断言走容器 textContent
    await waitFor(() => {
      expect(container.textContent).toContain(`授权于 ${ZH}`);
    });
    expect(container.textContent).toContain(`有效期至 ${ZH_EXPIRES}`);
    expect(container.textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    const { container } = render(<PermissionGrantList />);
    await waitFor(() => {
      expect(container.textContent).toContain(`Granted ${EN}`);
    });
    expect(container.textContent).toContain(`Valid until ${EN_EXPIRES}`);
    expect(container.textContent).not.toContain('16:05');
  });
});
