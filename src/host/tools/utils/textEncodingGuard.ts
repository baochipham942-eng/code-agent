// ============================================================================
// textEncodingGuard - 写入前的编码保真守卫（N-READ-ENCODING）
// ============================================================================
//
// Edit/Write/Append 只会写 UTF-8。对已存在、且不是合法 UTF-8 的文件直接写，会悄悄改掉它的字节
// （Edit/Write 把坏字节变 U+FFFD 或整体转码，Append 把 UTF-8 拼进别的编码）。
// 判据只有一条、完全可判定：严格 UTF-8 能否解码。不猜它原本是 GBK 还是坏掉的 UTF-8，一律拒写，
// 把决定权交还给用户。新建文件不受影响（调用方只对已存在文件调用）。

import * as fs from 'fs/promises';
import { decodeUtf8 } from '../../utils/decodeText';

/** 只为查编码而整读的体积上限；超过则跳过检查（日志类大文件追加/覆盖不该被拖慢） */
const ENCODING_CHECK_MAX_BYTES = 32 * 1024 * 1024;

const NON_UTF8_REFUSAL =
  'This file is not valid UTF-8, so writing to it directly would change its bytes. ' +
  'The file was NOT modified. If a change is truly needed, get the user\'s consent first, convert the file to UTF-8 outside ' +
  'these tools (e.g. iconv via Bash), then retry.';

/** 返回拒写文案；可以写（已存在文件是合法 UTF-8，含 BOM）则返回 null。 */
export function existingFileWriteRefusal(existing: Buffer): string | null {
  return decodeUtf8(existing).invalidSequences > 0 ? NON_UTF8_REFUSAL : null;
}

/**
 * Write 覆盖 / Append 前的检查：只对普通文件、且不超过体积上限时整读判定。
 * 字符设备 / FIFO / 套接字（size 常为 0、没有 EOF）绝不 readFile，直接沿用原有写入；不存在的文件视为新建。
 */
export async function existingPathWriteRefusal(filePath: string): Promise<string | null> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile() || stat.size > ENCODING_CHECK_MAX_BYTES) return null;
  return existingFileWriteRefusal(await fs.readFile(filePath));
}
