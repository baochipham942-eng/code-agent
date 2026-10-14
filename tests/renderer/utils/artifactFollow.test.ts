import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactPathFromToolStart,
  createTrailingThrottle,
  decideArtifactFollowOpen,
  resolveFollowableArtifactPath,
} from '../../../src/renderer/utils/artifactFollow';

afterEach(() => {
  vi.useRealTimers();
});

describe('artifact follow decisions', () => {
  it('recognizes only phase-one file types from existing write tool starts', () => {
    expect(artifactPathFromToolStart({
      name: 'Write',
      arguments: { file_path: 'reports/monthly.html' },
    }, '/workspace')).toBe('/workspace/reports/monthly.html');
    expect(artifactPathFromToolStart({
      name: 'Write',
      arguments: { file_path: 'reports/data.xlsx' },
    }, '/workspace')).toBeNull();
  });

  it('follows image_generate output_file_path while preserving image_process output_path', () => {
    expect(artifactPathFromToolStart({
      name: 'image_generate',
      arguments: { prompt: ['a', 'b'], output_file_path: 'images/result.png' },
    }, '/workspace')).toBe('/workspace/images/result.png');
    expect(artifactPathFromToolStart({
      name: 'image_process',
      arguments: { output_path: 'images/processed.png' },
    }, '/workspace')).toBe('/workspace/images/processed.png');
  });

  it('follows video/music output_file_path and keeps legacy output_path readable', () => {
    expect(artifactPathFromToolStart({
      name: 'video_generate',
      arguments: { prompt: 'cat', output_file_path: 'videos/clip.mp4' },
    }, '/workspace')).toBe('/workspace/videos/clip.mp4');
    expect(artifactPathFromToolStart({
      name: 'music_generate',
      arguments: { prompt: 'song', output_file_path: 'music/track.mp3' },
    }, '/workspace')).toBe('/workspace/music/track.mp3');
    // 旧 output_path 的历史消息展示不变：同一路径照常跟随
    expect(artifactPathFromToolStart({
      name: 'video_generate',
      arguments: { prompt: 'cat', output_path: 'videos/legacy.mp4' },
    }, '/workspace')).toBe('/workspace/videos/legacy.mp4');
    expect(artifactPathFromToolStart({
      name: 'music_generate',
      arguments: { prompt: 'song', output_path: 'music/legacy.mp3' },
    }, '/workspace')).toBe('/workspace/music/legacy.mp3');
  });

  it('auto-activates while idle and degrades to attention after workbench interaction', () => {
    expect(decideArtifactFollowOpen({
      paused: false,
      focusInOtherWorkbenchView: false,
      lastWorkbenchInteractionAt: 0,
      now: 10_000,
    })).toEqual({ activate: true, attention: false });

    expect(decideArtifactFollowOpen({
      paused: false,
      focusInOtherWorkbenchView: false,
      lastWorkbenchInteractionAt: 9_000,
      now: 10_000,
    })).toEqual({ activate: false, attention: true });
  });
});

describe('artifact follow disk refresh throttle', () => {
  it('runs immediately, then coalesces repeated file events into one trailing refresh', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const throttle = createTrailingThrottle(refresh, 1_000);

    throttle.trigger();
    throttle.trigger();
    throttle.trigger();
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(999);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

// N-MOBILE-FILES 修正轮 10：生产者改产绝对路径后，win32 绝对值不能被再拼一次工作目录。
describe('resolveFollowableArtifactPath（绝对路径形态）', () => {
  it('passes POSIX absolute paths through', () => {
    expect(resolveFollowableArtifactPath('/work/product.png', '/work')).toBe('/work/product.png');
  });

  it('passes Windows drive-letter and UNC paths through without re-joining', () => {
    expect(resolveFollowableArtifactPath('C:\\work\\product.png', 'C:\\work')).toBe('C:\\work\\product.png');
    expect(resolveFollowableArtifactPath('C:/work/product.png', 'C:/work')).toBe('C:/work/product.png');
    expect(resolveFollowableArtifactPath('\\\\host\\share\\product.png', 'D:\\x')).toBe('\\\\host\\share\\product.png');
  });

  it('still joins genuinely relative paths against the working directory', () => {
    expect(resolveFollowableArtifactPath('./product.png', '/work')).toBe('/work/product.png');
    expect(resolveFollowableArtifactPath('out/product.png', '/work/')).toBe('/work/out/product.png');
  });

  it('returns null for non-followable extensions', () => {
    expect(resolveFollowableArtifactPath('/work/archive.zip', '/work')).toBeNull();
  });
});
