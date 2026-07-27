// @vitest-environment jsdom
// ============================================================================
// DoctorSettings 页面渲染测试：mock 一份含 pass/warn/fail 的报告，
// 断言分组、状态徽标、fix 修复按钮、单类重检按钮出现；
// 另断言无报告进页时自动触发一次全量诊断。
// ============================================================================

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { DoctorSettings } from '../../../src/renderer/components/features/settings/tabs/DoctorSettings';
import { useDoctorStore } from '../../../src/renderer/stores/doctorStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { DoctorReport } from '../../../src/renderer/types/doctor';

const invokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: () => () => {},
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
  },
}));

const MOCK_REPORT: DoctorReport = {
  timestamp: 1_720_000_000_000,
  durationMs: 1234,
  items: [
    {
      category: 'environment',
      name: 'Node.js version',
      status: 'pass',
      message: 'Node.js v20.11.0',
    },
    {
      category: 'provider_health',
      name: 'OpenAI',
      status: 'fail',
      message: 'AI 服务的密钥还没配置',
      suggestion: '去设置里补上密钥',
      fix: { code: 'open-provider-settings' },
    },
    {
      category: 'network',
      name: 'API reachability',
      status: 'warn',
      message: '代理连接不稳定',
      fix: { code: 'open-proxy-help' },
    },
    {
      category: 'mcp',
      name: 'filesystem server',
      status: 'fail',
      message: '服务器启动失败',
      // 无 fix：不应出现修复按钮
    },
  ],
  summary: { pass: 1, warn: 1, fail: 2, skip: 0 },
};

describe('DoctorSettings（设置页形态）', () => {
  beforeEach(() => {
    invokeDomainMock.mockReset();
    useAppStore.setState({ language: 'en' });
    useDoctorStore.setState({
      report: MOCK_REPORT,
      isRunning: false,
      runningCategory: null,
      lastError: null,
      startupCheckDone: true,
    });
  });

  afterEach(() => {
    cleanup();
    useDoctorStore.setState({
      report: null,
      isRunning: false,
      runningCategory: null,
      lastError: null,
      startupCheckDone: false,
    });
  });

  it('按 category 分组展示，且状态徽标齐全', () => {
    render(<DoctorSettings />);
    // 分组标题（i18n categoryLabels）
    expect(screen.getByText('Runtime environment')).toBeTruthy();
    expect(screen.getByText('Provider health')).toBeTruthy();
    expect(screen.getByText('Network connection')).toBeTruthy();
    expect(screen.getByText('MCP servers')).toBeTruthy();
    // 状态徽标
    expect(screen.getByText('PASS')).toBeTruthy();
    expect(screen.getAllByText('FAIL')).toHaveLength(2);
    expect(screen.getByText('WARN')).toBeTruthy();
    // 每项一句人话说明
    expect(screen.getByText('AI 服务的密钥还没配置')).toBeTruthy();
  });

  it('fail/warn 且带 fix code 的项显示修复按钮；无 fix 的 fail 项不显示', () => {
    render(<DoctorSettings />);
    const providerFix = screen.getByTestId('doctor-fix-open-provider-settings');
    expect(providerFix.textContent).toContain('Set up AI service');
    const proxyFix = screen.getByTestId('doctor-fix-open-proxy-help');
    expect(proxyFix.textContent).toContain('View proxy settings');
    // mcp 那项 fail 但没有 fix code → 没有修复按钮
    expect(screen.queryByTestId('doctor-fix-open-mcp-settings')).toBeNull();
  });

  it('每个分组有「重新检查这一项」按钮', () => {
    render(<DoctorSettings />);
    expect(screen.getByTestId('doctor-recheck-environment')).toBeTruthy();
    expect(screen.getByTestId('doctor-recheck-provider_health')).toBeTruthy();
    expect(screen.getByTestId('doctor-recheck-network')).toBeTruthy();
    expect(screen.getByTestId('doctor-recheck-mcp')).toBeTruthy();
  });

  it('已有报告时直接复用，进页不重复跑', () => {
    render(<DoctorSettings />);
    expect(invokeDomainMock).not.toHaveBeenCalled();
  });

  it('无报告进页自动跑一次全量诊断', async () => {
    invokeDomainMock.mockResolvedValue(MOCK_REPORT);
    useDoctorStore.setState({ report: null });
    render(<DoctorSettings />);
    await waitFor(() => {
      expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.PROVIDER, 'run_doctor', undefined);
    });
  });
});
