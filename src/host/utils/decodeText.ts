// ============================================================================
// decodeText - 文本文件解码（资料库 / Read / 写入守卫共用）
// ============================================================================
//
// 只有两个确定性函数，没有任何「自动判 GBK」的启发式：
// - decodeUtf8：严格 UTF-8（剥 BOM）；不合法时返回宽松解码结果 + 坏序列数，由调用方决定怎么告知。
// - decodeGb18030：按调用方明确指定的编码严格解码，失败抛错。
//
// 为什么不猜：字节层面 UTF-8 的 `é`（C3 A9）与 GBK 的「茅」完全不可分，
// 「一个不合法的 UTF-8 文件原本是什么编码」没有可判定的答案，任何阈值/打分都有反例。

const UTF8_BOM = [0xef, 0xbb, 0xbf];

interface DecodedUtf8 {
  text: string;
  encoding: 'utf-8';
  /** 源文件是否带 UTF-8 BOM（text 已剥掉 BOM） */
  bom: boolean;
  /** 无法解码、已在 text 里替换成 U+FFFD 的坏字节序列数（0 = 合法 UTF-8）；原文里合法的 U+FFFD 不计入 */
  invalidSequences: number;
}

export class TextDecodeError extends Error {
  constructor() {
    super('Cannot decode as GBK/GB18030 (the file contains bytes that are not valid GB18030)');
    this.name = 'TextDecodeError';
  }
}

/**
 * 按字节扫描 UTF-8 坏序列数（与 WHATWG 解码器逐个产出 U+FFFD 的口径一致：
 * 一个「最大合法前缀」+ 失败字节各算一处；失败字节本身重新参与下一轮判定）。
 */
function countInvalidUtf8Sequences(bytes: Uint8Array): number {
  let invalid = 0;
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i];
    if (lead < 0x80) {
      i++;
      continue;
    }
    let trailing: number;
    let lower = 0x80;
    let upper = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) {
      trailing = 1;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      trailing = 2;
      if (lead === 0xe0) lower = 0xa0;
      if (lead === 0xed) upper = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      trailing = 3;
      if (lead === 0xf0) lower = 0x90;
      if (lead === 0xf4) upper = 0x8f;
    } else {
      invalid++;
      i++;
      continue;
    }
    let j = i + 1;
    for (; trailing > 0; trailing--, j++) {
      if (j >= bytes.length || bytes[j] < lower || bytes[j] > upper) break;
      lower = 0x80;
      upper = 0xbf;
    }
    if (trailing > 0) invalid++;
    i = j;
  }
  return invalid;
}

export function decodeUtf8(buffer: Buffer): DecodedUtf8 {
  const bom = buffer.length >= 3 && UTF8_BOM.every((byte, i) => buffer[i] === byte);
  const body = bom ? buffer.subarray(3) : buffer;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    return { text, encoding: 'utf-8', bom, invalidSequences: 0 };
  } catch {
    // 不是合法 UTF-8：宽松解码，坏字节成 U+FFFD，并数出坏序列数
  }
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(body);
  return { text, encoding: 'utf-8', bom, invalidSequences: countInvalidUtf8Sequences(body) };
}

/** 调用方明确指定 GBK 时的严格解码（GB18030 覆盖 GBK）；用原始 buffer，不剥 BOM 字节 */
export function decodeGb18030(buffer: Buffer): string {
  try {
    return new TextDecoder('gb18030', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new TextDecodeError();
  }
}
