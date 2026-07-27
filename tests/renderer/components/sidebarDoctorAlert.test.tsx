// @vitest-environment jsdom
// ============================================================================
// 侧栏诊断徽标逻辑：有 fail 显示小红点行、全绿/无报告不渲染任何东西。
// ============================================================================

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SidebarDoctorAlert } from '../../../src/renderer/components/features/sidebar/SidebarDoctorAlert';
import { useDoctorStore } from '../../../src/renderer/stores/doctorStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { hasDoctorFailures } from '../../../src/renderer/types/doctor';
import type { DoctorReport } from '../../../src/renderer/types/doctor';

function makeReport(fail: number, warn = 0): DoctorReport {
  return {
    timestamp: Date.now(),
    durationMs: 100,
    items: [],
    summary: { pass: 3, warn, fail, skip: 0 },
  };
}

describe('SidebarDoctorAlert 徽标逻辑', () => {
  beforeEach(() => {
    useAppStore.setState({ language: 'en' });
  });

  afterEach(() => {
    cleanup();
    useDoctorStore.setState({ report: null });
    useAppStore.setState({ showSettings: false, settingsInitialTab: null });
  });

  it('hasDoctorFailures：有 fail 为 true，全绿/仅 warn/空报告为 false', () => {
    expect(hasDoctorFailures(makeReport(2))).toBe(true);
    expect(hasDoctorFailures(makeReport(0))).toBe(false);
    expect(hasDoctorFailures(makeReport(0, 2))).toBe(false);
    expect(hasDoctorFailures(null)).toBe(false);
    expect(hasDoctorFailures(undefined)).toBe(false);
  });

  it('报告有 fail 项时显示徽标行与红点', () => {
    useDoctorStore.setState({ report: makeReport(2) });
    render(<SidebarDoctorAlert />);
    expect(screen.getByTestId('sidebar-doctor-alert')).toBeTruthy();
    expect(screen.getByTestId('sidebar-doctor-alert-dot')).toBeTruthy();
    expect(screen.getByText('2 checks failing')).toBeTruthy();
  });

  it('全绿报告不渲染任何东西（不打扰原则）', () => {
    useDoctorStore.setState({ report: makeReport(0) });
    const { container } = render(<SidebarDoctorAlert />);
    expect(screen.queryByTestId('sidebar-doctor-alert')).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('无报告（静默快检未跑/失败）不渲染', () => {
    useDoctorStore.setState({ report: null });
    const { container } = render(<SidebarDoctorAlert />);
    expect(screen.queryByTestId('sidebar-doctor-alert')).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('点击徽标深链打开设置并定位到「诊断」页', () => {
    useDoctorStore.setState({ report: makeReport(1), startupCheckDone: true });
    render(<SidebarDoctorAlert />);
    screen.getByTestId('sidebar-doctor-alert').click();
    expect(useAppStore.getState().showSettings).toBe(true);
    expect(useAppStore.getState().settingsInitialTab).toBe('doctor');
  });
});
