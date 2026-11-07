// ============================================================================
// recordShutdownCause — NDJSON 落盘单测（N-WEBSERVER-DEATH-SUPERVISE-DIAG）
// ============================================================================
// 口径：CODE_AGENT_DATA_DIR 指到临时目录，recordShutdownCause 必须同步在
// <dataDir>/logs/webserver-exit-cause.ndjson 追加**一行可解析 JSON**，字段齐：
// ts / pid / source / quitIntent / shellPipeAttached（+ detail 可选）。
// ============================================================================

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordShutdownCause } from '../../../src/web/shutdownCause';

const tempDirs: string[] = [];

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-cause-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.CODE_AGENT_DATA_DIR;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('recordShutdownCause', () => {
  it('在临时数据目录追加一行可解析 NDJSON，字段齐全', () => {
    const dataDir = makeTempDataDir();
    process.env.CODE_AGENT_DATA_DIR = dataDir;

    recordShutdownCause('SIGTERM');

    const file = path.join(dataDir, 'logs', 'webserver-exit-cause.ndjson');
    expect(fs.existsSync(file), '退出原因文件必须已落盘').toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed['source']).toBe('SIGTERM');
    expect(parsed['pid']).toBe(process.pid);
    expect(typeof parsed['ts']).toBe('string');
    expect(Number.isNaN(Date.parse(parsed['ts'] as string))).toBe(false);
    expect(['none', 'background', 'stop']).toContain(parsed['quitIntent']);
    expect(typeof parsed['shellPipeAttached']).toBe('boolean');
  });

  it('多次调用逐行追加且每行独立可解析', () => {
    const dataDir = makeTempDataDir();
    process.env.CODE_AGENT_DATA_DIR = dataDir;

    recordShutdownCause('stdin-eof');
    recordShutdownCause('exit', 'exit-code=0');

    const file = path.join(dataDir, 'logs', 'webserver-exit-cause.ndjson');
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const parsedLines = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsedLines[0]['source']).toBe('stdin-eof');
    expect(parsedLines[1]['source']).toBe('exit');
    expect(parsedLines[1]['detail']).toBe('exit-code=0');
  });

  it('detail 携带错误消息且换行被 JSON 转义（NDJSON 单行不被劈开）', () => {
    const dataDir = makeTempDataDir();
    process.env.CODE_AGENT_DATA_DIR = dataDir;

    const boom = new Error('boom-line1\nboom-line2');
    recordShutdownCause('uncaught-exception', `${boom.message} || stack-head`);

    const file = path.join(dataDir, 'logs', 'webserver-exit-cause.ndjson');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw.trimEnd().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['detail']).toContain('boom-line1');
    expect(parsed['detail']).toContain('boom-line2');
  });
});
