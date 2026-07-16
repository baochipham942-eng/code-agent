// ============================================================================
// OS 沙箱 wrapCommand 真实隔离集成测试（macOS / seatbelt）
//
// 不 mock：真实生成 seatbelt profile，用 spawn(cmd, {shell:true}) 跑包装后的命令，
// 验证"命令能跑 + PATH 工具可达 + 工作目录内可写 + 越界写被内核拒绝"。
// 仅在 darwin 且 sandbox-exec 可用时运行，其余环境 skip。
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { wrapCommandForSandbox, getSandboxManager } from '@host/sandbox';

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

const sandboxReady = process.platform === 'darwin' && getSandboxManager().isAvailable();
const suite = sandboxReady ? describe : describe.skip;

suite('seatbelt wrapCommand 真实隔离', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-proj-'));
  });
  afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('普通命令正常执行并返回输出', async () => {
    const { command, cleanup } = wrapCommandForSandbox('echo hello-sandbox', {
      workingDirectory: projectDir,
      allowNetwork: false,
    });
    const r = await run(command, projectDir);
    cleanup();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hello-sandbox');
  });

  it('PATH 上的工具可达（node -v）—— 验证 profile 不过紧', async () => {
    const { command, cleanup } = wrapCommandForSandbox('node -v', {
      workingDirectory: projectDir,
      allowNetwork: false,
    });
    const r = await run(command, projectDir);
    cleanup();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/v\d+\./);
  });

  it('工作目录内写入成功', async () => {
    const { command, cleanup } = wrapCommandForSandbox('echo ok > in-project.txt', {
      workingDirectory: projectDir,
      allowNetwork: false,
    });
    const r = await run(command, projectDir);
    cleanup();
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(projectDir, 'in-project.txt'))).toBe(true);
  });

  it('越界写入（HOME 根目录）被沙箱拒绝 —— 核心隔离实证', async () => {
    const escapeTarget = path.join(os.homedir(), `__sandbox_escape_${Date.now()}.txt`);
    const { command, cleanup } = wrapCommandForSandbox(
      `echo pwned > ${JSON.stringify(escapeTarget)}`,
      { workingDirectory: projectDir, allowNetwork: false },
    );
    const r = await run(command, projectDir);
    cleanup();
    try {
      expect(r.code).not.toBe(0); // 写被拒 → 非零退出
      expect(fs.existsSync(escapeTarget)).toBe(false); // 文件没被创建
    } finally {
      if (fs.existsSync(escapeTarget)) fs.unlinkSync(escapeTarget); // 防御性清理
    }
  });

  it('引号/管道命令经 shell-quote 包装后语义正确', async () => {
    const { command, cleanup } = wrapCommandForSandbox(
      `echo 'a b c' | tr ' ' '-'`,
      { workingDirectory: projectDir, allowNetwork: false },
    );
    const r = await run(command, projectDir);
    cleanup();
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('a-b-c');
  });

  it('省略 allowNetwork 时默认断网（锁死 fail-closed 默认，防回退 ?? true）', () => {
    const { command, cleanup } = wrapCommandForSandbox('echo default-net', {
      workingDirectory: projectDir,
    });
    try {
      const profilePath = /-f\s+(\S+)/.exec(command)?.[1];
      expect(profilePath).toBeTruthy();
      const profile = fs.readFileSync(profilePath!.replace(/['"]/g, ''), 'utf-8');
      expect(profile).toContain('(deny network*)');
    } finally {
      cleanup?.();
    }
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
