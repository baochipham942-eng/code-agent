// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAILED_AUDIO_RETENTION_MS } from '../../../src/shared/constants/desktopAudio';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const retentionHours = Math.round(FAILED_AUDIO_RETENTION_MS / (60 * 60 * 1000));

const services = vi.hoisted(() => ({
  getAudioCaptureStatus: vi.fn(),
  clearAudioRecordings: vi.fn(),
  getNativeDesktopCollectorStatus: vi.fn(async () => ({ running: false })),
  listRecentNativeDesktopEvents: vi.fn(async () => []),
  listAudioSegments: vi.fn(async () => []),
  startNativeDesktopCollector: vi.fn(),
  stopNativeDesktopCollector: vi.fn(),
  startAudioCapture: vi.fn(),
  stopAudioCapture: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  getAudioCaptureStatus: () => services.getAudioCaptureStatus(),
  clearAudioRecordings: () => services.clearAudioRecordings(),
  getNativeDesktopCollectorStatus: () => services.getNativeDesktopCollectorStatus(),
  listRecentNativeDesktopEvents: () => services.listRecentNativeDesktopEvents(),
  listAudioSegments: () => services.listAudioSegments(),
  startNativeDesktopCollector: () => services.startNativeDesktopCollector(),
  stopNativeDesktopCollector: () => services.stopNativeDesktopCollector(),
  startAudioCapture: () => services.startAudioCapture(),
  stopAudioCapture: () => services.stopAudioCapture(),
}));

import { NativeDesktopSection } from '../../../src/renderer/components/features/settings/sections/NativeDesktopSection';

function status(failedTotal: number, lastError?: string) {
  return {
    capturing: false,
    captureMode: 'microphone' as const,
    vadReady: false,
    soxAvailable: true,
    systemAudioAvailable: false,
    asrEngine: 'none',
    powerMode: 'full',
    totalSegments: 0,
    audioDir: '/tmp/audio-retention',
    queueLength: 0,
    retention: {
      lastSweepAt: null,
      deletedTotal: 0,
      failedTotal,
      lastError,
      fileCount: 2,
      bytes: 18,
    },
  };
}

describe('NativeDesktopSection audio retention', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the retention rule from the shared duration, in zh and en', () => {
    expect(zh.settings.nativeDesktop.audioRetention.rule).toContain('{hours}');
    expect(zh.settings.nativeDesktop.audioRetention.rule).not.toContain('24');
    expect(zh.settings.nativeDesktop.audioRetention.clear).toBe('清空录音');
    expect(en.settings.nativeDesktop.audioRetention.rule).toContain('{hours}');
    expect(en.settings.nativeDesktop.audioRetention.rule).not.toContain('24');
    expect(en.settings.nativeDesktop.audioRetention.clear).toBe('Clear recordings');
    expect(en.settings.nativeDesktop.audioRetention.failed).toContain('{count}');
    expect(en.settings.nativeDesktop.audioRetention.failed).toContain('{error}');
  });

  it('opens a confirm dialog and calls clear only from confirm', async () => {
    services.getAudioCaptureStatus.mockResolvedValue(status(0));
    services.clearAudioRecordings.mockResolvedValue({ deleted: 2, freedBytes: 18, failed: 0 });
    render(React.createElement(NativeDesktopSection));

    expect(await screen.findByText(new RegExp(`保留 ${retentionHours} 小时`))).toBeTruthy();
    expect(screen.queryByText(/清理失败/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清空录音' }));
    expect(await screen.findByRole('dialog', { name: '清空录音' })).toBeTruthy();
    expect(screen.getByText(/将删除 2 个文件，释放 18 字节/)).toBeTruthy();
    expect(screen.getByText(/转写文字会保留/)).toBeTruthy();
    expect(services.clearAudioRecordings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(services.clearAudioRecordings).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清空录音' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认清空' }));
    await waitFor(() => expect(services.clearAudioRecordings).toHaveBeenCalledOnce());
    expect(await screen.findByText('已删除 2 个文件，释放 18 字节。')).toBeTruthy();
  });

  it('disables clear while the deletion is still running', async () => {
    services.getAudioCaptureStatus.mockResolvedValue(status(0));
    let finish: (value: { deleted: number; freedBytes: number; failed: number }) => void = () => {};
    services.clearAudioRecordings.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    render(React.createElement(NativeDesktopSection));
    fireEvent.click(await screen.findByRole('button', { name: '清空录音' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认清空' }));
    await waitFor(() => {
      const button = screen.getByRole('button', { name: '清空录音' });
      expect(button instanceof HTMLButtonElement && button.disabled).toBe(true);
    });
    finish({ deleted: 1, freedBytes: 4, failed: 0 });
    await waitFor(() => {
      const button = screen.getByRole('button', { name: '清空录音' });
      expect(button instanceof HTMLButtonElement && button.disabled).toBe(false);
    });
  });

  it('shows the cleanup failure line only when failedTotal is above zero', async () => {
    services.getAudioCaptureStatus.mockResolvedValue(status(0));
    const view = render(React.createElement(NativeDesktopSection));
    expect(await screen.findByRole('button', { name: '清空录音' })).toBeTruthy();
    expect(screen.queryByText(/清理失败/)).toBeNull();

    cleanup();
    view.unmount();
    services.getAudioCaptureStatus.mockResolvedValue(status(3, 'not a regular file'));
    render(React.createElement(NativeDesktopSection));
    expect(await screen.findByText('清理失败 3 次，最后一条错误：not a regular file')).toBeTruthy();
  });
});
