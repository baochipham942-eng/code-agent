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

const facade = vi.hoisted(() => ({
  openNativePath: vi.fn(async () => undefined),
}));

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => (i18nState.language === 'en'
    ? { t: en, language: 'en' }
    : { t: zh, language: 'zh' }),
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

vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  openNativePath: facade.openNativePath,
}));

import { NativeDesktopSection } from '../../../src/renderer/components/features/settings/sections/NativeDesktopSection';

const AUDIO_DIR = '/tmp/audio-retention';
const EACCES_RAW = `EACCES: permission denied, unlink '${AUDIO_DIR}/seg-1.wav'`;

function status(failedTotal: number, lastError?: string, fileCount = 2) {
  return {
    capturing: false,
    captureMode: 'microphone' as const,
    vadReady: false,
    soxAvailable: true,
    systemAudioAvailable: false,
    asrEngine: 'none',
    powerMode: 'full',
    totalSegments: 0,
    audioDir: AUDIO_DIR,
    queueLength: 0,
    retention: {
      lastSweepAt: null,
      deletedTotal: 0,
      failedTotal,
      lastError,
      fileCount,
      bytes: 18,
    },
  };
}

/** 主文案元素（失败行里的 <span>），用于断言"原始错误与路径不进主文案" */
async function findFailureMain(re: RegExp) {
  return await screen.findByText(re);
}

