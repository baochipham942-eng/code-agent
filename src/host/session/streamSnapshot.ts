// ============================================================================
// Stream Snapshot Persistence
//
// Persists one crash-recovery stream per session/run. A session owner marker
// prevents callbacks from an older run from overwriting or clearing a newer
// run's recovery evidence.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { createLogger } from '../services/infra/logger';
import { CONFIG_DIR_NEW } from '../config/configPaths';
import { redactSecrets, sanitizeLogValue } from '../security/secretRedaction';
import type { StreamSnapshot } from '../model/providers/sseStream';
import type { StreamInterruptionReason } from '../../shared/contract';

const logger = createLogger('StreamSnapshot');

const SNAPSHOT_SCHEMA_VERSION = 2 as const;
const LEGACY_SNAPSHOT_FILE = 'stream-snapshot.json';
const SNAPSHOT_DIRECTORY = 'stream-snapshots';
const OWNER_FILE = 'current-run.json';

// 「发现未完成快照」是 per-(session, run, turn) 的事实，第一条 INFO 已完整承载
// （runId/turnId/contentLength/toolCalls）。load 是高频路径（会话 load 与渲染层快照
// 重灌都会到这），同一 key 的后续 load 再打一条只是把调用频率漏进日志——真机
// 200~580 条/分钟的刷屏就是这么来的（N-STREAMSNAPSHOT-LOG-SPAM）。不降 debug：
// 文件 sink 只写 INFO+（logger.ts 的 writeToFile 跳过 DEBUG），降级等于让这条
// 崩溃恢复排查线索从日志现场消失。容量上限沿 renderer 侧 snapshot 信号去重的
// 先例（ipcService notifySnapshotRequired 的 256），插入序逐出最旧 key。
const LOGGED_INCOMPLETE_SNAPSHOT_KEYS = new Map<string, true>();
const MAX_LOGGED_INCOMPLETE_SNAPSHOT_KEYS = 256;

function shouldLogIncompleteSnapshot(data: PersistedSnapshot): boolean {
  const key = `${data.sessionId}:${data.runId}:${data.turnId}`;
  if (LOGGED_INCOMPLETE_SNAPSHOT_KEYS.has(key)) return false;
  LOGGED_INCOMPLETE_SNAPSHOT_KEYS.set(key, true);
  if (LOGGED_INCOMPLETE_SNAPSHOT_KEYS.size > MAX_LOGGED_INCOMPLETE_SNAPSHOT_KEYS) {
    const oldest = LOGGED_INCOMPLETE_SNAPSHOT_KEYS.keys().next().value;
    if (oldest !== undefined) LOGGED_INCOMPLETE_SNAPSHOT_KEYS.delete(oldest);
  }
  return true;
}

export interface StreamSnapshotIdentity {
  workingDir?: string;
  sessionId: string;
  runId: string;
  turnId: string;
}

export interface StreamSnapshotSelector {
  workingDir?: string;
  sessionId: string;
  runId?: string;
}

interface SnapshotOwner {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  workspace: string;
  sessionId: string;
  runId: string;
  claimedAt: number;
}

export interface PersistedSnapshot extends StreamSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  workspace: string;
  sessionId: string;
  runId: string;
  turnId: string;
  updatedAt: number;
  streamStatus: 'incomplete' | 'complete';
  stableForExecution: false;
  incompleteToolCallIds: string[];
  interruptionReason?: StreamInterruptionReason;
  /** Recovery is evidence-only. Tool execution must always start from a fresh model turn. */
  executionToolCalls: [];
}

