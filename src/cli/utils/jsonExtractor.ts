// ============================================================================
// JSON Extractor - 从 AI 响应文本中提取 JSON
// ============================================================================

/**
 * 从 AI 响应文本中提取 JSON 对象
 *
 * 提取策略（按优先级）：
 * 1. 查找 ```json ... ``` 代码块
 * 2. 尝试整个文本解析为 JSON
 * 3. 查找第一个 `{` 到最后一个 `}` 之间的内容
 */
export function extractJSON(text: string): unknown | null {
  if (!text || !text.trim()) return null;

  // 策略 1：提取 ```json ... ``` 代码块
  const codeBlockMatch = text.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // 代码块内容不是有效 JSON，继续尝试其他策略
    }
  }

  // 策略 2：尝试整个文本解析为 JSON
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // 不是有效 JSON，继续
    }
  }

  // 策略 3：查找第一个 `{` 到最后一个 `}` 之间的内容
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.substring(firstBrace, lastBrace + 1));
    } catch {
      // 提取的内容不是有效 JSON
    }
  }

  // 策略 3b：数组场景，查找 `[` 到 `]`
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.substring(firstBracket, lastBracket + 1));
    } catch {
      // 提取的内容不是有效 JSON
    }
  }

  return null;
}