describe('NativeDesktopSection audio retention', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    i18nState.language = 'zh';
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
    // 失败文案按错误分类，主文案模板不含 {error}（原始错误只进折叠 details）
    expect(zh.settings.nativeDesktop.audioRetention.failedPermission).toContain('{count}');
    expect(zh.settings.nativeDesktop.audioRetention.failedPermission).not.toContain('{error}');
    expect(zh.settings.nativeDesktop.audioRetention.failedOther).toContain('{count}');
    expect(zh.settings.nativeDesktop.audioRetention.failedOther).not.toContain('{error}');
    expect(en.settings.nativeDesktop.audioRetention.failedPermission).toContain('{count}');
    expect(en.settings.nativeDesktop.audioRetention.failedOther).toContain('{count}');
    // zh/en 键集一致
    expect(Object.keys(zh.settings.nativeDesktop.audioRetention).sort())
      .toEqual(Object.keys(en.settings.nativeDesktop.audioRetention).sort());
  });

  it('opens a confirm dialog and calls clear only from confirm', async () => {
    services.getAudioCaptureStatus.mockResolvedValue(status(0));
    services.clearAudioRecordings.mockResolvedValue({ deleted: 2, freedBytes: 18, failed: 0 });
    render(React.createElement(NativeDesktopSection));

    expect(await screen.findByText(new RegExp(`保留 ${retentionHours} 小时`))).toBeTruthy();
    expect(screen.queryByText(/个录音删不掉/)).toBeNull();

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
    expect(screen.queryByText(/个录音删不掉/)).toBeNull();

    cleanup();
    view.unmount();
    services.getAudioCaptureStatus.mockResolvedValue(status(3, 'not a regular file'));
    render(React.createElement(NativeDesktopSection));
    // 其他类：通用句 + N，不带裸错误
    const main = await findFailureMain(/个录音删不掉/);
    expect(main.textContent).toBe('有 3 个录音删不掉，这次清理没有完成。可稍后重试');
    expect(main.textContent).not.toContain('not a regular file');
  });

  it('keeps the failure line when only a stuck non-regular path remains (fileCount 0)', async () => {
    // 评审返修场景：录音目录里卡着一个名为 *.wav 的目录/符号链接（host 夹具
    // audio_blocked.wav 即此形状），clear/sweep 每轮失败、failedTotal 持续累计，
    // 但 countClearableWavs 只统计普通文件，fileCount 结构性为 0——
    // 失败行不能被 fileCount 门藏死，否则用户既看不到失败也拿不到重试入口
    services.getAudioCaptureStatus.mockResolvedValue(status(2, 'not a regular file', 0));
    render(React.createElement(NativeDesktopSection));

    const main = await findFailureMain(/个录音删不掉/);
    expect(main.textContent).toBe('有 2 个录音删不掉，这次清理没有完成。可稍后重试');
    expect(main.textContent).not.toContain('not a regular file');
    // 两个出口仍然在，重试走确认框而不是直接删
    expect(screen.getByRole('button', { name: '打开文件夹' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('dialog', { name: '清空录音' })).toBeTruthy();
    expect(services.clearAudioRecordings).not.toHaveBeenCalled();
  });

  it('drops the failure line after a successful retry clears everything', async () => {
    // 验收场景回放：重试成功后回执可见，失败行与重试按钮消失。
    // 重试成功后的刷新状态是 failedTotal=0：host 侧零失败的 clear 会清账
    // （audioRetention.ts resetFailures，host 测试单独钉死），renderer 只看账
    services.getAudioCaptureStatus.mockResolvedValueOnce(status(3, EACCES_RAW));
    services.getAudioCaptureStatus.mockResolvedValueOnce(status(3, EACCES_RAW));
    services.getAudioCaptureStatus.mockResolvedValue(status(0, undefined, 0));
    services.clearAudioRecordings.mockResolvedValue({ deleted: 3, freedBytes: 27, failed: 0 });
    render(React.createElement(NativeDesktopSection));

    expect(await findFailureMain(/个录音删不掉/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认清空' }));
    await waitFor(() => expect(services.clearAudioRecordings).toHaveBeenCalledOnce());
    expect(await screen.findByText('已删除 3 个文件，释放 27 字节。')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/个录音删不掉/)).toBeNull());
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.queryByText(EACCES_RAW)).toBeNull();
  });

  it('classifies EACCES as permission and keeps raw error out of the main line', async () => {
    services.getAudioCaptureStatus.mockResolvedValue(status(2, EACCES_RAW));
    render(React.createElement(NativeDesktopSection));

    const main = await findFailureMain(/个录音删不掉/);
    expect(main.textContent).toBe('有 2 个录音删不掉：没有删除权限。可在访达里检查录音文件夹权限后重试');
    // 主文案不含 errno、不含 unlink、不含绝对路径
    expect(main.textContent).not.toContain('EACCES');
    expect(main.textContent).not.toContain('unlink');
    expect(main.textContent).not.toContain(AUDIO_DIR);
    // 原始错误只出现在折叠的 details 里
    const raw = screen.getByText(EACCES_RAW);
    const details = raw.closest('details');
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain('EACCES');
    expect(details?.textContent).toContain(`unlink '${AUDIO_DIR}/seg-1.wav'`);
    // 失败行提供两个出口
    expect(screen.getByRole('button', { name: '打开文件夹' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('opens the recordings folder via openNativePath and swallows opener failures', async () => {
    services.getAudioCaptureStatus.mockResolvedValue(status(2, EACCES_RAW));
    facade.openNativePath.mockRejectedValueOnce(new Error('no opener plugin'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(React.createElement(NativeDesktopSection));
      fireEvent.click(await screen.findByRole('button', { name: '打开文件夹' }));
      await waitFor(() => expect(facade.openNativePath).toHaveBeenCalledWith(AUDIO_DIR));
      // 打开失败只留 warn，不产生未捕获拒绝
      await waitFor(() => expect(warn).toHaveBeenCalled());
    } finally {
      warn.mockRestore();
    }
  });

  it('retry re-opens the confirm dialog instead of clearing directly', async () => {
    services.getAudioCaptureStatus.mockResolvedValue(status(3, 'EBUSY'));
    services.clearAudioRecordings.mockResolvedValue({ deleted: 0, freedBytes: 0, failed: 0 });
    render(React.createElement(NativeDesktopSection));

    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    expect(await screen.findByRole('dialog', { name: '清空录音' })).toBeTruthy();
    expect(services.clearAudioRecordings).not.toHaveBeenCalled();
  });

  it('renders both failure classes in english', async () => {
    i18nState.language = 'en';
    services.getAudioCaptureStatus.mockResolvedValue(
      status(2, `eperm: operation not permitted, unlink '${AUDIO_DIR}/seg-2.wav'`),
    );
    render(React.createElement(NativeDesktopSection));

    // 权限类（小写 eperm 也要识别）
    const main = await findFailureMain(/recordings could not be deleted/);
    expect(main.textContent).toBe(
      '2 recordings could not be deleted: no delete permission. Check the recordings folder permissions in Finder and try again',
    );
    expect(main.textContent).not.toContain('eperm');
    expect(main.textContent).not.toContain(AUDIO_DIR);
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));
    await waitFor(() => expect(facade.openNativePath).toHaveBeenCalledWith(AUDIO_DIR));

    // 其他类
    cleanup();
    services.getAudioCaptureStatus.mockResolvedValue(status(1, 'transient hiccup'));
    render(React.createElement(NativeDesktopSection));
    const other = await findFailureMain(/recordings could not be deleted/);
    expect(other.textContent).toBe(
      '1 recordings could not be deleted and this cleanup did not finish. You can retry later',
    );
    expect(other.textContent).not.toContain('transient hiccup');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('dialog', { name: 'Clear recordings' })).toBeTruthy();
    expect(services.clearAudioRecordings).not.toHaveBeenCalled();
  });
});
