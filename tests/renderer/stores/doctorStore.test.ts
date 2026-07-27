// ============================================================================
// doctorStore 测试
// - 徽标逻辑：有 fail 显示、全绿/无报告不显示
// - 单类重检合并：替换该分类 items 并重算 summary
// - 启动静默快检：skipNetwork、失败静默、只跑一次
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { useDoctorStore } from '../../../src/renderer/stores/doctorStore';
import {
  hasDoctorFailures,
  mergeDoctorCategoryReport,
  type DoctorReport,
} from '../../../src/renderer/types/doctor';

const invokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: () => () => {},
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
  },
}));

function makeReport(overrides?: Partial<DoctorReport>): DoctorReport {
  return {
    timestamp: 1700000000000,
    durationMs: 1000,
    items: [],
    summary: { pass: 0, warn: 0, fail: 0, skip: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  invokeDomainMock.mockReset();
  useDoctorStore.setState({
    report: null,
    isRunning: false,
    runningCategory: null,
    isDialogOpen: false,
    lastError: null,
    startupCheckDone: false,
  });
});

describe('hasDoctorFailures（徽标逻辑）', () => {
  it('有 fail 项 → 显示徽标', () => {
    expect(hasDoctorFailures(makeReport({ summary: { pass: 5, warn: 0, fail: 2, skip: 0 } }))).toBe(true);
  });

  it('全绿 → 不显示', () => {
    expect(hasDoctorFailures(makeReport({ summary: { pass: 9, warn: 0, fail: 0, skip: 0 } }))).toBe(false);
  });

  it('只有 warn → 不显示（不打扰原则）', () => {
    expect(hasDoctorFailures(makeReport({ summary: { pass: 5, warn: 3, fail: 0, skip: 1 } }))).toBe(false);
  });

  it('无报告 → 不显示', () => {
    expect(hasDoctorFailures(null)).toBe(false);
    expect(hasDoctorFailures(undefined)).toBe(false);
  });
});

describe('mergeDoctorCategoryReport（单类重检合并）', () => {
  it('替换该分类的旧 items 并重算 summary', () => {
    const base = makeReport({
      items: [
        { category: 'environment', name: 'Node.js version', status: 'pass', message: 'v20' },
        { category: 'network', name: 'API connectivity', status: 'fail', message: 'down' },
      ],
      summary: { pass: 1, warn: 0, fail: 1, skip: 0 },
    });
    const partial = makeReport({
      timestamp: 1700000001000,
      durationMs: 300,
      items: [{ category: 'network', name: 'API connectivity', status: 'pass', message: 'ok' }],
      summary: { pass: 1, warn: 0, fail: 0, skip: 0 },
    });
    const merged = mergeDoctorCategoryReport(base, 'network', partial);
    expect(merged.items).toHaveLength(2);
    expect(merged.items.find((i) => i.category === 'network')?.status).toBe('pass');
    expect(merged.summary).toEqual({ pass: 2, warn: 0, fail: 0, skip: 0 });
    expect(merged.timestamp).toBe(1700000001000);
  });

  it('无既有报告时单类结果也能独立成报告', () => {
    const partial = makeReport({
      items: [{ category: 'hooks', name: 'Hooks config', status: 'warn', message: 'x' }],
      summary: { pass: 0, warn: 1, fail: 0, skip: 0 },
    });
    const merged = mergeDoctorCategoryReport(null, 'hooks', partial);
    expect(merged.items).toHaveLength(1);
    expect(merged.summary.warn).toBe(1);
  });
});

describe('runSilentStartupCheck（启动静默快检）', () => {
  it('带 skipNetwork 调 run_doctor，结果存入 store', async () => {
    const report = makeReport({ summary: { pass: 8, warn: 0, fail: 1, skip: 0 } });
    invokeDomainMock.mockResolvedValue(report);
    await useDoctorStore.getState().runSilentStartupCheck();
    expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.PROVIDER, 'run_doctor', {
      skipNetwork: true,
    });
    expect(useDoctorStore.getState().report).toEqual(report);
    expect(useDoctorStore.getState().startupCheckDone).toBe(true);
  });

  it('失败静默：不写 report、不记 lastError', async () => {
    invokeDomainMock.mockRejectedValue(new Error('boom'));
    await useDoctorStore.getState().runSilentStartupCheck();
    expect(useDoctorStore.getState().report).toBeNull();
    expect(useDoctorStore.getState().lastError).toBeNull();
    expect(useDoctorStore.getState().startupCheckDone).toBe(true);
  });

  it('只跑一次', async () => {
    invokeDomainMock.mockResolvedValue(makeReport());
    await useDoctorStore.getState().runSilentStartupCheck();
    await useDoctorStore.getState().runSilentStartupCheck();
    expect(invokeDomainMock).toHaveBeenCalledTimes(1);
  });

  it('已有报告时不用快检结果覆盖', async () => {
    const manual = makeReport({ summary: { pass: 1, warn: 0, fail: 0, skip: 0 } });
    useDoctorStore.setState({ report: manual });
    invokeDomainMock.mockResolvedValue(makeReport({ summary: { pass: 0, warn: 0, fail: 3, skip: 0 } }));
    await useDoctorStore.getState().runSilentStartupCheck();
    expect(useDoctorStore.getState().report).toEqual(manual);
  });
});

describe('openDialog（弹层打开复用/自动跑）', () => {
  it('无报告时自动跑全量', async () => {
    invokeDomainMock.mockResolvedValue(makeReport());
    useDoctorStore.getState().openDialog();
    expect(useDoctorStore.getState().isDialogOpen).toBe(true);
    await vi.waitFor(() => expect(invokeDomainMock).toHaveBeenCalled());
  });

  it('已有报告时复用，不重复跑', () => {
    useDoctorStore.setState({ report: makeReport() });
    useDoctorStore.getState().openDialog();
    expect(useDoctorStore.getState().isDialogOpen).toBe(true);
    expect(invokeDomainMock).not.toHaveBeenCalled();
  });
});

describe('runCategory（单类重检）', () => {
  it('带 category 调用并合并结果', async () => {
    useDoctorStore.setState({
      report: makeReport({
        items: [{ category: 'mcp', name: 'MCP servers', status: 'fail', message: 'x' }],
        summary: { pass: 0, warn: 0, fail: 1, skip: 0 },
      }),
    });
    invokeDomainMock.mockResolvedValue(
      makeReport({
        items: [{ category: 'mcp', name: 'MCP servers', status: 'pass', message: 'ok' }],
        summary: { pass: 1, warn: 0, fail: 0, skip: 0 },
      }),
    );
    await useDoctorStore.getState().runCategory('mcp');
    expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.PROVIDER, 'run_doctor', {
      category: 'mcp',
    });
    expect(useDoctorStore.getState().report?.summary).toEqual({ pass: 1, warn: 0, fail: 0, skip: 0 });
  });
});
