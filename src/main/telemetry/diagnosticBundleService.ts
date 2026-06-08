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
import { exec } from 'child_process';
import { promisify } from 'util';
import { getTelemetryStorage, type TelemetryStorage } from './telemetryStorage';
import { getAppVersion } from '../platform/appPaths';
import { createLogger } from '../services/infra/logger';
import type {
  DiagnosticBundle,
  DiagnosticBundleTurn,
  DiagnosticEnvFingerprint,
} from '../../shared/contract/telemetry';

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
