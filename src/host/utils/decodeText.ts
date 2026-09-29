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

/** 合法 UTF-8 序列至少要解释这么大比例的高字节（≥0x80），才认作「UTF-8 + 坏字节」；防止满屏高字节的二进制 / 其它编码被当成文本 */
const UTF8_EXPLAINED_MIN = 0.5;
/** ASCII 字节数至少是高字节数的这么多倍，算「高字节稀疏」（源码 / 日志 / 英文为主的文本），此时不看 UTF8_EXPLAINED_MIN */
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

/** 宽松 UTF-8 解码 + 计数：invalid=坏序列数（原文里合法的 U+FFFD 不算）、validBytes=合法多字节序列占的字节数 */
function decodeLenientUtf8(body: Uint8Array): { text: string; invalid: number; validBytes: number } {
  const text = new TextDecoder('utf-8').decode(body);
  let replacements = 0;
  let validBytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfffd) replacements++;
    else if (cp > 0x7f) validBytes += cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  const literal = countBytes(body, [0xef, 0xbf, 0xbd]);
  return { text, invalid: Math.max(replacements - literal, 0), validBytes: validBytes + literal * 3 };
}

/** 高字节（≥0x80）个数，以及其中落在 GB2312 双字节对（首字节 A1-F7、次字节 A1-FE）里的个数 */
function scanGb2312Pairs(bytes: Uint8Array): { high: number; paired: number } {
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
 * 严格 UTF-8 失败后，判断这是不是「UTF-8 正文里夹了少量坏字节」（不是 GBK）。
 * 核心是两个假设比「谁解释了更多高字节」：
 * - UTF-8 假设：宽松解码里合法多字节序列占的字节数（validBytes）；
 * - GBK 假设：落在 GB2312 双字节对里的字节数（paired）。
 * validBytes ≥ paired（平局偏 UTF-8）才认 UTF-8。
 *   · 真 GBK 中文几乎全是 GB2312 对（paired≈全部），巧合成合法 UTF-8 序列的只有约一成 → GBK；
 *   · UTF-8 汉字里只有偶然的（首字节, 第一续字节）凑成对（≲一半字节），坏字节又凑不成对 → UTF-8；
 *   · `é` / `°` 这类 UTF-8 双字节与 GB2312 对字节层面完全不可分（C3 A9 = 「茅」），各算一份，平局偏 UTF-8，
 *     所以 ASCII 正文里几个 é 加一个坏字节不会被整段重解成「caf茅」；孤立坏字节（`don\x92t`、`\x80`、`\x81 0x20`）两边都是 0，同样平局 → UTF-8。
 * 再加一道守卫防垃圾：合法 UTF-8 序列要解释 ≥ 一半高字节，或高字节稀疏（ASCII ≥ 4×高字节），否则不当文本，交给 GB18030 / 报错。
 * 全部按剥 BOM 后的 body 算：BOM 有无不改变判定（BOM 是强 UTF-8 信号；「锘」+BF 开头的 GBK 只在严格 UTF-8 失败且本判据不成立时，用原始 buffer 走 GB18030）。
 * 判反的代价不对称：把 GBK 判成 UTF-8 会让 Read 出 U+FFFD、Append 把 UTF-8 拼进 GBK（Edit 因 invalidSequences 仍拒写）；
 * 把 UTF-8 判成 GBK 是 Read 乱码 + 锁写。
 * ponytail: 高字节不成 GB2312 对的 GBK（如 ASCII 主体里只夹一个 GBK 扩展区生僻字）会判成 UTF-8：
 * 那个字在 Read 里显示 U+FFFD，Append 不再拒。要收紧需外部信号（扩展名 / 用户声明），不在本单范围。
 */
function decodeCorruptedUtf8(body: Uint8Array): { text: string; invalidSequences: number } | null {
  const { text, invalid, validBytes } = decodeLenientUtf8(body);
  if (invalid === 0) return null;
  const { high, paired } = scanGb2312Pairs(body);
  if (validBytes < paired) return null;
  const sparse = body.length - high >= high * ASCII_TO_HIGH_BYTE_SPARSE_RATIO;
  if (!sparse && validBytes < high * UTF8_EXPLAINED_MIN) return null;
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
