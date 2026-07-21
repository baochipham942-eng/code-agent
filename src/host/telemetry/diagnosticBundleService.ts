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
import { getDatabase } from '../services/core/databaseService';
import { scrubString } from '../../shared/observability/scrubEvent';
import {
  projectSurfaceExecutionMetadataForExport,
  projectSurfaceExecutionResultMetadataForExport,
} from '../../shared/utils/surfaceExecutionExportProjection';
import { redactSurfaceExecutionValue } from '../../shared/utils/surfaceExecutionRedaction';
import type {
  DiagnosticBundle,
  DiagnosticBundleTurn,
  DiagnosticEnvFingerprint,
  TelemetryTimelineEvent,
} from '../../shared/contract/telemetry';
import type { SessionLogExport } from '../../shared/contract/appService';

const execAsync = promisify(exec);
const logger = createLogger('DiagnosticBundle');

const GIT_TIMEOUT_MS = 5000;
const DIAGNOSTIC_BINARY_KEYS = new Set([
  'base64image',
  'binary',
  'blob',
  'imagedata',
  'imagedataurl',
  'imagebase64',
  'image_base64',
  'screenshotbase64',
  'screenshotdata',
]);
const SURFACE_METADATA_KEYS = new Set([
  'computerUseActionResultV1',
  'surfaceActionRequestV1',
  'surfaceActionResultV1',
  'surfaceAccessGrantV1',
  'surfaceExecutionActionRequestV1',
  'surfaceExecutionActionResultV1',
  'surfaceExecutionErrorV1',
  'surfaceExecutionEventV1',
  'surfaceExecutionEventsV1',
  'surfaceExecutionExportV1',
  'surfaceExecutionLedgerV1',
  'surfaceExecutionSessionV1',
  'surfaceGrantV1',
  'surfaceObservationV1',
]);
const INLINE_BINARY_METADATA = /\b(screenshotBase64|screenshotData|imageBase64|imageData|imageDataUrl|base64Image|image_base64)\s*[:=]\s*["']?[a-z0-9+/=]{64,}/gi;
const MAX_DIAGNOSTIC_JSON_DEPTH = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9_]/gi, '').toLowerCase();
}

function readSessionMetadata(sessionId: string): Record<string, unknown> | undefined {
  try {
    const db = getDatabase().getDb();
    if (!db) return undefined;
    const row = db.prepare('SELECT metadata FROM sessions WHERE id = ?').get(sessionId) as {
      metadata?: unknown;
    } | undefined;
    if (isRecord(row?.metadata)) return row.metadata;
    if (typeof row?.metadata !== 'string' || !row.metadata.trim()) return undefined;
    const parsed = JSON.parse(row.metadata) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function surfaceProjectionEvent(
  metadata: Record<string, unknown> | undefined,
  builtAt: number,
): TelemetryTimelineEvent | null {
  const projection = projectSurfaceExecutionMetadataForExport(metadata);
  if (!projection) return null;
  return {
    id: `surface-execution-projection-${builtAt}`,
    timestamp: builtAt,
    eventType: 'surface_execution_projection',
    summary: 'Surface execution session, event, and evidence projection',
    data: JSON.stringify({
      metadata: { surfaceExecutionExportV1: projection },
    }),
  };
}

function scrubDiagnosticString(value: string, homeDir: string, keyHint = ''): string {
  const withoutInlineBinary = value.replace(INLINE_BINARY_METADATA, '$1=[redacted-binary]');
  const scrubbed = scrubString(withoutInlineBinary, { homeDir });
  return String(redactSurfaceExecutionValue(scrubbed, keyHint));
}

function sanitizeDiagnosticJsonValue(
  value: unknown,
  homeDir: string,
  keyHint = '',
  depth = 0,
  allowSurfaceProjection = true,
): unknown {
  if (depth > MAX_DIAGNOSTIC_JSON_DEPTH) return '[truncated]';
  if (typeof value === 'string') return scrubDiagnosticString(value, homeDir, keyHint);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeDiagnosticJsonValue(
      item,
      homeDir,
      keyHint,
      depth + 1,
      allowSurfaceProjection,
    ));
  }

  const record = value as Record<string, unknown>;
  if (allowSurfaceProjection && Object.keys(record).some((key) => SURFACE_METADATA_KEYS.has(key))) {
    const projected = projectSurfaceExecutionResultMetadataForExport(record, {
      toolCallId: typeof record.toolCallId === 'string' ? record.toolCallId : undefined,
      success: typeof record.success === 'boolean' ? record.success : undefined,
      error: typeof record.error === 'string' ? record.error : undefined,
      timestamp: typeof record.timestamp === 'number' ? record.timestamp : undefined,
    });
    return sanitizeDiagnosticJsonValue(
      projected || {},
      homeDir,
      keyHint,
      depth + 1,
      false,
    );
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const normalized = normalizedKey(key);
    if (DIAGNOSTIC_BINARY_KEYS.has(normalized) || key === 'reasoning' || key === 'thinking') continue;
    output[key] = sanitizeDiagnosticJsonValue(
      child,
      homeDir,
      key,
      depth + 1,
      allowSurfaceProjection,
    );
  }
  return output;
}

