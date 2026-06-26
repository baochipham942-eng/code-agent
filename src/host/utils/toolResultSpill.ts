// ============================================================================
// Tool Result Spill — 大工具结果落盘 (GAP-009)
// ============================================================================
// 所有截断点（bash 30K chars / MCP 50K chars / L1 budget 2000 tokens）在截断前
// 调用 spillToolResult，把完整输出写入 session 临时目录，截断文本尾部附加路径提示，
// 模型可用 Read/Grep 零成本回查完整输出，不必重跑命令。
//
// 设计原则：
// - best-effort：落盘失败绝不影响工具结果本身（返回 null，调用方跳过提示）
// - 防重复：已带落盘提示的内容跳过（L1 budget 不会对 bash 已落盘的结果二次落盘）
// - 不引入 logger 依赖，保持 import 图最小（toolResultBudget 等纯函数层也要用）
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { getUserConfigDir } from '../config/configPaths';
import { TOOL_RESULT_SPILL } from '../../shared/constants';

/** 落盘提示的标识前缀（同时用于防止重复落盘 + 压缩层豁免），常量定义见 TOOL_RESULT_SPILL */
export const SPILL_NOTICE_MARKER: string = TOOL_RESULT_SPILL.NOTICE_MARKER;

export interface SpillOptions {
  /** 完整输出内容 */
  content: string;
  /** 工具名（用于文件名） */
  toolName: string;
  /** 会话 ID（用于目录隔离），缺省落到 shared 目录 */
  sessionId?: string;
  /** 工具调用 ID（用于文件名唯一性），缺省用时间戳 */
  toolCallId?: string;
  /** 原始 transcript/message id；L1 projection 里用于回绑证据来源 */
  sourceMessageId?: string;
  /** 落盘原因，写入 archive ref，方便后续审计和 hydrate 策略判断 */
  reason?: string;
}

export interface ToolResultArchiveRef {
  version: 1;
  artifactId: string;
  filePath: string;
  toolName: string;
  sessionId: string;
  sha256: string;
  bytes: number;
  createdAt: number;
  reason: string;
  toolCallId?: string;
  sourceMessageId?: string;
}

export interface ToolResultSpillResult {
  filePath: string;
  archiveRef: ToolResultArchiveRef;
}

/** 路径片段消毒：防止 sessionId / toolName 里的特殊字符构造出意外路径（含 .. 遍历 / 隐藏目录） */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^\.+/, '_');
}