/** Persist the stop cause before cancellation publishes a terminal session state. */
export function markStreamSnapshotInterruptionReason(
  selector: StreamSnapshotSelector,
  reason: StreamInterruptionReason,
): void {
  try {
    const owner = readOwner(selector);
    if (!owner) return;
    const filePath = getStreamSnapshotPath({
      ...selector,
      runId: owner.runId,
      turnId: '__mark_interruption__',
    });
    const snapshot = readJsonFile<PersistedSnapshot>(filePath);
    if (
      snapshot?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
      || snapshot.sessionId !== owner.sessionId
      || snapshot.runId !== owner.runId
      || snapshot.isFinal
    ) return;
    atomicWriteJson(filePath, {
      ...snapshot,
      interruptionReason: reason,
      updatedAt: Date.now(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Failed to mark stream snapshot interruption reason: ${message}`);
  }
}

function requireIdentityPart(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Stream snapshot ${name} must be non-empty`);
  return normalized;
}

function resolveWorkspace(workingDir?: string): string {
  const workspace = path.resolve(workingDir || process.cwd());
  return fs.realpathSync(workspace);
}

function encodeSnapshotSegment(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64url');
  if (encoded.length <= 120) return encoded;
  return `sha256-${createHash('sha256').update(value).digest('hex')}`;
}

function getSessionSnapshotDirectory(selector: Pick<StreamSnapshotSelector, 'workingDir' | 'sessionId'>): string {
  const workspace = resolveWorkspace(selector.workingDir);
  const sessionId = requireIdentityPart(selector.sessionId, 'sessionId');
  return path.join(workspace, CONFIG_DIR_NEW, SNAPSHOT_DIRECTORY, encodeSnapshotSegment(sessionId));
}

function getOwnerPath(selector: Pick<StreamSnapshotSelector, 'workingDir' | 'sessionId'>): string {
  return path.join(getSessionSnapshotDirectory(selector), OWNER_FILE);
}

export function getStreamSnapshotPath(identity: StreamSnapshotIdentity): string {
  const runId = requireIdentityPart(identity.runId, 'runId');
  return path.join(getSessionSnapshotDirectory(identity), `${encodeSnapshotSegment(runId)}.json`);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readOwner(selector: Pick<StreamSnapshotSelector, 'workingDir' | 'sessionId'>): SnapshotOwner | null {
  const owner = readJsonFile<SnapshotOwner>(getOwnerPath(selector));
  if (
    owner?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || owner.workspace !== resolveWorkspace(selector.workingDir)
    || owner.sessionId !== selector.sessionId.trim()
    || !owner.runId?.trim()
  ) {
    return null;
  }
  return owner;
}

function removeSnapshotFile(filePath: string): void {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(prefix) && entry.endsWith('.tmp')) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
}

function discardLegacySnapshot(workingDir?: string): void {
  const workspace = resolveWorkspace(workingDir);
  const legacyPath = path.join(workspace, CONFIG_DIR_NEW, LEGACY_SNAPSHOT_FILE);
  const legacyTmpPath = `${legacyPath}.tmp`;
  if (!fs.existsSync(legacyPath) && !fs.existsSync(legacyTmpPath)) return;
  fs.rmSync(legacyPath, { force: true });
  fs.rmSync(legacyTmpPath, { force: true });
  logger.warn('Discarded legacy unscoped stream snapshot; run identity was unavailable');
}

function activateStreamSnapshot(identity: StreamSnapshotIdentity): SnapshotOwner {
  const workspace = resolveWorkspace(identity.workingDir);
  const sessionId = requireIdentityPart(identity.sessionId, 'sessionId');
  const runId = requireIdentityPart(identity.runId, 'runId');
  const owner: SnapshotOwner = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    workspace,
    sessionId,
    runId,
    claimedAt: Date.now(),
  };
  const sessionDir = getSessionSnapshotDirectory(identity);
  fs.mkdirSync(sessionDir, { recursive: true });

  // The owner marker selects the only recoverable run. Older run files remain
  // physically isolated until the current owner settles, which lets a stale
  // callback clean only its own file without racing the new owner.
  atomicWriteJson(getOwnerPath(identity), owner);
  return owner;
}

function sanitizeToolArguments(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return JSON.stringify(sanitizeLogValue(parsed));
  } catch {
    return redactSecrets(argumentsJson).replace(
      /((?:"|')?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)(?:"|')?\s*:\s*(?:"|'))[^"']*/gi,
      '$1***REDACTED***',
    );
  }
}

function sanitizeSnapshotText(value: string): string {
  return redactSecrets(value).replace(
    /(\b(?:api[-_]?key|authorization|cookie|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1***REDACTED***',
  );
}

function sanitizeSnapshot(snapshot: StreamSnapshot): StreamSnapshot {
  return {
    ...snapshot,
    content: sanitizeSnapshotText(snapshot.content),
    reasoning: sanitizeSnapshotText(snapshot.reasoning),
    toolCalls: snapshot.toolCalls.map((toolCall) => ({
      ...toolCall,
      arguments: sanitizeToolArguments(toolCall.arguments),
    })),
  };
}

export function getIncompleteToolCallIds(snapshot: Pick<StreamSnapshot, 'toolCalls' | 'isFinal'>): string[] {
  if (snapshot.isFinal) return [];
  const incompleteIds: string[] = [];
  for (const toolCall of snapshot.toolCalls || []) {
    if (!toolCall.name || !toolCall.arguments) {
      incompleteIds.push(toolCall.id);
      continue;
    }
    try {
      JSON.parse(toolCall.arguments);
    } catch {
      incompleteIds.push(toolCall.id);
    }
  }
  return incompleteIds;
}

function writeOwnedSnapshot(snapshot: StreamSnapshot, identity: StreamSnapshotIdentity): boolean {
  const owner = readOwner(identity);
  if (owner?.runId !== identity.runId.trim()) {
    logger.debug('Ignored stream snapshot from stale run owner', {
      sessionId: identity.sessionId,
      runId: identity.runId,
      activeRunId: owner?.runId,
    });
    return false;
  }

  const sanitized = sanitizeSnapshot(snapshot);
  const incompleteToolCallIds = getIncompleteToolCallIds(sanitized);
  const filePath = getStreamSnapshotPath(identity);
  const previous = readJsonFile<PersistedSnapshot>(filePath);
  const interruptionReason = previous?.runId === owner.runId
    ? previous.interruptionReason
    : undefined;
  const data: PersistedSnapshot = {
    ...sanitized,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    workspace: owner.workspace,
    sessionId: owner.sessionId,
    runId: owner.runId,
    turnId: requireIdentityPart(identity.turnId, 'turnId'),
    updatedAt: Date.now(),
    streamStatus: sanitized.isFinal ? 'complete' : 'incomplete',
    stableForExecution: false,
    incompleteToolCallIds,
    ...(interruptionReason ? { interruptionReason } : {}),
    executionToolCalls: [],
  };
  atomicWriteJson(filePath, data);
  return true;
}

/** Save a snapshot and make this run the active recovery owner for direct callers. */
export function saveStreamSnapshot(snapshot: StreamSnapshot, identity: StreamSnapshotIdentity): void {
  try {
    discardLegacySnapshot(identity.workingDir);
    activateStreamSnapshot(identity);
    writeOwnedSnapshot(snapshot, identity);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Failed to save stream snapshot: ${message}`);
  }
}

/** Load evidence only for the currently owned run of a session. */
export function loadStreamSnapshot(selector: StreamSnapshotSelector): PersistedSnapshot | null {
  try {
    discardLegacySnapshot(selector.workingDir);
    const owner = readOwner(selector);
    if (!owner || (selector.runId && selector.runId.trim() !== owner.runId)) return null;

    const filePath = getStreamSnapshotPath({
      ...selector,
      runId: owner.runId,
      turnId: '__load__',
    });
    const data = readJsonFile<PersistedSnapshot>(filePath);
    if (
      data?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
      || data.workspace !== owner.workspace
      || data.sessionId !== owner.sessionId
      || data.runId !== owner.runId
      || data.isFinal
    ) {
      return null;
    }

    const incompleteToolCallIds = getIncompleteToolCallIds(data);
    if (shouldLogIncompleteSnapshot(data)) {
      logger.info('Found incomplete stream snapshot', {
        sessionId: data.sessionId,
        runId: data.runId,
        turnId: data.turnId,
        contentLength: data.content.length,
        toolCallCount: data.toolCalls.length,
        incompleteToolCallIds,
        timestamp: new Date(data.timestamp).toISOString(),
      });
    }
    return {
      ...data,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds,
      executionToolCalls: [],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Failed to load stream snapshot: ${message}`);
    return null;
  }
}

/** Clear only the named run. A stale owner cannot clear the active owner marker. */
export function clearStreamSnapshot(identity: StreamSnapshotIdentity): void {
  try {
    removeSnapshotFile(getStreamSnapshotPath(identity));
    const owner = readOwner(identity);
    if (owner?.runId === identity.runId.trim()) {
      fs.rmSync(getSessionSnapshotDirectory(identity), { recursive: true, force: true });
    }
  } catch {
    // Snapshot cleanup is best effort and must not fail the run.
  }
}

/** Create a callback permanently bound to one run owner. */
export function createSnapshotHandler(identity: StreamSnapshotIdentity): (snapshot: StreamSnapshot) => void {
  try {
    discardLegacySnapshot(identity.workingDir);
    activateStreamSnapshot(identity);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Failed to activate stream snapshot: ${message}`);
  }

  return (snapshot: StreamSnapshot) => {
    try {
      const accepted = writeOwnedSnapshot(snapshot, identity);
      if (accepted && snapshot.isFinal) clearStreamSnapshot(identity);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`Failed to save stream snapshot: ${message}`);
    }
  };
}
