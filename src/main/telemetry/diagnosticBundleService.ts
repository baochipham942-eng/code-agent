// ============================================================================
// Diagnostic Bundle Service — 把一条 session 组装成可复现的诊断包
// ============================================================================
// 输入 sessionId,输出自包含 JSON:版本指纹(P1) + 环境指纹 + 聚合 span 树
// (turn → modelCall/toolCall/event) + raw 全量内容(P2 切片1)。后台拿到这个包
// 即可脱离用户机器还原 agent 轨迹。
//
// 注:env 指纹在「打包时」即时采集(非 run-time 快照),git head/dirty 可能与
// 运行时有出入;run-time 环境快照留待后续(可在 session start 落列)。
// ============================================================================

import os from 'os';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getTelemetryStorage, type TelemetryStorage } from './telemetryStorage';
import { getAppVersion } from '../platform/appPaths';
import { createLogger, getCurrentLogFilePath } from '../services/infra/logger';
import { scrubString } from '../../shared/observability/scrubEvent';
import type {
  DiagnosticBundle,
  DiagnosticBundleTurn,
  DiagnosticEnvFingerprint,
} from '../../shared/contract/telemetry';
import type { SessionLogExport } from '../../shared/contract/appService';

const execAsync = promisify(exec);
const logger = createLogger('DiagnosticBundle');

const GIT_TIMEOUT_MS = 5000;

