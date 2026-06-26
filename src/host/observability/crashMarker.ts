// ============================================================================
// Crash Marker - 脏标记法检测"上次会话是否异常退出"
// ============================================================================
//
// 为什么放 Node 侧而不是 Rust：
//   - Sentry 在 Node 层，Rust 写文件再让 Node 转发是多余一跳。
//   - process.on('exit') 是天然的"干净退出"信号：正常退出/主动 process.exit 会触发，
//     而 kill -9 / OOM / Rust shell 崩溃 / 断电都不触发 → 标记残留 → 下次启动检测到。
//   - 因此本机制连 Rust shell 崩溃一起兜住（Rust 挂了 Node 不会跑到 'exit'）。
//   - panic=abort 下 Rust 无法在进程内捕获，detect-on-next-boot 是最稳的路径。
//
// 不注册 SIGINT/SIGTERM listener：那会抑制 Node 默认终止行为、可能让 Ctrl-C 挂起，
// 且与 app 既有信号处理冲突。只挂同步的 'exit' 清理即可。
//
// ============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getUserDataPath } from '../platform/appPaths';
import { createLogger } from '../services/infra/logger';
import { captureMessage } from './sentryNode';
import { scrubString } from '../../shared/observability/scrubEvent';

const logger = createLogger('CrashMarker');

const MARKER_FILE = '.session-running';
const LOG_TAIL_BYTES = 4000;

function markerPath(): string {
  return path.join(getUserDataPath(), MARKER_FILE);
}

/** 读最近一个日志文件的尾部，作为崩溃上下文（日志本身已被 logger 脱敏，这里再兜一道） */
function readRecentLogTail(): string | undefined {
  try {
    const logDir = path.join(getUserDataPath(), 'logs');
    if (!fs.existsSync(logDir)) return undefined;
    const newest = fs
      .readdirSync(logDir)
      .filter((f) => f.startsWith('code-agent-') && f.endsWith('.log'))
      .map((f) => {
        const p = path.join(logDir, f);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) return undefined;
    const buf = fs.readFileSync(newest.p, 'utf8');
    const tail = buf.length > LOG_TAIL_BYTES ? buf.slice(-LOG_TAIL_BYTES) : buf;
    return scrubString(tail, { homeDir: os.homedir() });
  } catch {
    return undefined;
  }
}

let installed = false;

/**
 * 初始化崩溃标记。应在进程入口尽早调用（initSentryNode 之后）。
 * 1) 启动时若标记仍在 → 上次异常退出 → 上报 Sentry。
 * 2) 写本次会话标记。
 * 3) 干净退出时移除标记。
 */
export function initCrashMarker(): void {
  if (installed) return;
  installed = true;

  const marker = markerPath();

  // 1) 检测上次是否异常退出
  try {
    if (fs.existsSync(marker)) {
      let startedAt: number | undefined;
      try {
        startedAt = (JSON.parse(fs.readFileSync(marker, 'utf8')) as { startedAt?: number }).startedAt;
      } catch {
        /* 标记损坏也按异常退出处理 */
      }
      logger.error('Detected unclean exit from previous session', undefined, { startedAt });
      captureMessage('Previous session exited uncleanly (crash / kill / power loss)', 'error', {
        tags: { surface: 'node', source: 'crash-marker' },
        extra: { previousSessionStartedAt: startedAt, logTail: readRecentLogTail() },
      });
    }
  } catch (err) {
    logger.warn('Crash marker detection failed', err);
  }

  // 2) 写本次会话标记
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ startedAt: Date.now(), pid: process.pid }), 'utf8');
  } catch (err) {
    logger.warn('Crash marker write failed', err);
  }

  // 3) 干净退出时移除（同步，'exit' 内只能同步）。崩溃/kill 不触发 → 留痕给下次检测
  process.on('exit', () => {
    try {
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
    } catch {
      /* noop */
    }
  });
}
