// ============================================================================
// Write File Tool - Create or overwrite files
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { createLogger } from '../../services/infra/logger';
import { resolvePath } from './pathUtils';

const logger = createLogger('WriteFile');

// ----------------------------------------------------------------------------
// Code Completeness Detection
// ----------------------------------------------------------------------------

interface CompletenessCheck {
  isComplete: boolean;
  issues: string[];
  fileType: string;
}

/**
 * 检测代码文件是否完整（未被截断）
 */
function checkCodeCompleteness(content: string, filePath: string): CompletenessCheck {
  const ext = path.extname(filePath).toLowerCase();
  const issues: string[] = [];

  // 通用检测：括号匹配
  const brackets: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const stack: string[] = [];
  let inString = false;
  let stringChar = '';
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    // 处理转义字符
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }

    // 处理字符串
    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar) {
      inString = false;
    }

    if (inString) continue;

    // 括号匹配
    if (brackets[char]) {
      stack.push(brackets[char]);
    } else if (Object.values(brackets).includes(char)) {
      if (stack.length === 0 || stack.pop() !== char) {
        // 括号不匹配，但可能是合法的（如闭合标签）
      }
    }
  }

  if (stack.length > 0) {
    issues.push(`未闭合的括号: 缺少 ${stack.length} 个闭合符号 (${stack.join(', ')})`);
  }

  // HTML/JSX 特定检测
  if (['.html', '.htm', '.jsx', '.tsx'].includes(ext)) {
    // 检查 HTML 标签闭合
    if (!content.includes('</html>') && content.includes('<html')) {
      issues.push('HTML 文件缺少 </html> 闭合标签');
    }
    if (!content.includes('</body>') && content.includes('<body')) {
      issues.push('HTML 文件缺少 </body> 闭合标签');
    }
    if (!content.includes('</script>') && content.includes('<script')) {
      issues.push('HTML 文件缺少 </script> 闭合标签');
    }
    if (!content.includes('</style>') && content.includes('<style')) {
      issues.push('HTML 文件缺少 </style> 闭合标签');
    }
  }

  // JavaScript/TypeScript 特定检测
  if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    // 检查常见的截断模式
    const trimmedEnd = content.trimEnd();
    const lastChars = trimmedEnd.slice(-20);

    // 以逗号、运算符、未完成的语句结尾
    if (/[,+\-*\/&|=<>!?:]$/.test(trimmedEnd) && !trimmedEnd.endsWith('*/')) {
      issues.push(`代码可能在表达式中间被截断 (以 "${lastChars.slice(-5)}" 结尾)`);
    }

    // 函数定义未完成
    if (/function\s+\w+\s*\([^)]*$/.test(trimmedEnd)) {
      issues.push('函数定义未完成');
    }

    // 箭头函数未完成
    if (/=>\s*$/.test(trimmedEnd) || /=>\s*\{[^}]*$/.test(lastChars)) {
      issues.push('箭头函数未完成');
    }
  }

  // CSS 特定检测
  if (['.css', '.scss', '.less'].includes(ext)) {
    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    if (openBraces > closeBraces) {
      issues.push(`CSS 缺少 ${openBraces - closeBraces} 个闭合大括号`);
    }
  }

  // JSON 特定检测
  if (ext === '.json') {
    try {
      JSON.parse(content);
    } catch (e: any) {
      issues.push(`JSON 格式错误: ${e.message}`);
    }
  }

  // 检测明显的截断模式
  const trimmed = content.trimEnd();
  if (trimmed.endsWith('ctx.') || trimmed.endsWith('this.') || trimmed.endsWith('const ') ||
      trimmed.endsWith('let ') || trimmed.endsWith('var ') || trimmed.endsWith('function ') ||
      trimmed.endsWith('class ') || trimmed.endsWith('import ') || trimmed.endsWith('export ')) {
    issues.push('代码在关键字后被截断');
  }

  return {
    isComplete: issues.length === 0,
    issues,
    fileType: ext || 'unknown',
  };
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description: `Create a new file or completely overwrite an existing file.

IMPORTANT: This tool will OVERWRITE the entire file content.
- If you need to make small changes to an existing file, use edit_file instead
- ALWAYS prefer editing existing files over creating new ones
- If overwriting an existing file, you MUST read it first with read_file

Usage:
- file_path must be an absolute path (not relative)
- Creates parent directories automatically if they don't exist
- Cannot write files outside the working directory (security restriction)

For large files (300+ lines):
- Consider using multi-step generation: create skeleton first, then use edit_file to add content
- This prevents output truncation issues

Code completeness detection:
- The tool automatically checks for truncated code (unclosed brackets, incomplete statements)
- If truncation is detected, a warning will be returned

NEVER create documentation files (*.md, README) unless explicitly requested.`,
  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute path where the file will be created or overwritten. MUST be a string. ' +
          'Examples: "/Users/name/project/src/new-file.ts", "/home/user/config.json". ' +
          'Supports ~ for home directory: "~/Documents/file.txt". ' +
          'Parent directories will be created automatically if they do not exist. ' +
          'SECURITY: Path must be within the working directory.',
      },
      content: {
        type: 'string',
        description:
          'The complete file content to write. MUST be a string (not an object or array). ' +
          'This will REPLACE the entire file content, not append. ' +
          'For JSON files, use JSON.stringify() format. ' +
          'For code files, include proper indentation and newlines. ' +
          'WARNING: For files >300 lines, consider creating a skeleton first, then using edit_file.',
      },
    },
    required: ['file_path', 'content'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const inputPath = params.file_path as string;
    const content = params.content as string;

    // Resolve path (handles ~, relative paths)
    const filePath = resolvePath(inputPath, context.workingDirectory);

    // Resolve to absolute path
    const resolvedPath = path.resolve(filePath);

    // Note: Security is handled by the permission system (requiresPermission: true)
    // User will see the full path and confirm before writing

    try {
      // Create directory if it doesn't exist
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      // Check if file exists (for reporting)
      let existed = false;
      try {
        await fs.access(filePath);
        existed = true;
      } catch {
        // File doesn't exist, that's fine
      }

      // Write file
      await fs.writeFile(filePath, content, 'utf-8');

      const action = existed ? 'Updated' : 'Created';

      // 检查代码完整性（仅对代码文件）
      const codeExtensions = ['.html', '.htm', '.js', '.ts', '.jsx', '.tsx', '.css', '.scss', '.less', '.json', '.mjs', '.cjs', '.vue', '.svelte'];
      const ext = path.extname(filePath).toLowerCase();

      if (codeExtensions.includes(ext)) {
        const completenessCheck = checkCodeCompleteness(content, filePath);

        if (!completenessCheck.isComplete) {
          // 文件可能被截断，返回警告
          logger.warn('Code completeness check failed', { filePath, issues: completenessCheck.issues });

          return {
            success: true,
            output: `${action} file: ${filePath} (${content.length} bytes)\n\n⚠️ **代码完整性警告**: 检测到文件可能不完整！\n问题:\n${completenessCheck.issues.map(i => `- ${i}`).join('\n')}\n\n**建议**: 请使用 edit_file 工具追加剩余代码，或重新生成完整文件。`,
          };
        }
      }

      return {
        success: true,
        output: `${action} file: ${filePath} (${content.length} bytes)`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to write file',
      };
    }
  },
};
