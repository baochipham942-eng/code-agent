import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { runVerifyGate } from '../../../src/host/agent/goalVerifyGate';

describe('runVerifyGate — spawnFailed 判别（本地执行环境 vs 验证不过）', () => {
  const tmpPaths: string[] = [];
  afterEach(() => {
    for (const p of tmpPaths.splice(0)) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it('正常通过（exit 0）→ spawnFailed:false', async () => {
    const result = await runVerifyGate('exit 0', process.cwd(), 5000);
    expect(result).toMatchObject({ pass: true, exitCode: 0, spawnFailed: false });
  });

  it('正常失败（exit 1，进程真的跑了）→ spawnFailed:false', async () => {
    const result = await runVerifyGate('exit 1', process.cwd(), 5000);
    expect(result).toMatchObject({ pass: false, exitCode: 1, spawnFailed: false });
  });

  it('命令未解析（exit 127，shell 正常跑了只是命令不存在）→ spawnFailed:false', async () => {
    const result = await runVerifyGate('nonexistent-cmd-xyz-12345', process.cwd(), 5000);
    expect(result).toMatchObject({ pass: false, exitCode: 127, spawnFailed: false });
    expect(result.output).toContain('command not found');
  });

  it('超时 → spawnFailed:false（进程跑了，只是没在时限内结束）', async () => {
    const result = await runVerifyGate('sleep 5', process.cwd(), 300);
    expect(result).toMatchObject({ pass: false, exitCode: null, timedOut: true, spawnFailed: false });
  });

  it('cwd 不存在（异步 ENOENT，走 child.on("error")）→ spawnFailed:true，exitCode:null', async () => {
    const result = await runVerifyGate('echo hi', '/nonexistent/path/xyz-abc-123', 5000);
    expect(result).toMatchObject({ pass: false, exitCode: null, timedOut: false, spawnFailed: true });
    expect(result.output).toContain('ENOENT');
  });

  it('cwd 是文件不是目录（同步 ENOTDIR）→ 优雅 resolve 为 spawnFailed:true，不 reject（回归：此前会让 Promise 直接 reject 崩掉整轮 turn）', async () => {
    const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), 'verify-gate-probe-')), 'not-a-dir');
    writeFileSync(filePath, 'x');
    tmpPaths.push(path.dirname(filePath));

    await expect(runVerifyGate('echo hi', filePath, 5000)).resolves.toMatchObject({
      pass: false,
      exitCode: null,
      spawnFailed: true,
    });
  });
});
