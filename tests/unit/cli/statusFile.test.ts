// ============================================================================
// StatusFileWriter (utils/statusFile.ts) — 心跳快照 / 节流 / 原子写 / 终态
// ============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusFileWriter } from '../../../src/cli/utils/statusFile';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'statusfile-test-'));
}

function readSnapshot(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

describe('StatusFileWriter', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = makeTmpDir();
    file = path.join(dir, 'status.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('start() 立即写入 starting 快照（version/pid/sessionId/零计数）', () => {
    const writer = new StatusFileWriter(file, 'sess-1');
    writer.start();
    writer.stop();

    const snap = readSnapshot(file);
    // version 是外部契约字段，必须恒为 1
    expect(snap.version).toBe(1);
    expect(snap.phase).toBe('starting');
    expect(snap.sessionId).toBe('sess-1');
    expect(snap.pid).toBe(process.pid);
    expect(snap.turn).toBe(0);
    expect(snap.tokens).toEqual({ input: 0, output: 0 });
    expect(snap.lastTool).toBeNull();
    expect(typeof snap.startedAt).toBe('number');
    expect(snap.elapsedSeconds).toBe(0);
  });

  it('节流：间隔内不重写，到点 ticker 重写一次', () => {
    const writer = new StatusFileWriter(file, 'sess-1');
    writer.start();
    const initial = readSnapshot(file).updatedAt as number;

    // 间隔内推进 1.9s：updatedAt 不变
    vi.advanceTimersByTime(1900);
    expect(readSnapshot(file).updatedAt).toBe(initial);

    // 推进到 2s：ticker 重写
    vi.advanceTimersByTime(100);
    const second = readSnapshot(file).updatedAt as number;
    expect(second).toBeGreaterThan(initial);

    // 再推进 2s：又重写一次
    vi.advanceTimersByTime(2000);
    expect(readSnapshot(file).updatedAt).toBeGreaterThan(second);
    writer.stop();
  });

  it('markRunning + 事件计数在下一帧快照中体现', () => {
    const writer = new StatusFileWriter(file, 'sess-1');
    writer.start();

    writer.markRunning();
    writer.onTurnStart();
    writer.onTurnStart();
    writer.onToolStart('Read');
    writer.setTokens(123, 45);
    vi.advanceTimersByTime(2000);

    const snap = readSnapshot(file);
    expect(snap.phase).toBe('running');
    expect(snap.turn).toBe(2);
    expect(snap.tokens).toEqual({ input: 123, output: 45 });
    expect(snap.lastTool).toMatchObject({ name: 'Read' });
    expect(typeof (snap.lastTool as { ts: number }).ts).toBe('number');
    writer.stop();
  });

  it('原子写：tmp 文件不残留，目标文件始终是完整可解析 JSON', () => {
    const writer = new StatusFileWriter(file, 'sess-1');
    writer.start();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2000);
      // 每次采样都能完整解析，且同目录无 tmp 残留
      expect(() => readSnapshot(file)).not.toThrow();
      expect(fs.existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
    }
    writer.finish({ success: true });
    expect(fs.existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
    expect(() => readSnapshot(file)).not.toThrow();
  });

  it('finish success：终态 phase/status + 指标汇总，ticker 停止', () => {
    const writer = new StatusFileWriter(file, 'sess-1');
    writer.start();
    writer.onTurnStart();
    vi.advanceTimersByTime(2000);

    const metrics = { sessionId: 'sess-1', turnCount: 1, totalTokens: 168 };
    writer.finish({ success: true, metrics: metrics as never });

    const snap = readSnapshot(file);
    expect(snap.phase).toBe('finished');
    expect(snap.status).toBe('success');
    expect(snap.error).toBeUndefined();
    expect(snap.metrics).toEqual(metrics);
    expect(snap.turn).toBe(1);

    // ticker 已停：再推进时间不再重写
    const updatedAt = snap.updatedAt as number;
    vi.advanceTimersByTime(10000);
    expect(readSnapshot(file).updatedAt).toBe(updatedAt);
  });

  it('finish error：终态带 error.message / class', () => {
    const writer = new StatusFileWriter(file, 'sess-1');
    writer.start();
    writer.finish({
      success: false,
      error: { message: 'model 500', class: 'Error' },
    });

    const snap = readSnapshot(file);
    expect(snap.phase).toBe('finished');
    expect(snap.status).toBe('error');
    expect(snap.error).toEqual({ message: 'model 500', class: 'Error' });
  });

  it('目标目录不存在时自动创建（mkdir -p）', () => {
    const nested = path.join(dir, 'a', 'b', 'status.json');
    const writer = new StatusFileWriter(nested, 'sess-1');
    writer.start();
    writer.stop();
    expect(readSnapshot(nested).sessionId).toBe('sess-1');
  });

  it('路径不可写：start/finish 不抛错，writer 降级停用', () => {
    // 用一个已存在的文件当作"目录"前缀 → mkdir/rename 必然失败
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const badPath = path.join(blocker, 'status.json');

    const writer = new StatusFileWriter(badPath, 'sess-1');
    expect(() => writer.start()).not.toThrow();
    // 已停用：后续操作全部静默 no-op
    expect(() => writer.onTurnStart()).not.toThrow();
    expect(() => writer.finish({ success: true })).not.toThrow();
    expect(fs.existsSync(badPath)).toBe(false);
  });

  it('tokensProvider：每次写快照时拉取实时值，优先于 setTokens', () => {
    let live = { input: 1, output: 2 };
    const writer = new StatusFileWriter(file, 'sess-1', { tokensProvider: () => live });
    writer.start();
    expect(readSnapshot(file).tokens).toEqual({ input: 1, output: 2 });

    live = { input: 300, output: 40 };
    vi.advanceTimersByTime(2000);
    expect(readSnapshot(file).tokens).toEqual({ input: 300, output: 40 });
    writer.stop();
  });

  it('elapsedSeconds 随时间推进（一位小数）', () => {
    const writer = new StatusFileWriter(file, 'sess-1');
    writer.start();
    // ticker 每 2s 一帧：推进 4s 后最后一帧写在 +4000ms
    vi.advanceTimersByTime(4000);
    expect(readSnapshot(file).elapsedSeconds).toBeCloseTo(4.0, 5);
    writer.stop();
  });
});
