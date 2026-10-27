// ============================================================================
// daemonStateReporter 单测（ADR-083 append 2026-10-18）：
//   - start 即写初值；内容未变跳过写盘（去重）；
//   - 快照变化 / 意图变化（quit-intent 路由入口）→ 重写；
//   - cron 任务变化（CronService.onJobsChanged）→ 重写 + 联动去留 recheck。
// cron 订阅经 vi.mock 替身（真 CronService 的 DB 面在 tests/unit/cron/ 另测）。
// ============================================================================

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuitGuardRouter } from '../../../../../src/web/routes/quitGuard';
// 注：不回收临时目录——reporter 的意图监听器是进程级单例，回收后残留写入只添
// warn 噪声；每次测试各用新目录互不串读。

const cronHarness = vi.hoisted(() => ({
  jobsChangedListeners: new Set<() => void>(),
}));

vi.mock('../../../../../src/host/cron/cronService', () => ({
  getCronService: () => ({
    onJobsChanged: (listener: () => void) => {
      cronHarness.jobsChangedListeners.add(listener);
      return () => cronHarness.jobsChangedListeners.delete(listener);
    },
  }),
}));

import type { DaemonIdleSnapshot } from '../../../../../src/host/services/daemon/daemonIdle';
import { readDaemonStateFile } from '../../../../../src/host/services/daemon/daemonStateFile';
import { createDaemonResidencyReporter } from '../../../../../src/host/services/daemon/daemonStateReporter';
import { setDaemonQuitIntent } from '../../../../../src/host/services/daemon/quitIntent';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-daemon-reporter-'));
  // reporter 的 cron 订阅不随测试回收：清空替身登记表，保证只测当次实例。
  cronHarness.jobsChangedListeners.clear();
});

function mtime(): number {
  return fs.statSync(path.join(dataDir, 'daemon-state.json')).mtimeMs;
}

describe('createDaemonResidencyReporter', () => {
  it('start 即写初值；内容未变的 report 跳过写盘（mtime 不动）', () => {
    const snapshot: DaemonIdleSnapshot = { runningRuns: false, pairedCompanion: false, awaitingApproval: false, armedSchedules: 2 };
    const reporter = createDaemonResidencyReporter({ dataDir, getSnapshot: () => snapshot, recheck: () => false });
    const state = readDaemonStateFile(dataDir);
    expect(state).toMatchObject({ pid: process.pid, intent: 'none', reasons: [], armedSchedules: 2 });
    const firstMtime = mtime();
    reporter.report();
    expect(mtime()).toBe(firstMtime);
    expect(state?.pid).toBe(process.pid);
  });

  it('快照变化（armed → run 在跑）→ 重写并带上新原因', () => {
    let snapshot: DaemonIdleSnapshot = { runningRuns: false, pairedCompanion: false, awaitingApproval: false, armedSchedules: 1 };
    const reporter = createDaemonResidencyReporter({ dataDir, getSnapshot: () => snapshot, recheck: () => false });
    expect(readDaemonStateFile(dataDir)?.reasons).toEqual([]);
    snapshot = { ...snapshot, runningRuns: true };
    reporter.report();
    expect(readDaemonStateFile(dataDir)?.reasons).toEqual(['running-runs']);
  });

  it('意图变化（quit-intent 路由入口）→ 监听器重写状态文件（armed+background 生效）', () => {
    const snapshot: DaemonIdleSnapshot = { runningRuns: false, pairedCompanion: false, awaitingApproval: false, armedSchedules: 1 };
    createDaemonResidencyReporter({ dataDir, getSnapshot: () => snapshot, recheck: () => false });
    expect(readDaemonStateFile(dataDir)?.reasons).toEqual([]);
    setDaemonQuitIntent('background');
    expect(readDaemonStateFile(dataDir)).toMatchObject({ intent: 'background', reasons: ['armed-schedules'] });
    setDaemonQuitIntent('stop');
    expect(readDaemonStateFile(dataDir)).toMatchObject({ intent: 'stop' });
  });

  it('cron 任务变化 → 重写状态文件并联动去留 recheck（⑤接线层）', async () => {
    let snapshot: DaemonIdleSnapshot = { runningRuns: false, pairedCompanion: false, awaitingApproval: false, armedSchedules: 1 };
    const recheck = vi.fn(() => false);
    createDaemonResidencyReporter({ dataDir, getSnapshot: () => snapshot, recheck });
    // 等 start 里的异步 cron 订阅落地。
    await vi.waitFor(() => expect(cronHarness.jobsChangedListeners.size).toBeGreaterThan(0));
    snapshot = { ...snapshot, armedSchedules: 0 };
    const listener = [...cronHarness.jobsChangedListeners].pop()!;
    listener();
    expect(recheck).toHaveBeenCalledOnce();
    expect(readDaemonStateFile(dataDir)?.armedSchedules).toBe(0);
  });

  it('拿不到快照（app 未接线）不写文件', () => {
    createDaemonResidencyReporter({ dataDir, getSnapshot: () => undefined, recheck: () => false });
    expect(fs.existsSync(path.join(dataDir, 'daemon-state.json'))).toBe(false);
  });

  it('POST /api/quit-intent background then stop leaves daemon-state.json intent', async () => {
    const snapshot: DaemonIdleSnapshot = {
      runningRuns: false,
      pairedCompanion: false,
      awaitingApproval: false,
      armedSchedules: 1,
    };
    createDaemonResidencyReporter({ dataDir, getSnapshot: () => snapshot, recheck: () => false });
    const app = express();
    app.use(express.json());
    app.use('/api', createQuitGuardRouter({
      getSnapshot: async () => ({ activeRuns: 0, armedSchedules: 1 }),
    }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const post = (mode: 'background' | 'stop') => fetch(`http://127.0.0.1:${port}/api/quit-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    try {
      // 先落到 stop，避免进程里意图已经是 background 时第一次 POST 被幂等吞掉。
      expect((await post('stop')).status).toBe(200);
      expect((await post('background')).status).toBe(200);
      expect(readDaemonStateFile(dataDir)?.intent).toBe('background');
      expect((await post('stop')).status).toBe(200);
      expect(readDaemonStateFile(dataDir)?.intent).toBe('stop');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