async function runGit(args: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git ${args}`, { cwd, timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** 采集工作目录的 git 状态(无副作用,失败降级为 null)。 */
async function gatherGitState(workingDirectory: string): Promise<DiagnosticEnvFingerprint['git']> {
  const [branch, head, status] = await Promise.all([
    runGit('rev-parse --abbrev-ref HEAD', workingDirectory),
    runGit('rev-parse HEAD', workingDirectory),
    runGit('status --porcelain', workingDirectory),
  ]);
  return {
    branch,
    head,
    dirty: status === null ? null : status.length > 0,
  };
}

/** 采集环境指纹。 */
export async function gatherEnvFingerprint(workingDirectory: string): Promise<DiagnosticEnvFingerprint> {
  return {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    nodeVersion: process.version,
    appVersion: getAppVersion(),
    workingDirectory,
    git: await gatherGitState(workingDirectory),
  };
}

/**
 * 组装诊断包。session 不存在返回 null。
 * builtAt 可注入(测试用),默认 Date.now()。
 */
export async function buildDiagnosticBundle(
  sessionId: string,
  opts?: { builtAt?: number; storage?: TelemetryStorage },
): Promise<DiagnosticBundle | null> {
  const storage = opts?.storage ?? getTelemetryStorage();
  const session = storage.getSession(sessionId);
  if (!session) {
    logger.warn(`buildDiagnosticBundle: session not found: ${sessionId}`);
    return null;
  }

  const turns: DiagnosticBundleTurn[] = storage.getTurnsBySession(sessionId).map((turn) => {
    const { modelCalls, toolCalls } = storage.getTurnCalls(turn.id);
    return { turn, modelCalls, toolCalls };
  });

  const environment = await gatherEnvFingerprint(session.workingDirectory);

  return {
    bundleVersion: 1,
    builtAt: opts?.builtAt ?? Date.now(),
    sessionId,
    versions: {
      agentVersion: session.agentVersion,
      promptVersion: session.promptVersion,
      toolSchemaVersion: session.toolSchemaVersion,
    },
    environment,
    session,
    turns,
    events: storage.getEventsBySession(sessionId),
    rawPayloads: storage.getRawPayloadsForSession(sessionId),
  };
}

/**
 * 上传前脱敏:产出可外传的诊断包副本(不改原对象)。
 *
 * 用 scrubString(快速、依赖无关)对全部自由文本(含 raw 全量内容)做:
 *   - 家目录前缀 → `~`(去用户名/磁盘布局)
 *   - 密钥/token 正则红action
 * raw 内容在 slice1 已仅密钥掩码;这里再叠加路径脱敏 + 二次密钥兜底。
 *
 * ⚠️ 刻意不在 raw 上跑 GLiNER 深度 PII:256KB×N 会触发 ~110s 的既有性能灾难;
 * 而聚合表的 prompt/completion 落库时已过 GLiNER PII。深度 PII-on-raw 列推广前项
 * (可加体积上限的 PII pass,或改服务端脱敏)。
 */
export function sanitizeDiagnosticBundle(
  bundle: DiagnosticBundle,
  opts?: { homeDir?: string },
): DiagnosticBundle {
  const homeDir = opts?.homeDir ?? os.homedir();
  const scrub = <T extends string | undefined | null>(s: T): T =>
    (typeof s === 'string' ? (scrubString(s, { homeDir }) as T) : s);

  return {
    ...bundle,
    environment: {
      ...bundle.environment,
      workingDirectory: scrub(bundle.environment.workingDirectory),
    },
    session: {
      ...bundle.session,
      title: scrub(bundle.session.title),
      workingDirectory: scrub(bundle.session.workingDirectory),
    },
    turns: bundle.turns.map((t) => ({
      turn: {
        ...t.turn,
        userPrompt: scrub(t.turn.userPrompt),
        assistantResponse: scrub(t.turn.assistantResponse),
        thinkingContent: scrub(t.turn.thinkingContent),
      },
      modelCalls: t.modelCalls.map((m) => ({
        ...m,
        prompt: scrub(m.prompt),
        completion: scrub(m.completion),
        error: scrub(m.error),
      })),
      toolCalls: t.toolCalls.map((c) => ({
        ...c,
        arguments: scrub(c.arguments),
        actualArguments: scrub(c.actualArguments),
        resultSummary: scrub(c.resultSummary),
        error: scrub(c.error),
      })),
    })),
    events: bundle.events.map((e) => ({
      ...e,
      summary: scrub(e.summary),
      data: typeof e.data === 'string' ? scrub(e.data) : e.data,
    })),
    rawPayloads: bundle.rawPayloads.map((p) => ({
      ...p,
      content: scrub(p.content),
    })),
  };
}

// ----------------------------------------------------------------------------
// 会话日志导出（用户侧手动触发，区别于 telemetry 自动上传）
// ----------------------------------------------------------------------------

const LOG_TAIL_MAX_BYTES = 512 * 1024;

/** 读日志文件尾部（最多 LOG_TAIL_MAX_BYTES），失败降级 null —— 日志不可用不阻塞导出。 */
function readLogTail(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - LOG_TAIL_MAX_BYTES);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 导出会话诊断日志：脱敏诊断包 + 当天本地日志尾部（同样过 scrubString）。
 * 未登录/telemetry 自动上传不可用时，用户可右键会话手动导出发给开发者。
 * 会话不在 telemetry 存储（telemetry 关闭/历史会话）时 bundle 为 null，仍导出日志尾部。
 */
export async function buildSessionLogExport(
  sessionId: string,
  opts?: { storage?: TelemetryStorage; exportedAt?: number; logFilePath?: string; homeDir?: string },
): Promise<SessionLogExport> {
  const bundle = await buildDiagnosticBundle(sessionId, { storage: opts?.storage });
  const sanitized = bundle ? sanitizeDiagnosticBundle(bundle, { homeDir: opts?.homeDir }) : null;
  const homeDir = opts?.homeDir ?? os.homedir();
  const rawTail = readLogTail(opts?.logFilePath ?? getCurrentLogFilePath());
  const exportedAt = opts?.exportedAt ?? Date.now();
  const content = JSON.stringify(
    {
      exportVersion: 1,
      exportedAt,
      sessionId,
      bundle: sanitized,
      logTail: rawTail === null ? null : scrubString(rawTail, { homeDir }),
    },
    null,
    2,
  );
  const date = new Date(exportedAt).toISOString().split('T')[0];
  return {
    content,
    suggestedFileName: `neo-session-log-${sessionId.slice(0, 8)}-${date}.json`,
  };
}
