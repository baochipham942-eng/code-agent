// ============================================================================
// decodeText - 文本文件编码识别（资料库 / Read 工具共用）
// ============================================================================
//
// 顺序：严格 UTF-8（剥 BOM）→ 「偶有坏字节的 UTF-8」判定 → 严格 GB18030（覆盖 GBK，国内 Excel 导出 CSV / 旧 Windows txt）。
// 除「偶有坏字节的 UTF-8」外全部 fatal 解码：遇到非法字节直接抛错，绝不静默把乱码交给下游。
//
// 为什么要单独判「偶有坏字节的 UTF-8」：GB18030 几乎能「成功」解开任意字节序列，UTF-8 正文里混进一个坏字节
// （单个 0x80、0x92 后接字母）就会被整段重解成 GBK 乱码。判据见 decodeCorruptedUtf8。

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const REPLACEMENT_CHAR = '\uFFFD';

/** 宽松 UTF-8 下，有效非 ASCII 字符数至少是坏序列数的这么多倍，直接认作「UTF-8 + 少量坏字节」 */
const UTF8_VALID_TO_INVALID_MIN_RATIO = 4;
/** 高字节里落在 GB2312 双字节对的比例达到这个值，才像 GBK（真 GBK 中文 ≈1，UTF-8 里的巧合对 ≲0.5） */
const GB2312_COVERAGE_MIN = 0.8;
/** 宽松 UTF-8 下，高字节里属于合法 UTF-8 序列的比例达到这个值，才认作 UTF-8 */
const UTF8_COVERAGE_MIN = 0.5;
/** ASCII 字节数至少是高字节（≥0x80）数的这么多倍，算「高字节稀疏」（源码 / 日志 / 英文为主的文本） */
const ASCII_TO_HIGH_BYTE_SPARSE_RATIO = 4;

export interface DecodedText {
  text: string;
  encoding: 'utf-8' | 'gb18030';
  /** 源文件是否带 UTF-8 BOM（text 已剥掉 BOM；GB18030 文件恒为 false） */
  bom: boolean;
  /** 仅 UTF-8：无法解码、已在 text 里替换成 U+FFFD 的坏字节序列数（0 = 干净） */
  invalidSequences: number;
}

export class TextDecodeError extends Error {
  constructor() {
    super('Unrecognized text encoding (only UTF-8 and GBK/GB18030 are supported)');
    this.name = 'TextDecodeError';
  }
}

function countBytes(bytes: Uint8Array, needle: number[]): number {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pattern = Buffer.from(needle);
  let count = 0;
  for (let at = buf.indexOf(pattern); at !== -1; at = buf.indexOf(pattern, at + pattern.length)) count++;
  return count;
}

/** 宽松 UTF-8 解码 + 计数：invalid=坏序列数（原文里合法的 U+FFFD 不算）、valid=有效非 ASCII 字符数、validBytes=它们占的字节数 */
function decodeLenientUtf8(body: Uint8Array): { text: string; invalid: number; valid: number; validBytes: number } {
  const text = new TextDecoder('utf-8').decode(body);
  let replacements = 0;
  let valid = 0;
  let validBytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfffd) replacements++;
    else if (cp > 0x7f) {
      valid++;
      validBytes += cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
  }
  const literal = countBytes(body, [0xef, 0xbf, 0xbd]);
  return { text, invalid: Math.max(replacements - literal, 0), valid: valid + literal, validBytes: validBytes + literal * 3 };
}

/** 高字节（≥0x80）个数，以及其中落在 GB2312 双字节对（首字节 A1-F7、次字节 A1-FE）里的个数 */
function scanGb2312Coverage(bytes: Uint8Array): { high: number; paired: number } {
  let high = 0;
  let paired = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] < 0x80) continue;
    const trail = bytes[i + 1];
    if (bytes[i] >= 0xa1 && bytes[i] <= 0xf7 && trail !== undefined && trail >= 0xa1 && trail <= 0xfe) {
      high += 2;
      paired += 2;
      i++;
    } else {
      high++;
    }
  }
  return { high, paired };
}

