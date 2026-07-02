// telemetry/failure-journal 提取文本可能带 HTML 实体转义（&gt; 等），
// 渲染前反转义，避免对话流/开发者详情里出现转义符乱码。
const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

export function unescapeHtmlEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => HTML_ENTITY_MAP[entity] ?? entity);
}
