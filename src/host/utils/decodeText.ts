// ============================================================================
// decodeText - 文本文件编码识别（资料库 / Read 工具共用）
// ============================================================================
//
// 顺序：剥 UTF-8 BOM → 严格 UTF-8 → 严格 GB18030（覆盖 GBK，国内 Excel 导出 CSV / 旧 Windows txt）。
// 全部用 fatal 解码：遇到非法字节直接抛错，绝不用 U+FFFD 兜底把乱码静默交给下游。

const UTF8_BOM = [0xef, 0xbb, 0xbf];

export interface DecodedText {
  text: string;
  encoding: 'utf-8' | 'gb18030';
  /** 源文件是否带 UTF-8 BOM（text 已剥掉 BOM） */
  bom: boolean;
}

export class TextDecodeError extends Error {
  constructor() {
    super('Unrecognized text encoding (only UTF-8 and GBK/GB18030 are supported)');
    this.name = 'TextDecodeError';
  }
}

export function decodeText(buffer: Buffer): DecodedText {
  const bom = buffer.length >= 3 && UTF8_BOM.every((byte, i) => buffer[i] === byte);
  const body = bom ? buffer.subarray(3) : buffer;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8', bom };
  } catch {
    // 不是合法 UTF-8，继续尝试 GB18030
  }
  try {
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(body), encoding: 'gb18030', bom };
  } catch {
    throw new TextDecodeError();
  }
}