function sanitizeDiagnosticText(value: string, homeDir: string, keyHint = ''): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(sanitizeDiagnosticJsonValue(JSON.parse(value), homeDir));
    } catch {
      // Truncated or non-JSON telemetry falls back to string redaction.
    }
  }
  return scrubDiagnosticString(value, homeDir, keyHint);
}

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
  opts?: {
    builtAt?: number;
    storage?: TelemetryStorage;
    sessionMetadata?: Record<string, unknown>;
  },
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
  const builtAt = opts?.builtAt ?? Date.now();
  const events = storage
    .getEventsBySession(sessionId)
    .filter((event) => event.eventType !== 'surface_execution_projection');
  const projectionEvent = surfaceProjectionEvent(
    opts?.sessionMetadata ?? readSessionMetadata(sessionId),
    builtAt,
  );
  if (projectionEvent) events.push(projectionEvent);

  return {
    bundleVersion: 1,
    builtAt,
    sessionId,
    versions: {
      agentVersion: session.agentVersion,
      promptVersion: session.promptVersion,
      toolSchemaVersion: session.toolSchemaVersion,
    },
    environment,
    session,
    turns,
    events,
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
  const scrub = <T extends string | undefined | null>(s: T, keyHint = ''): T =>
    (typeof s === 'string' ? (sanitizeDiagnosticText(s, homeDir, keyHint) as T) : s);

  return {
    ...bundle,
    environment: {
      ...bundle.environment,
      workingDirectory: scrub(bundle.environment.workingDirectory, 'workingDirectory'),
    },
    session: {
      ...bundle.session,
      title: scrub(bundle.session.title, 'title'),
      workingDirectory: scrub(bundle.session.workingDirectory, 'workingDirectory'),
    },
    turns: bundle.turns.map((t) => ({
      turn: {
        ...t.turn,
        userPrompt: scrub(t.turn.userPrompt, 'userPrompt'),
        assistantResponse: scrub(t.turn.assistantResponse, 'assistantResponse'),
        thinkingContent: undefined,
      },
      modelCalls: t.modelCalls.map((m) => ({
        ...m,
        prompt: scrub(m.prompt, 'prompt'),
        completion: scrub(m.completion, 'completion'),
        error: scrub(m.error, 'error'),
      })),
      toolCalls: t.toolCalls.map((c) => ({
        ...c,
        arguments: scrub(c.arguments, 'arguments'),
        actualArguments: scrub(c.actualArguments, 'actualArguments'),
        resultSummary: scrub(c.resultSummary, 'resultSummary'),
        error: scrub(c.error, 'error'),
      })),
    })),
    events: bundle.events.map((e) => ({
      ...e,
      summary: scrub(e.summary, 'summary'),
      data: typeof e.data === 'string' ? scrub(e.data, 'data') : e.data,
    })),
    rawPayloads: bundle.rawPayloads.map((p) => ({
      ...p,
      content: scrub(p.content, p.field),
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
      logTail: rawTail === null ? null : sanitizeDiagnosticText(rawTail, homeDir, 'logTail'),
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
