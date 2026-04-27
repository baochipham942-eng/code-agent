// ============================================================================
// devServerManager - Live Preview V2-A
// ----------------------------------------------------------------------------
// 给 LivePreview 提供「选项目目录 → 自动起 dev server → 拿到 URL」能力。
// 范围（V2-A）：Vite / CRA 真起；Next.js 仅探测，不启动（V2-C 再扩）。
//
// 设计要点：
//  - 子进程 spawn 模式参考 src/main/services/infra/browserService.ts
//  - 每个 session 一个 UUID，可同时跑多个项目
//  - 就绪检测：监听 stdout 匹配框架特定 pattern + URL，或 STARTUP 超时失败
//  - 日志：stdout/stderr 混合 ring buffer 保留 200 行
//  - 生命周期：disposeAll() 在 app exit 时被 main entry 调用，SIGTERM →
//    STOP_GRACEFUL 后 SIGKILL 兜底
// ============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIVE_PREVIEW_TIMEOUTS } from '../../../shared/constants/timeouts';
import type {
  DevServerLogEntry,
  DevServerSession,
  Framework,
  FrameworkDetectionResult,
  PackageJsonShape,
  PackageManager,
} from '../../../shared/livePreview/devServer';

const LOG_RING_SIZE = 200;

// stdout 里抓 dev server URL 的兜底正则（覆盖 vite / cra / next）
// vite:    "  ➜  Local:   http://localhost:5173/"
// cra:     "  Local:            http://localhost:3000"
// next:    "- Local:        http://localhost:3000"
const URL_PATTERNS: RegExp[] = [
  /Local:\s+(https?:\/\/[^\s]+)/i,
  /ready (?:in|on|started server on).*?(https?:\/\/[^\s]+)/i,
];

interface ManagedSession {
  meta: DevServerSession;
  process: ChildProcess;
  logs: DevServerLogEntry[];
  /** ready 信号到达时 resolve；STARTUP 超时时 reject */
  readyPromise: Promise<string>;
  resolveReady?: (url: string) => void;
  rejectReady?: (err: Error) => void;
  startupTimer: NodeJS.Timeout | null;
}

// ----------------------------------------------------------------------------
// 框架探测
// ----------------------------------------------------------------------------

function readPackageJson(projectPath: string): PackageJsonShape | null {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJsonShape;
  } catch {
    return null;
  }
}

function detectFramework(projectPath: string, pkg: PackageJsonShape | null): Framework {
  // 配置文件优先（最可靠）
  const viteConfigCandidates = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'];
  if (viteConfigCandidates.some((f) => existsSync(path.join(projectPath, f)))) return 'vite';

  const nextConfigCandidates = ['next.config.ts', 'next.config.js', 'next.config.mjs'];
  if (nextConfigCandidates.some((f) => existsSync(path.join(projectPath, f)))) return 'next';

  // 没有配置文件时退化到 deps 推断
  if (pkg) {
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (allDeps['react-scripts']) return 'cra';
    if (allDeps['next']) return 'next';
    if (allDeps['vite']) return 'vite';
  }

  return 'unknown';
}

