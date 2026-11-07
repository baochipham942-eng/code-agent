// ============================================================================
// shutdownCause 接线静态契约门（N-WEBSERVER-DEATH-SUPERVISE-DIAG）
// ============================================================================
// 「webServer 死前自己知道的事」必须落盘，这条链路没有运行时会触发它的测试
// （SIGTERM/EOF/daemon-rechecker 只在真壳生命周期里走，vitest 进程测不到），
// 所以锚源码文本：
//   ① shutdown 记 recordShutdownCause（信号名 / stdin-eof / stdin-error /
//      daemon-rechecker 四个来源都汇进这一处）；
//   ② onShellPipeClosed 记 stdin-eof / stdin-error 并同步 markShellPipeDetached；
//   ③ 探针只挂 uncaughtExceptionMonitor / exit——不许新增信号处理器
//      （信号属主仍是 webServer.ts 的 shutdown，见
//      shutdownSignalOwnership.static.test.ts）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const readSrc = (rel: string) => fs.readFileSync(path.join(root, 'src', rel), 'utf8');

describe('shutdownCause 接线静态契约', () => {
  it('shutdown 记录退出原因（信号名 / stdin / daemon-rechecker 汇入一处）', () => {
    const webServer = readSrc('web/webServer.ts');
    const shutdownBlock = /const shutdown = async \(source\?: string\) => \{[\s\S]*?\n {2}\};/.exec(
      webServer
    );
    expect(shutdownBlock, 'shutdown 函数体锚点失效').not.toBeNull();
    expect(shutdownBlock![0]).toContain('recordShutdownCause(source');
  });

  it('onShellPipeClosed 区分 stdin-eof / stdin-error 并同步管道状态', () => {
    const webServer = readSrc('web/webServer.ts');
    const block = /const onShellPipeClosed = \(cause: 'stdin-eof' \| 'stdin-error'[^)]*\) => \{[\s\S]*?\n {2}\};/.exec(
      webServer
    );
    expect(block, 'onShellPipeClosed 函数体锚点失效').not.toBeNull();
    expect(block![0]).toContain('markShellPipeDetached()');
    expect(block![0]).toContain('void shutdown(cause)');
    // 'end' 与 'error' 两个事件必须分别以 stdin-eof / stdin-error 归因
    expect(webServer).toContain("process.stdin.on('end', () => onShellPipeClosed('stdin-eof'))");
    expect(webServer).toContain(
      "process.stdin.on('error', () => onShellPipeClosed('stdin-error'))"
    );
  });

  it('探针只挂 uncaughtExceptionMonitor / exit，不新增信号处理器', () => {
    const shutdownCause = readSrc('web/shutdownCause.ts');
    expect(shutdownCause).toContain("process.on('uncaughtExceptionMonitor'");
    expect(shutdownCause).toContain("process.on('exit'");
    // 不许注册任何新的信号处理器：终止权只属于 webServer.ts 的 shutdown
    expect(shutdownCause).not.toMatch(/process\.on\(\s*['"]SIG/);
    // uncaughtExceptionMonitor 必须是纯旁观（prevent 会改变崩溃行为）
    expect(shutdownCause).not.toContain('.preventDefault()');
  });

  it('退出原因落在 <dataDir>/logs/webserver-exit-cause.ndjson（与壳侧事件同目录族）', () => {
    const shutdownCause = readSrc('web/shutdownCause.ts');
    expect(shutdownCause).toContain("'webserver-exit-cause.ndjson'");
    expect(shutdownCause).toContain("'logs'");
    // 崩溃路径没有异步余量，必须同步写（appendFileSync）
    expect(shutdownCause).toContain('appendFileSync');
  });
});
