// ============================================================================
// decodeLibraryText - 资料库文本型文件的编码识别
// ============================================================================
//
// 顺序：剥 UTF-8 BOM → 严格 UTF-8 → 严格 GB18030（覆盖 GBK，国内 Excel 导出 CSV / 旧 Windows txt）。
// 全部用 fatal 解码：遇到非法字节直接抛错，绝不用 U+FFFD 兜底把乱码静默入库。

const UTF8_BOM = [0xef, 0xbb, 0xbf];

export function decodeLibraryText(buffer: Buffer): string {
  const hasBom = buffer.length >= 3 && UTF8_BOM.every((byte, i) => buffer[i] === byte);
  const body = hasBom ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    // 不是合法 UTF-8，继续尝试 GB18030
  }
  try {
    return new TextDecoder('gb18030', { fatal: true }).decode(body);
  } catch {
    throw new Error('无法识别文件编码（仅支持 UTF-8 / GBK）。请用记事本或 Excel 另存为 UTF-8 编码后重新导入');
  }
}
