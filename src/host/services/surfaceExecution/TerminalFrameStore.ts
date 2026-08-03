// ============================================================================
// Terminal Frame Store - 浏览器 surface 终态留影的盘上持久化
// ============================================================================
//
// PR #895 把终态最后一帧存进 renderer 内存 store（frameByScope），刷新/重启即丢。
// 本模块把同一帧随会话落盘：
//   <getUserConfigDir()>/surface-frames/<enc(conversationId)>/<enc(surfaceSessionId)>.jpg
// 会话隔离靠目录层级：读回必须 (conversationId, surfaceSessionId) 双键命中；
// 删除会话时整个 <enc(conversationId)>/ 子目录被清掉（挂在 sessionManager 删除收敛点）。
//
// 路径段一律 base64url 编码（先例：src/host/session/streamSnapshot.ts），防路径注入。
// ============================================================================

import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { getUserConfigDir } from '../../config/configPaths';
import { atomicWriteBuffer } from '../../tools/utils/atomicWrite';

const FRAMES_DIRECTORY = 'surface-frames';

/** id 上限：conversationId / surfaceSessionId 都是系统内部 id，256 已非常宽 */
const MAX_ID_LENGTH = 256;

export interface TerminalFrameSelector {
  conversationId: string;
  surfaceSessionId: string;
}

function requireIdSegment(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH) {
    throw new Error(`Terminal frame ${name} must be non-empty and <= ${MAX_ID_LENGTH} chars`);
  }
  return normalized;
}

/** 与 streamSnapshot.encodeSnapshotSegment 同款：base64url，过长退 sha256 */
function encodePathSegment(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64url');
  if (encoded.length <= 120) return encoded;
  return `sha256-${createHash('sha256').update(value).digest('hex')}`;
}

function isJpegBytes(bytes: Buffer): boolean {
  return bytes.length >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[bytes.length - 2] === 0xff
    && bytes[bytes.length - 1] === 0xd9;
}

export function getTerminalFrameDirectory(conversationId: string): string {
  const id = requireIdSegment(conversationId, 'conversationId');
  return path.join(getUserConfigDir(), FRAMES_DIRECTORY, encodePathSegment(id));
}

export function getTerminalFramePath(selector: TerminalFrameSelector): string {
  const surfaceId = requireIdSegment(selector.surfaceSessionId, 'surfaceSessionId');
  return path.join(
    getTerminalFrameDirectory(selector.conversationId),
    `${encodePathSegment(surfaceId)}.jpg`,
  );
}

/**
 * 落盘一帧终态留影。写前校验 JPEG SOI/EOI（FFD8…FFD9）——不是 JPEG 直接拒，
 * 盘上只会有可被 <img> 渲染的东西。
 */
export async function persistTerminalFrame(
  selector: TerminalFrameSelector,
  jpegBytes: Buffer,
): Promise<void> {
  if (!isJpegBytes(jpegBytes)) {
    throw new Error('Terminal frame payload is not a JPEG (missing FFD8 magic bytes)');
  }
  await atomicWriteBuffer(getTerminalFramePath(selector), jpegBytes);
}

/** 读回一帧；不存在或内容不是 JPEG 都返回 null（不抛）。 */
export async function readTerminalFrame(
  selector: TerminalFrameSelector,
): Promise<Buffer | null> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(getTerminalFramePath(selector));
  } catch {
    return null;
  }
  return isJpegBytes(bytes) ? bytes : null;
}

/**
 * 删掉某会话的全部留影帧（整个会话子目录）。幂等：目录不存在不报错。
 * 挂在会话删除收敛点上，「帧跟会话一起删」。
 */
export async function deleteTerminalFramesForConversation(conversationId: string): Promise<void> {
  await fs.rm(getTerminalFrameDirectory(conversationId), { recursive: true, force: true });
}

/** 清空全部会话/消息时删除整个留影根目录；幂等。 */
export async function deleteAllTerminalFrames(): Promise<void> {
  await fs.rm(path.join(getUserConfigDir(), FRAMES_DIRECTORY), { recursive: true, force: true });
}
