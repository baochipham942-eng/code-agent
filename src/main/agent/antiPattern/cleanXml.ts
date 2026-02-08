// ============================================================================
// cleanXmlResidues — 清理工具参数中的 XML/HTML 标签残留
// 从 detector.ts 提取为独立函数，供 agentLoop 在工具执行前调用
// ============================================================================

/**
 * 递归清理值中的 XML/HTML 标签残留
 * 修复模型输出包含 <arg_key>、</tool_call> 等标签的问题
 */
export function cleanXmlResidues(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/<\/?\w+(?:_\w+)*\s*\/?>/g, '')  // <tag>, </tag>, <tag/>
      .replace(/<\w+[^>]*>/g, '')               // <tag attr="...">
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