function detectPackageManager(projectPath: string): PackageManager {
  if (existsSync(path.join(projectPath, 'bun.lock')) || existsSync(path.join(projectPath, 'bun.lockb'))) return 'bun';
  if (existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export function detectProjectFramework(projectPath: string): FrameworkDetectionResult {
  const absPath = path.resolve(projectPath);
  if (!existsSync(absPath)) {
    return {
      framework: 'unknown',
      packageManager: 'npm',
      devScript: null,
      supported: false,
      reason: `目录不存在: ${absPath}`,
    };
  }

  const pkg = readPackageJson(absPath);
  if (!pkg) {
    return {
      framework: 'unknown',
      packageManager: 'npm',
      devScript: null,
      supported: false,
      reason: '未找到 package.json',
    };
  }

  const framework = detectFramework(absPath, pkg);
  const packageManager = detectPackageManager(absPath);
  const devScript = pkg.scripts?.dev || pkg.scripts?.start || null;

  if (framework === 'next') {
    return {
      framework,
      packageManager,
      devScript,
      supported: false,
      reason: 'Next.js App Router 计划在 V2-C 支持，当前请手动 `next dev` 后填入 URL',
    };
  }

  if (framework === 'unknown') {
    return {
      framework,
      packageManager,
      devScript,
      supported: false,
      reason: '无法识别项目框架（仅支持 Vite / CRA），请手动启动 dev server 后填 URL',
    };
  }

  if (!devScript) {
    return {
      framework,
      packageManager,
      devScript: null,
      supported: false,
      reason: 'package.json 没有 scripts.dev，无法自动启动',
    };
  }

  return { framework, packageManager, devScript, supported: true };
}

// ----------------------------------------------------------------------------
// DevServerManager
// ----------------------------------------------------------------------------

export class DevServerManager {
  private sessions = new Map<string, ManagedSession>();

  detect(projectPath: string): FrameworkDetectionResult {
    return detectProjectFramework(projectPath);
  }

  list(): DevServerSession[] {
    return Array.from(this.sessions.values()).map((s) => s.meta);
  }

  get(sessionId: string): DevServerSession | null {
    return this.sessions.get(sessionId)?.meta ?? null;
  }

  getLogs(sessionId: string): DevServerLogEntry[] {
    return this.sessions.get(sessionId)?.logs.slice() ?? [];
  }

  /**
   * 启动 dev server。返回 session（status='starting'），ready 后通过
   * `waitForReady(sessionId)` 拿 URL；也可以轮询 `get(sessionId).status`。
   */
  start(projectPath: string): DevServerSession {
    const detection = this.detect(projectPath);
    if (!detection.supported || !detection.devScript) {
      throw new Error(detection.reason || 'dev server 不支持');
    }

    const sessionId = randomUUID();
    const absPath = path.resolve(projectPath);
    const { command, args } = buildSpawnCommand(detection.packageManager);

    const child = spawn(command, args, {
      cwd: absPath,
      env: { ...process.env, FORCE_COLOR: '0', BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const meta: DevServerSession = {
      sessionId,
      projectPath: absPath,
      framework: detection.framework,
      packageManager: detection.packageManager,
      status: 'starting',
      url: null,
      pid: child.pid ?? null,
      startedAt: Date.now(),
    };

    let resolveReady: ((url: string) => void) | undefined;
    let rejectReady: ((err: Error) => void) | undefined;
    const readyPromise = new Promise<string>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const session: ManagedSession = {
      meta,
      process: child,
      logs: [],
      readyPromise,
      resolveReady,
      rejectReady,
      startupTimer: null,
    };

    // STARTUP 超时
    session.startupTimer = setTimeout(() => {
      if (meta.status === 'starting') {
        meta.status = 'failed';
        meta.error = `${LIVE_PREVIEW_TIMEOUTS.STARTUP / 1000}s 内未检测到 dev server ready 信号`;
        session.rejectReady?.(new Error(meta.error));
        this.killProcess(session);
      }
    }, LIVE_PREVIEW_TIMEOUTS.STARTUP);

    const handleChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const line of text.split('\n')) {
        // eslint-disable-next-line no-control-regex -- intentional ANSI color stripping
        const trimmed = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
        if (!trimmed) continue;
        session.logs.push({ ts: Date.now(), stream, line: trimmed });
        if (session.logs.length > LOG_RING_SIZE) {
          session.logs.splice(0, session.logs.length - LOG_RING_SIZE);
        }
        if (meta.status === 'starting') {
          const url = matchUrl(trimmed);
          if (url) {
            meta.status = 'ready';
            meta.url = url;
            if (session.startupTimer) {
              clearTimeout(session.startupTimer);
              session.startupTimer = null;
            }
            session.resolveReady?.(url);
          }
        }
      }
    };

    child.stdout?.on('data', handleChunk('stdout'));
    child.stderr?.on('data', handleChunk('stderr'));

    child.once('exit', (code, signal) => {
      if (session.startupTimer) {
        clearTimeout(session.startupTimer);
        session.startupTimer = null;
      }
      if (meta.status === 'starting') {
        meta.status = 'failed';
        meta.error = `dev server 提前退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
        session.rejectReady?.(new Error(meta.error));
      } else if (meta.status === 'ready') {
        meta.status = 'stopped';
      }
    });

    child.once('error', (err) => {
      if (meta.status === 'starting') {
        meta.status = 'failed';
        meta.error = err.message;
        session.rejectReady?.(err);
      }
    });

    this.sessions.set(sessionId, session);
    return meta;
  }

  /** 等待 ready URL，超时由 STARTUP 控制 */
  waitForReady(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error(`session ${sessionId} 不存在`));
    return session.readyPromise;
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.killProcess(session);
    this.sessions.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private killProcess(session: ManagedSession): Promise<void> {
    return new Promise((resolve) => {
      const child = session.process;
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* swallow */
        }
        resolve();
      }, LIVE_PREVIEW_TIMEOUTS.STOP_GRACEFUL);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function buildSpawnCommand(pm: PackageManager): { command: string; args: string[] } {
  // 统一走 `<pm> run dev`，让框架自己处理端口冲突
  switch (pm) {
    case 'bun':
      return { command: 'bun', args: ['run', 'dev'] };
    case 'pnpm':
      return { command: 'pnpm', args: ['run', 'dev'] };
    case 'yarn':
      return { command: 'yarn', args: ['dev'] };
    case 'npm':
    default:
      return { command: 'npm', args: ['run', 'dev'] };
  }
}

function matchUrl(line: string): string | null {
  for (const pattern of URL_PATTERNS) {
    const m = line.match(pattern);
    if (m && m[1]) {
      // 去掉末尾 / 保持与 LiveScore validateLivePreviewDevServerUrl 一致
      return m[1].replace(/\/+$/, '');
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// 单例（main 进程内全局共享，IPC handler 直接 import 拿）
// ----------------------------------------------------------------------------

let _instance: DevServerManager | null = null;

export function getDevServerManager(): DevServerManager {
  if (!_instance) _instance = new DevServerManager();
  return _instance;
}
