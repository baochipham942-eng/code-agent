// ============================================================================
// recordShutdownCause real-process 门（N-WEBSERVER-DEATH-SUPERVISE-DIAG）
// ============================================================================
// 真子进程验证最后遗言：`node --import tsx <fixture>` 拉起一个安装了探针并抛
// uncaught error 的进程，断言 webserver-exit-cause.ndjson 里同时有
// uncaught-exception 行（错误消息 + stack 头）与 exit 行（退出码）。进程级崩溃
// 路径（uncaughtExceptionMonitor → exit）在 vitest 进程内测不出来，必须真崩。
// ============================================================================

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = path.join(repoRoot, 'tests/unit/web/fixtures/shutdownCauseUncaughtFixture.ts');

const tempDirs: string[] = [];

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-cause-proc-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('recordShutdownCause real-process（node --import tsx）', () => {
  it('uncaught 崩溃留下 uncaught-exception 行与 exit 码行', () => {
    const dataDir = makeTempDataDir();
    let childStatus: number | null = 0;
    let childStderr = '';
    try {
      execFileSync(
        process.execPath,
        ['--import', 'tsx', fixture],
        {
          cwd: repoRoot,
          env: { ...process.env, CODE_AGENT_DATA_DIR: dataDir },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      const spawnError = error as { status?: number | null; stderr?: string };
      childStatus = spawnError.status ?? null;
      childStderr = spawnError.stderr ?? '';
    }

    // uncaught error → node 必须以非零退出（崩了才叫崩）；失败时把 stderr 带出来诊断
    expect(childStatus, `fixture 应非零退出; stderr:\n${childStderr}`).toBe(1);

    const file = path.join(dataDir, 'logs', 'webserver-exit-cause.ndjson');
    expect(fs.existsSync(file), '崩溃进程必须同步留下退出原因文件').toBe(true);
    const parsedLines = fs
      .readFileSync(file, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const uncaught = parsedLines.find((line) => line['source'] === 'uncaught-exception');
    expect(uncaught, '必须有一条 uncaught-exception 行').toBeTruthy();
    expect(String(uncaught?.['detail'])).toContain('boom-uncaught-probe');
    // stack 头部必须拼接在 detail 里（errorHead 的 `||` 分隔符）
    expect(String(uncaught?.['detail'])).toContain('||');

    const exit = parsedLines.find((line) => line['source'] === 'exit');
    expect(exit, '必须有一条 exit 行').toBeTruthy();
    expect(String(exit?.['detail'])).toContain('exit-code=1');
  }, 60_000);
});
