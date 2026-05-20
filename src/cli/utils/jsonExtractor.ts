// ============================================================================
// JSON Extractor - 从 AI 响应文本中提取 JSON
// ============================================================================

import fs from 'fs';
import path from 'path';

/**
 * 从 AI 响应文本中提取 JSON 对象
 *
 * 提取策略（按优先级）：
 * 1. 查找 ```json ... ``` 代码块
 * 2. 尝试整个文本解析为 JSON
 * 3. 查找第一个 `{` 到最后一个 `}` 之间的内容
 * 4. Fallback: 文本里提到的 .json 文件路径，尝试读取并解析
 */
export function extractJSON(text: string, projectDir?: string): unknown | null {
  if (!text?.trim()) return null;

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

  // 策略 4：fallback —— 模型用 Write 工具落地了 JSON 文件，文本里只引用路径。
  // 扫文本里所有 .json 文件路径（绝对路径 / 相对路径 / markdown link / 反引号），
  // 按出现顺序逐个 try-read + parse，第一个解析成功就返回。
  // Why: 部分 thinking-mode 模型（如 mimo）倾向把大块 JSON 写到文件再短答复，
  // 不让 schema 校验空跑 retry 浪费 token。
  const filePaths = extractJsonFilePaths(text);
  for (const candidate of filePaths) {
    const resolved = resolveJsonPath(candidate, projectDir);
    if (!resolved) continue;
    try {
      const content = fs.readFileSync(resolved, 'utf8');
      const parsed: unknown = JSON.parse(content);
      return parsed;
    } catch {
      // 读不到或不是合法 JSON，继续下一个候选
    }
  }

  return null;
}

/**
 * 从文本中提取所有可能的 .json 文件路径候选。
 * 支持：absolute path、相对路径、markdown link `[name](path)`、反引号 path。
 */
function extractJsonFilePaths(text: string): string[] {
  const candidates = new Set<string>();
  // 通用 path 匹配：包含 / 或 \\，以 .json 结尾
  const pathRegex = /[`(\s"'[](\/?[\w./\\-]+\.json)(?=[`)\]\s"',]|$)/g;
  let match;
  while ((match = pathRegex.exec(text)) !== null) {
    candidates.add(match[1]);
  }
  return Array.from(candidates);
}

function resolveJsonPath(candidate: string, projectDir?: string): string | null {
  try {
    if (path.isAbsolute(candidate)) {
      return fs.existsSync(candidate) ? candidate : null;
    }
    const base = projectDir || process.cwd();
    const resolved = path.resolve(base, candidate);
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}
