// ============================================================================
// daemonStateFile 单测（ADR-083 append 2026-10-18）：
//   - 原子写 + 宽容读（缺失/非 JSON/形状不符 → null，CLI 按无留守原因口径处理）；
//   - formatDaemonStayStatus 两态文案（有原因列原因 / 无原因明说壳走就退）。
// ============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatDaemonStayStatus,
  readDaemonStateFile,
  writeDaemonStateFile,
  type DaemonStateFile,
} from '../../../../../src/host/services/daemon/daemonStateFile';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-daemon-state-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const sample: DaemonStateFile = {
  pid: 4242,
  intent: 'background',
  reasons: ['armed-schedules'],
  armedSchedules: 2,
  updatedAt: 1_700_000_000_000,
};

describe('writeDaemonStateFile / readDaemonStateFile', () => {
  it('写后读回原值，且不留 tmp 残留（原子写）', () => {
    writeDaemonStateFile(dataDir, sample);
    expect(readDaemonStateFile(dataDir)).toEqual(sample);
    expect(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('覆盖写：第二次写换内容后读到新值', () => {
    writeDaemonStateFile(dataDir, sample);
    writeDaemonStateFile(dataDir, { ...sample, intent: 'stop', reasons: ['running-runs'], armedSchedules: 0 });
    expect(readDaemonStateFile(dataDir)).toMatchObject({ intent: 'stop', reasons: ['running-runs'] });
  });

  it('文件缺失 / 非 JSON / 形状不符 → null（宽容读，不抛）', () => {
    expect(readDaemonStateFile(dataDir)).toBeNull();
    fs.writeFileSync(path.join(dataDir, 'daemon-state.json'), 'not-json');
    expect(readDaemonStateFile(dataDir)).toBeNull();
    fs.writeFileSync(path.join(dataDir, 'daemon-state.json'), JSON.stringify({ pid: 1 }));
    expect(readDaemonStateFile(dataDir)).toBeNull();
    fs.writeFileSync(path.join(dataDir, 'daemon-state.json'), JSON.stringify({ ...sample, intent: 'reboot' }));
    expect(readDaemonStateFile(dataDir)).toBeNull();
    fs.writeFileSync(path.join(dataDir, 'daemon-state.json'), JSON.stringify({ ...sample, reasons: ['nonsense'] }));
    expect(readDaemonStateFile(dataDir)).toBeNull();
  });
});

describe('formatDaemonStayStatus', () => {
  it('有原因：逐项列出，armed schedules 带数量（单数/复数）', () => {
    expect(formatDaemonStayStatus({ ...sample, armedSchedules: 1 }))
      .toBe('Staying alive because: 1 armed schedule');
    expect(formatDaemonStayStatus({ ...sample, armedSchedules: 3 }))
      .toBe('Staying alive because: 3 armed schedules');
    expect(formatDaemonStayStatus({ ...sample, reasons: ['running-runs', 'awaiting-approval'], armedSchedules: 0 }))
      .toBe('Staying alive because: running runs, pending approval');
    expect(formatDaemonStayStatus({ ...sample, reasons: ['paired-companion', 'armed-schedules'], armedSchedules: 2 }))
      .toBe('Staying alive because: paired companion, 2 armed schedules');
  });

  it('无原因（空清单或陈旧文件 null）：明说壳走就退', () => {
    expect(formatDaemonStayStatus({ ...sample, reasons: [] }))
      .toBe('No reason to stay alive: exits once the shell is gone');
    expect(formatDaemonStayStatus(null))
      .toBe('No reason to stay alive: exits once the shell is gone');
  });
});
