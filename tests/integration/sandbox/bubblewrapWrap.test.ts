// ============================================================================
// OS 沙箱 wrapCommand 真实隔离集成测试（Linux / bubblewrap）
//
// 非 Linux 环境 skip；Linux CI 环境若缺 bwrap 直接 fail，避免静默失去覆盖。
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { wrapCommandForSandbox, getBubblewrap } from '@host/sandbox';

function run(
  command: string,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const isLinux = process.platform === 'linux';
const bubblewrapReady = isLinux && getBubblewrap().isAvailable();
const failMissingBubblewrap = isLinux && Boolean(process.env.CI) && !bubblewrapReady;
const suite = bubblewrapReady || failMissingBubblewrap ? describe : describe.skip;

suite('bubblewrap wrapCommand 真实隔离', () => {
  let projectDir: string;

  beforeAll(() => {
    if (failMissingBubblewrap) {
      throw new Error('Linux CI must install bubblewrap for sandbox integration tests');
    }
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-proj-'));
  });

  afterAll(() => {
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('allowNetwork=false 时阻断 localhost HTTP 请求', async () => {
    const server = http.createServer((_req, res) => res.end('sandbox-net-ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
      const { command, cleanup } = wrapCommandForSandbox(
        `curl -fsS --max-time 2 http://127.0.0.1:${address.port}/`,
        { workingDirectory: projectDir, allowNetwork: false },
      );
      const r = await run(command, projectDir);
      cleanup();
      expect(r.code).not.toBe(0);
      expect(r.stdout).not.toContain('sandbox-net-ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('allowNetwork=true 时允许 localhost HTTP 请求', async () => {
    const server = http.createServer((_req, res) => res.end('sandbox-net-ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
      const { command, cleanup } = wrapCommandForSandbox(
        `curl -fsS --max-time 2 http://127.0.0.1:${address.port}/`,
        { workingDirectory: projectDir, allowNetwork: true },
      );
      const r = await run(command, projectDir);
      cleanup();
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('sandbox-net-ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
