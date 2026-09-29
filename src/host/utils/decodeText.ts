// ============================================================================
// decodeText - 文本文件编码识别（资料库 / Read 工具共用）
// ============================================================================
//
// 顺序：严格 UTF-8（剥 BOM）→ 「偶有坏字节的 UTF-8」判定 → 严格 GB18030（覆盖 GBK，国内 Excel 导出 CSV / 旧 Windows txt）。
// 除「偶有坏字节的 UTF-8」外全部 fatal 解码：遇到非法字节直接抛错，绝不静默把乱码交给下游。
//
// 为什么要单独判「偶有坏字节的 UTF-8」：GB18030 几乎能「成功」解开任意字节序列，UTF-8 正文里混进一个坏字节
// （单个 0x80、0x92 后接字母）就会被整段重解成 GBK 乱码。判据见 looksLikeCorruptedUtf8。

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const REPLACEMENT_CHAR = '\uFFFD';

/** 宽松 UTF-8 下，有效非 ASCII 字符数至少是坏序列数的这么多倍，才认作「UTF-8 + 少量坏字节」 */
const UTF8_VALID_TO_INVALID_MIN_RATIO = 4;

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

/**
 * 严格 UTF-8 已失败后，判断这是不是「UTF-8 正文里夹了少量坏字节」。
 * 宽松解码后数两样：U+FFFD 个数（坏序列）与有效的非 ASCII 字符个数（真多字节序列）。
 * 有效字符 ≥ 4×坏序列且至少 1 个 → 认作 UTF-8。
 * 真 GBK 的双字节绝大多数不是合法 UTF-8 序列，宽松解码几乎全是 U+FFFD；只有约一成的字对巧合成合法 2 字节序列，
 * 所以 有效/坏 ≈ 0.1（3000 条随机 GBK 语料实测上限 2）；而 UTF-8 里偶有坏字节时比值是几十到几千。4 落在两者之间。
 * 判反的代价不对称：把 GBK 判成 UTF-8 会放开 Edit 并把整文件写成 U+FFFD（数据损坏），
 * 所以阈值偏严；把 UTF-8 判成 GBK 只是 Read 乱码 + 拒写（可恢复）。
 */
function decodeCorruptedUtf8(body: Uint8Array): { text: string; invalidSequences: number } | null {
  const text = new TextDecoder('utf-8').decode(body);
  let invalid = 0;
  let valid = 0;
  for (const ch of text) {
    if (ch === REPLACEMENT_CHAR) invalid++;
    else if (ch.charCodeAt(0) > 0x7f) valid++;
  }
  if (valid === 0 || valid < invalid * UTF8_VALID_TO_INVALID_MIN_RATIO) return null;
  return { text, invalidSequences: invalid };
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
  const corrupted = decodeCorruptedUtf8(body);
  if (corrupted) return { ...corrupted, encoding: 'utf-8', bom };
  try {
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(buffer), encoding: 'gb18030', bom: false, invalidSequences: 0 };
  } catch {
    throw new TextDecodeError();
  }
}
