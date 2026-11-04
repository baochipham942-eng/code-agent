// ============================================================================
// Shutdown Cause — webServer 自己「为什么退出」的最后遗言
// (N-WEBSERVER-DEATH-SUPERVISE-DIAG)
// ============================================================================
// Rust 壳侧 watcher（src-tauri/src/webserver_exit.rs）只能看到「子进程以什么
// 状态死」（exit code / signal / 端口易主），看不到 node 进程死前自己知道的
// 事：收到了哪个信号、stdin 管道断没断、daemon rechecker 判定退出、还是
// uncaughtException。这些信息过去只进 console（launchd 下丢失，batch-24 三连
// 死查不到现场的另一半原因），本模块把它们同步落一份 NDJSON
// （logs/webserver-exit-cause.ndjson），与壳侧 desktop-shell-events.ndjson +
// webserver-stdio.log 三方对账，死亡归因才可判定。
//
// 硬约束：
//   - 全部同步写（appendFileSync）：exit / 崩溃路径没有异步余量；
//   - `uncaughtExceptionMonitor` 只旁观不接管（不 prevent、不退出码改写），
//     不改变崩溃行为；
//   - 不注册任何新的 SIGTERM/SIGINT/SIGHUP 处理器——信号属主仍是 webServer.ts
//     的 shutdown（tests/unit/main/shutdownSignalOwnership.static.test.ts）。
// ============================================================================

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDaemonQuitIntent } from '../host/services/daemon/quitIntent';
import { createLogger } from '../host/services/infra/logger';

const logger = createLogger('WebServerShutdownCause');

const EXIT_CAUSE_LOG_FILE = 'webserver-exit-cause.ndjson';

// 与 webServer.ts 的 shellPipeAttached 同源：被 Tauri spawn（有 boot token）且
// stdin 管道未断。onShellPipeClosed 调 markShellPipeDetached() 同步置否。
let shellPipeAttached = Boolean(process.env.CODE_AGENT_TAURI_BOOT_TOKEN);

/** stdin 管道已断（onShellPipeClosed 调用）；此后任何退出原因里都带这条事实。 */
export function markShellPipeDetached(): void {
  shellPipeAttached = false;
}

function resolveCodeAgentDataDir(): string {
  const configured = process.env.CODE_AGENT_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.code-agent');
}

/**
 * 记一条退出原因（同步 NDJSON 单行 + logger.info）。
 *
 * source 口径：信号监听器被触发时是信号名（'SIGTERM' / 'SIGINT'，Node 把信号名
 * 作为监听器首参传入）；stdin 管道断开是 'stdin-eof' / 'stdin-error'；daemon
 * rechecker 触发停机是 'daemon-rechecker'；崩溃/最后遗言是 'uncaught-exception'
 * / 'exit'。
 */
export function recordShutdownCause(source: string, detail?: string): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    pid: process.pid,
    source,
    quitIntent: getDaemonQuitIntent(),
    shellPipeAttached,
  };
  if (detail !== undefined) record.detail = detail;
  const line = JSON.stringify(record);
  try {
    const logDir = path.join(resolveCodeAgentDataDir(), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, EXIT_CAUSE_LOG_FILE), `${line}\n`);
  } catch (error) {
    logger.warn('[shutdownCause] append exit-cause record failed:', (error as Error).message);
  }
  logger.info('[shutdownCause]', line);
}

/** 错误消息 + stack 头部（前两帧）。NDJSON 单行由 JSON.stringify 负责转义换行。 */
function errorHead(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  if (!stack) return message;
  const head = stack.split('\n').slice(0, 3).join(' | ');
  return `${message} || ${head}`;
}

/**
 * 最后遗言探针：uncaughtExceptionMonitor 旁观崩溃（不改崩溃行为），exit 钩子
 * 记退出码（优雅退出 = 0 也在案，崩溃 = 1）。只在 main() 启动时装一次。
 */
export function installExitCauseProbes(): void {
  process.on('uncaughtExceptionMonitor', (error) => {
    recordShutdownCause('uncaught-exception', errorHead(error));
  });
  process.on('exit', (code) => {
    recordShutdownCause('exit', `exit-code=${code}`);
  });
}