/** 获取 session 的工具结果落盘目录：~/.code-agent/tmp/<session>/tool-results/ */
export function getToolResultSpillDir(sessionId?: string): string {
  return path.join(
    getUserConfigDir(),
    TOOL_RESULT_SPILL.TMP_DIR,
    sanitizeSegment(sessionId || TOOL_RESULT_SPILL.SHARED_SESSION),
    TOOL_RESULT_SPILL.SUBDIR,
  );
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function getArchiveMetadataPath(filePath: string): string {
  return `${filePath}.archive.json`;
}

function buildArtifactId(options: {
  toolName: string;
  sessionId: string;
  toolCallId?: string;
  sourceMessageId?: string;
  hash: string;
}): string {
  const stableSource = options.toolCallId || options.sourceMessageId || String(Date.now());
  return [
    'tool_result',
    sanitizeSegment(options.sessionId),
    sanitizeSegment(options.toolName),
    sanitizeSegment(stableSource),
    options.hash.slice(0, 12),
  ].join(':');
}

/**
 * 把超长工具输出写入磁盘并生成可验证 ArchiveRef；失败或跳过时返回 null。
 *
 * 跳过条件：
 * - 内容为空
 * - 内容已包含落盘提示（防止逐层重复落盘）
 * - 内容超过 MAX_SPILL_BYTES（防止写爆磁盘）
 */
export function spillToolResultArchive(options: SpillOptions): ToolResultSpillResult | null {
  const { content, toolName, sessionId, toolCallId, sourceMessageId } = options;
  if (!content) return null;
  if (content.includes(SPILL_NOTICE_MARKER)) return null;
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > TOOL_RESULT_SPILL.MAX_SPILL_BYTES) return null;

  try {
    const dir = getToolResultSpillDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const contentHash = sha256(content);
    const resolvedSessionId = sessionId || TOOL_RESULT_SPILL.SHARED_SESSION;
    const sourcePart = toolCallId || sourceMessageId || String(Date.now());
    const fileName = `${sanitizeSegment(toolName)}-${sanitizeSegment(sourcePart)}-${contentHash.slice(0, 12)}.txt`;
    const filePath = path.join(dir, fileName);
    const archiveRef: ToolResultArchiveRef = {
      version: 1,
      artifactId: buildArtifactId({
        toolName,
        sessionId: resolvedSessionId,
        toolCallId,
        sourceMessageId,
        hash: contentHash,
      }),
      filePath,
      toolName,
      sessionId: resolvedSessionId,
      sha256: contentHash,
      bytes,
      createdAt: Date.now(),
      reason: options.reason || 'tool-result-spill',
      ...(toolCallId ? { toolCallId } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
    };
    fs.writeFileSync(filePath, content, 'utf-8');
    fs.writeFileSync(getArchiveMetadataPath(filePath), JSON.stringify(archiveRef, null, 2), 'utf-8');
    return { filePath, archiveRef };
  } catch {
    // 落盘是增强而非保障，任何 fs 错误（磁盘满/权限/只读环境）都静默降级为纯截断
    return null;
  }
}

/** 兼容旧调用方：只需要路径时仍返回文件路径，但底层会写 ArchiveRef sidecar。 */
export function spillToolResult(options: SpillOptions): string | null {
  return spillToolResultArchive(options)?.filePath ?? null;
}

export interface ToolResultArchiveReadResult {
  content: string;
  archiveRef: ToolResultArchiveRef;
}

/** 读取并校验 archived tool result；hash/bytes/session/path 任一不匹配都拒绝返回。 */
export function readToolResultArchive(archiveRef: ToolResultArchiveRef): ToolResultArchiveReadResult | null {
  try {
    const expectedDir = path.resolve(getToolResultSpillDir(archiveRef.sessionId));
    const resolvedFilePath = path.resolve(archiveRef.filePath);
    if (resolvedFilePath !== expectedDir && !resolvedFilePath.startsWith(`${expectedDir}${path.sep}`)) {
      return null;
    }

    const content = fs.readFileSync(resolvedFilePath, 'utf-8');
    const bytes = Buffer.byteLength(content, 'utf-8');
    if (bytes !== archiveRef.bytes) return null;
    if (sha256(content) !== archiveRef.sha256) return null;

    return { content, archiveRef };
  } catch {
    return null;
  }
}

function parseArchiveSessionId(artifactId: string): string | null {
  const parts = artifactId.split(':');
  return parts.length >= 2 && parts[0] === 'tool_result' ? parts[1] : null;
}

function readArchiveRefSidecar(filePath: string): ToolResultArchiveRef | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ToolResultArchiveRef;
    if (parsed?.version !== 1 || typeof parsed.artifactId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 在当前 session/shared/session-encoded artifactId 下查找 archive ref sidecar。 */
export function findToolResultArchiveRef(
  artifactId: string,
  sessionId?: string,
): ToolResultArchiveRef | null {
  const parsedSessionId = parseArchiveSessionId(artifactId);
  const candidateSessionIds = Array.from(
    new Set(
      [sessionId, parsedSessionId, TOOL_RESULT_SPILL.SHARED_SESSION]
        .filter((value): value is string => Boolean(value)),
    ),
  );

  for (const candidateSessionId of candidateSessionIds) {
    const dir = getToolResultSpillDir(candidateSessionId);
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.archive.json')) continue;
        const archiveRef = readArchiveRefSidecar(path.join(dir, entry.name));
        if (archiveRef?.artifactId === artifactId) return archiveRef;
      }
    } catch {
      // Missing session archive directory is normal.
    }
  }

  return null;
}

/** 构造落盘路径提示文本（附加在截断输出尾部，模型可见） */
export function buildSpillNotice(filePathOrRef: string | ToolResultArchiveRef): string {
  if (typeof filePathOrRef === 'string') {
    return `\n${SPILL_NOTICE_MARKER} ${filePathOrRef} — use Read/Grep on this file to inspect the full output.]`;
  }
  return (
    `\n${SPILL_NOTICE_MARKER} ${filePathOrRef.filePath} — ` +
    `archive=${filePathOrRef.artifactId}; sha256=${filePathOrRef.sha256.slice(0, 12)}; bytes=${filePathOrRef.bytes}; ` +
    'use Read/Grep on this file to inspect the full output.]'
  );
}
