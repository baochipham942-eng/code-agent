// ============================================================================
// textEncodingGuard - 写入前的编码保真守卫（N-READ-ENCODING，方案 B）
// ============================================================================
//
// Read 能认 GBK/GB18030，但 Edit/Write/Append 只会写 UTF-8（Node 的 TextEncoder 不支持 GB18030，
// 且不许新增依赖）。对已存在的非 UTF-8 文件直接写会把整个文件悄悄转成 UTF-8，所以一律拒写，
// 让模型把决定权交还给用户。新建文件不受影响（调用方只对已存在文件调用）。

import { decodeText, TextDecodeError } from '../../utils/decodeText';

/** Append 只为查编码而整读的体积上限；超过则跳过检查（日志类大文件追加不该被拖慢） */
export const APPEND_ENCODING_CHECK_MAX_BYTES = 32 * 1024 * 1024;

const NON_UTF8_REFUSAL =
  'This file is GBK/GB18030-encoded. Edit/Write/Append can only write UTF-8, so modifying it directly ' +
  'would silently change its encoding. The file was NOT modified. If a change is truly needed, ask the user ' +
  'first whether to convert the file to UTF-8.';

/**
 * 返回拒写文案；可以写则返回 null。
 * - GB18030：一律拒写。
 * - 无法识别编码：`rejectUndecodable` 为 true（Edit，需要按文本改）时拒写，否则放行（Write 整体覆盖 / Append 不依赖解码）。
 */
export function existingFileWriteRefusal(
  existing: Buffer,
  opts: { rejectUndecodable?: boolean } = {},
): string | null {
  try {
    return decodeText(existing).encoding === 'gb18030' ? NON_UTF8_REFUSAL : null;
  } catch (err) {
    if (!(err instanceof TextDecodeError)) throw err;
    return opts.rejectUndecodable
      ? 'This file is not valid UTF-8 or GBK/GB18030 text, so Edit cannot safely modify it. The file was NOT modified.'
      : null;
  }
}