/**
 * 严格 UTF-8 失败后，判断这是不是「UTF-8 正文里夹了少量坏字节」（不是 GBK）。两条腿，满足任一即认 UTF-8：
 * ① 占比：宽松解码后，有效非 ASCII 字符 ≥ 4×坏序列且至少 1 个。
 *    真 GBK 的双字节绝大多数不是合法 UTF-8 序列，宽松解码几乎全是 U+FFFD，只有约一成的字对巧合成合法 2 字节序列，
 *    所以 有效/坏 ≈ 0.1（3000 条随机 GBK 语料实测上限 2）；文件较长时 UTF-8 偶有坏字节的比值是几十以上。
 * ② 覆盖率（短文件 / ASCII 主体，占比帮不上）：看「高字节像谁」——
 *    真 GBK 的中文几乎全是 GB2312 双字节对（覆盖率 ≈1）；UTF-8 的 3 字节汉字里只有偶然的 (首字节, 第一续字节) 凑成对（≲0.5）；
 *    孤立坏字节（`don\x92t`、`\x80`、`\x81 0x20`）凑不成对（0）。所以「GB2312 覆盖率 < 0.8」且
 *    （合法 UTF-8 序列覆盖了 ≥ 一半高字节，或高字节稀疏即 ASCII ≥ 4×高字节）→ UTF-8。
 * GBK 假设看原始 buffer（含 BOM 那 3 字节，因为「锘」+BF 开头的 GBK 文件前三字节恰为 EF BB BF）；UTF-8 假设看剥 BOM 后的 body。
 * 判反的代价不对称：把 GBK 判成 UTF-8 会让 Read 出 U+FFFD、Append 把 UTF-8 拼进 GBK（Edit 因 invalidSequences 仍拒写）；
 * 把 UTF-8 判成 GBK 是 Read 乱码 + 锁写。两边都可恢复但前者更隐蔽，故阈值偏严。
 * ponytail: ASCII 主体的 GBK 文件若含大量 GB2312 之外的字（GBK 扩展区，覆盖率 < 0.8），会判成 UTF-8：
 * 那几个字在 Read 里显示 U+FFFD，Append 不再拒。要收紧需外部信号（扩展名 / 用户声明），不在本单范围。
 */
function decodeCorruptedUtf8(buffer: Uint8Array, body: Uint8Array): { text: string; invalidSequences: number } | null {
  const { text, invalid, valid, validBytes } = decodeLenientUtf8(body);
  if (invalid === 0) return null;
  const corrupted = { text, invalidSequences: invalid };
  if (valid > 0 && valid >= invalid * UTF8_VALID_TO_INVALID_MIN_RATIO) return corrupted;
  const { high, paired } = scanGb2312Coverage(buffer);
  if (high > 0 && paired / high >= GB2312_COVERAGE_MIN) return null;
  const bodyHigh = scanGb2312Coverage(body).high;
  const sparse = body.length - bodyHigh >= bodyHigh * ASCII_TO_HIGH_BYTE_SPARSE_RATIO;
  if (sparse || (bodyHigh > 0 && validBytes / bodyHigh >= UTF8_COVERAGE_MIN)) return corrupted;
  return null;
}

export function decodeText(buffer: Buffer): DecodedText {
  const bom = buffer.length >= 3 && UTF8_BOM.every((byte, i) => buffer[i] === byte);
  // BOM 只对 UTF-8 路径有意义；GB18030 必须用原始 buffer（「锘」+ BF 开头的 GBK 文件前三字节恰为 EF BB BF）
  const body = bom ? buffer.subarray(3) : buffer;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8', bom, invalidSequences: 0 };
  } catch {
    // 不是干净的 UTF-8，继续判断
  }
  const corrupted = decodeCorruptedUtf8(buffer, body);
  if (corrupted) return { ...corrupted, encoding: 'utf-8', bom };
  try {
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(buffer), encoding: 'gb18030', bom: false, invalidSequences: 0 };
  } catch {
    throw new TextDecodeError();
  }
}
