// ============================================================================
// 「谁拥有进程终止权」的静态契约门
// ----------------------------------------------------------------------------
// 2026-08-08 mac Dev 槽真机：正常退出后 -wal 4.1MB / -shm 32KB 原样残留，
// 而 Tauri 侧记录的却是 exitReason=graceful-sigterm / waitStatus=exit status: 0。
// 根因是 backgroundTasks.ts 的模块级 SIGTERM 处理器同步 `process.exit(0)`——
// 它在 esbuild 单包里先于 webServer 的 `process.on('SIGTERM', shutdown)` 注册，
// 于是 shutdown()（含 closeAllDatabaseConnections 的 WAL checkpoint）一步都跑不到。
//
// 不变量：**工具层模块不得注册信号处理器**。进程终止权只属于入口
// （src/web/webServer.ts 的 shutdown / src/cli/commands/serve.ts 的 shutdown），
// 工具层要保全状态就挂 'exit' / 'beforeExit'。
// 这里锚源码文本而不是运行时行为，因为「谁先注册」是打包顺序决定的，
// 运行时断言只能测到当次打包的偶然顺序，测不住这条约束本身。
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

/** 工具层模块：绝不允许出现信号处理器 */
const TOOL_LAYER_FILES = [
  'src/host/tools/shell/backgroundTasks.ts',
  'src/host/tools/shell/ptyExecutor.ts',
];

/**
 * 上面那些模块里**确实有状态要保全**的那一部分：它们必须挂 'exit'，不许改挂信号。
 *
 * 这是子集而不是等同于 `TOOL_LAYER_FILES`，因为「不许挂信号」是不变量，
 * 「必须挂 exit」只是它的替代手段——一个**没有状态要保全**的模块两条都不该被要求。
 * `ptyExecutor.ts` 2026-08-14（N-DSH-STOP6）删掉了那套**有写方无读方**的会话持久化
 * （`loadPersistedPtySessions` 全仓零调用方，写出去的 JSON 从来没人读），
 * 于是它不再有 exit 钩子，也不该再被这条正向锚要求。
 */
const STATE_PRESERVING_FILES = [
  'src/host/tools/shell/backgroundTasks.ts',
];

/** 允许拥有终止权的入口（正向锚，防止 shutdown 属主被误删） */
const SHUTDOWN_OWNERS = [
  'src/web/webServer.ts',
  'src/cli/commands/serve.ts',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 去掉行注释与块注释，避免断言被解释性文字撞红（T1 踩过一次） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('shutdown signal ownership', () => {
  it.each(TOOL_LAYER_FILES)('%s 不注册任何信号处理器', (rel) => {
    const code = stripComments(read(rel));
    expect(code).not.toMatch(/process\.on\(\s*['"]SIGTERM['"]/);
    expect(code).not.toMatch(/process\.on\(\s*['"]SIGINT['"]/);
  });

  it.each(STATE_PRESERVING_FILES)('%s 仍用 exit 钩子保全状态', (rel) => {
    const code = stripComments(read(rel));
    expect(code).toMatch(/process\.on\(\s*['"]exit['"]/);
  });

  // 缩小上面那张表之后，别让它悄悄缩到空——扫 0 个目标还报通过就是假绿。
  it('状态保全清单非空，且是工具层清单的子集', () => {
    expect(STATE_PRESERVING_FILES.length).toBeGreaterThan(0);
    for (const rel of STATE_PRESERVING_FILES) expect(TOOL_LAYER_FILES).toContain(rel);
  });

  it.each(SHUTDOWN_OWNERS)('%s 仍是 SIGTERM 的属主并走 shutdown', (rel) => {
    const code = stripComments(read(rel));
    expect(code).toMatch(/process\.on\(\s*['"]SIGTERM['"]\s*,\s*shutdown\s*\)/);
    expect(code).toMatch(/process\.on\(\s*['"]SIGINT['"]\s*,\s*shutdown\s*\)/);
  });

  it('webServer 的 shutdown 关库在 process.exit 之前', () => {
    const code = stripComments(read('src/web/webServer.ts'));
    const closeAt = code.indexOf('closeAllDatabaseConnections()');
    const exitAt = code.indexOf('process.exit(0)', closeAt);
    expect(closeAt).toBeGreaterThan(-1);
    expect(exitAt).toBeGreaterThan(closeAt);
  });
});
