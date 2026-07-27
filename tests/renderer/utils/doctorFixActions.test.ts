// ============================================================================
// Doctor fix code → 动作映射：穷尽断言
// 8 个 code 逐一断言映射到的动作（枚举式）；
// 新增 code 缺映射时 Object.keys 覆盖断言与 Record 类型会一起红。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { DOCTOR_FIX_CODES, type DoctorFixCode } from '../../../src/shared/constants/doctor';
import { AGENT_NEO_HELP_URL } from '../../../src/shared/constants/network';
import { DOCTOR_FIX_ACTIONS } from '../../../src/renderer/utils/doctorFixActions';

describe('DOCTOR_FIX_ACTIONS 映射表', () => {
  it('8 个 fix code 逐一映射到预期动作（枚举式）', () => {
    expect(DOCTOR_FIX_ACTIONS[DOCTOR_FIX_CODES.OPEN_RUNTIME_HELP]).toEqual({
      kind: 'externalLink',
      url: AGENT_NEO_HELP_URL,
    });
    expect(DOCTOR_FIX_ACTIONS[DOCTOR_FIX_CODES.OPEN_DATA_DIRECTORY]).toEqual({
      kind: 'openDataDirectory',
    });
    expect(DOCTOR_FIX_ACTIONS[DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS]).toEqual({
      kind: 'settingsTab',
      tab: 'model',
    });
    expect(DOCTOR_FIX_ACTIONS[DOCTOR_FIX_CODES.OPEN_PROXY_HELP]).toEqual({
      kind: 'externalLink',
      url: AGENT_NEO_HELP_URL,
    });
    expect(DOCTOR_FIX_ACTIONS[DOCTOR_FIX_CODES.OPEN_MCP_SETTINGS]).toEqual({
      kind: 'settingsTab',
      tab: 'mcp',
    });
    expect(DOCTOR_FIX_ACTIONS[DOCTOR_FIX_CODES.OPEN_BROWSER_RELAY_SETTINGS]).toEqual({
      kind: 'settingsTab',
      tab: 'privacy',
    });
    expect(DOCTOR_FIX_ACTIONS[DOCTOR_FIX_CODES.OPEN_HOOKS_SETTINGS]).toEqual({
      kind: 'settingsTab',
      tab: 'hooks',
    });
    expect(DOCTOR_FIX_ACTIONS[DOCTOR_FIX_CODES.OPEN_UPDATE_SETTINGS]).toEqual({
      kind: 'settingsTab',
      tab: 'update',
    });
  });

  it('映射表覆盖全部 DoctorFixCode（无遗漏、无多余）', () => {
    const allCodes = Object.values(DOCTOR_FIX_CODES) as DoctorFixCode[];
    // 后端契约固定 8 个 code；新增 code 时这里先红，提醒补映射
    expect(allCodes).toHaveLength(8);
    expect(Object.keys(DOCTOR_FIX_ACTIONS).sort()).toEqual([...allCodes].sort());
  });
});
