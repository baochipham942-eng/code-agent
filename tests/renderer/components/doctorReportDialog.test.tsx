// @vitest-environment jsdom
// ============================================================================
// DoctorReportDialog 渲染测试：mock 一份含 pass/warn/fail 的报告，
// 断言分组、状态徽标、fix 修复按钮、单类重检按钮出现。
// ============================================================================

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DoctorReportDialog } from '../../../src/renderer/components/features/settings/DoctorReportDialog';
import { useDoctorStore } from '../../../src/renderer/stores/doctorStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { DoctorReport } from '../../../src/renderer/types/doctor';

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

describe('DoctorReportDialog', () => {
  beforeEach(() => {
    useAppStore.setState({ language: 'en' });
    useDoctorStore.setState({
      report: MOCK_REPORT,
      isDialogOpen: true,
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
      isDialogOpen: false,
      isRunning: false,
      runningCategory: null,
      lastError: null,
      startupCheckDone: false,
    });
  });

  it('按 category 分组展示，且状态徽标齐全', () => {
    render(<DoctorReportDialog />);
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
    render(<DoctorReportDialog />);
    const providerFix = screen.getByTestId('doctor-fix-open-provider-settings');
    expect(providerFix.textContent).toContain('Set up AI service');
    const proxyFix = screen.getByTestId('doctor-fix-open-proxy-help');
    expect(proxyFix.textContent).toContain('View proxy settings');
    // mcp 那项 fail 但没有 fix code → 没有修复按钮
    expect(screen.queryByTestId('doctor-fix-open-mcp-settings')).toBeNull();
  });

  it('每个分组有「重新检查这一项」按钮', () => {
    render(<DoctorReportDialog />);
    expect(screen.getByTestId('doctor-recheck-environment')).toBeTruthy();
    expect(screen.getByTestId('doctor-recheck-provider_health')).toBeTruthy();
    expect(screen.getByTestId('doctor-recheck-network')).toBeTruthy();
    expect(screen.getByTestId('doctor-recheck-mcp')).toBeTruthy();
  });

  it('弹层关闭时不渲染内容', () => {
    useDoctorStore.setState({ isDialogOpen: false });
    const { container } = render(<DoctorReportDialog />);
    expect(container.innerHTML).toBe('');
  });
});
