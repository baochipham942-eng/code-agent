// ============================================================================
// cleanXmlResidues — 清理工具参数中的 XML 协议标签残留
// 从 detector.ts 提取为独立函数，供 agentLoop 在工具执行前调用
// ============================================================================

/**
 * 已知的模型 XML 协议标签（下划线命名风格，不会与合法 HTML 冲突）
 * 例如: <arg_key>, </arg_value>, <tool_call>, </tool_result>
 */
const XML_PROTOCOL_TAG = /<\/?\w+_\w+(?:_\w+)*\s*\/?>/g;

/**
 * 递归清理值中的 XML 协议标签残留
 * 只清理已知的模型协议标签（含下划线的 XML 标签），保留合法的 HTML 标签
 *
 * 清理: <arg_key>, </arg_value>, <tool_call>, </tool_result>, <function_call>
 * 保留: <html>, <style>, <div class="...">, <h1>, <meta charset="UTF-8">
 */
export function cleanXmlResidues(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(XML_PROTOCOL_TAG, '')
      .trim();
  }
  if (Array.isArray(value)) {
    return value.map(v => cleanXmlResidues(v));
  }
  if (value && typeof value === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      cleaned[k] = cleanXmlResidues(v);
    }
    return cleaned;
  }
  return value;
}
