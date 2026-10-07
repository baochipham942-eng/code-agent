// ============================================================================
// daemon 设置默认值（ADR-083 ⑤）：登录自启默认关（拍板记录 2）。
// 只测设置位——LaunchAgent / 登录项的写入不在本刀范围（证据档附 grep 佐证）。
// ============================================================================

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../../../../src/host/services/core/configDefaults';

describe('daemon 设置（ADR-083 ⑤）', () => {
  it('launchAtLogin 默认 false（登录自启默认关）', () => {
    expect(DEFAULT_SETTINGS.daemon?.launchAtLogin).toBe(false);
  });

  it('AppSettings.daemon 是可选组（存量配置无该键时仍合法）', () => {
    // 只验证类型层面的可选性在运行时的口径：默认配置带全组，用户配置可整组缺省。
    expect(DEFAULT_SETTINGS.daemon).toEqual({ launchAtLogin: false });
  });
});
