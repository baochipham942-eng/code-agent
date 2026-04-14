// ============================================================================
// Write (P0-6.3 Batch 1 — file-core: native ToolModule rewrite)
//
// 旧版: src/main/tools/file/write.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger（不 import services/infra/logger）
// - 行为保真：
//   * 父目录自动创建（recursive mkdir）
//   * 原子写（atomicWriteFile: temp + rename）
//   * 资源锁（getResourceLockManager 独占锁，60s 持有 + 10s 等待）
//   * 代码完整性检测（未闭合括号 / HTML/JSX 标签 / CSS 大括号 / JSON 解析 /
//     截断关键字）—— 检测到问题时仍返回 success=true 并在 output 前置警告
//   * LSP 诊断闭环（getPostEditDiagnostics 写入后追加诊断）
//   * existed 判断选 Created 还是 Updated
// - 注意：file checkpoint 由 toolExecutor 上游统一处理，工具内部不调 checkpoint
// ============================================================================

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { atomicWriteFile } from '../../utils/atomicWrite';
import { getResourceLockManager } from '../../../services/infra/resourceLockManager';
import { getPostEditDiagnostics } from '../../lsp/diagnosticsHelper';
import { writeSchema as schema } from './write.schema';

const LOCK_HOLD_TIMEOUT_MS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 10_000;

const CODE_EXTENSIONS = new Set([
  '.html', '.htm', '.js', '.ts', '.jsx', '.tsx',
  '.css', '.scss', '.less', '.json', '.mjs', '.cjs',
  '.vue', '.svelte',
]);

/** 展开 ~ 开头的 home 路径 */
function expandTilde(filePath: string): string {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function resolveInputPath(inputPath: string, workingDir: string): string {
  const expanded = expandTilde(inputPath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(workingDir, expanded);
}

// ----------------------------------------------------------------------------
// 代码完整性检测（legacy 保真）
// ----------------------------------------------------------------------------

interface CompletenessCheck {
  isComplete: boolean;
  issues: string[];
  fileType: string;
}

function checkCodeCompleteness(content: string, filePath: string): CompletenessCheck {
  const ext = path.extname(filePath).toLowerCase();
  const issues: string[] = [];

  // 通用：括号匹配（忽略字符串内）
  const brackets: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const closings = new Set(Object.values(brackets));
  const stack: string[] = [];
  let inString = false;
  let stringChar = '';
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar) {
      inString = false;
    }

    if (inString) continue;

    if (brackets[char]) {
      stack.push(brackets[char]);
    } else if (closings.has(char)) {
      if (stack.length === 0 || stack.pop() !== char) {
        // 括号不匹配 — legacy 保持宽松，可能是合法的闭合标签场景
      }
    }
  }

  if (stack.length > 0) {
    issues.push(`未闭合的括号: 缺少 ${stack.length} 个闭合符号 (${stack.join(', ')})`);
  }

  // HTML / JSX
  if (['.html', '.htm', '.jsx', '.tsx'].includes(ext)) {
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

  // JS / TS
  if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    const trimmedEnd = content.trimEnd();
    const lastChars = trimmedEnd.slice(-20);

    if (/[,+\-*\/&|=<>!?:]$/.test(trimmedEnd) && !trimmedEnd.endsWith('*/')) {
      issues.push(`代码可能在表达式中间被截断 (以 "${lastChars.slice(-5)}" 结尾)`);
    }
    if (/function\s+\w+\s*\([^)]*$/.test(trimmedEnd)) {
      issues.push('函数定义未完成');
    }
    if (/=>\s*$/.test(trimmedEnd) || /=>\s*\{[^}]*$/.test(lastChars)) {
      issues.push('箭头函数未完成');
    }
  }

  // CSS / SCSS / LESS
  if (['.css', '.scss', '.less'].includes(ext)) {
    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    if (openBraces > closeBraces) {
      issues.push(`CSS 缺少 ${openBraces - closeBraces} 个闭合大括号`);
    }
  }

  // JSON
  if (ext === '.json') {
    try {
      JSON.parse(content);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      issues.push(`JSON 格式错误: ${message}`);
    }
  }

  // 截断关键字
  const trimmed = content.trimEnd();
  const truncatedTails = [
    'ctx.', 'this.', 'const ', 'let ', 'var ',
    'function ', 'class ', 'import ', 'export ',
  ];
  if (truncatedTails.some((tail) => trimmed.endsWith(tail))) {
    issues.push('代码在关键字后被截断');
  }

  return {
    isComplete: issues.length === 0,
    issues,
    fileType: ext || 'unknown',
  };
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

class WriteHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const rawPath = args.file_path;
    const content = args.content;

    if (typeof rawPath !== 'string' || !rawPath) {
      return {
        ok: false,
        error: 'file_path is required and must be a string',
        code: 'INVALID_ARGS',
      };
    }
    if (typeof content !== 'string') {
      return {
        ok: false,
        error: 'content is required and must be a string',
        code: 'INVALID_ARGS',
      };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return {
        ok: false,
        error: `permission denied: ${permit.reason}`,
        code: 'PERMISSION_DENIED',
      };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const filePath = resolveInputPath(rawPath, ctx.workingDir);
    const resolvedPath = path.resolve(filePath);

    onProgress?.({ stage: 'starting', detail: `write ${path.basename(filePath)}` });

    const lockManager = getResourceLockManager();
    const holderId = ctx.sessionId || `write_${Date.now()}`;

    const lockResult = await lockManager.acquire(holderId, resolvedPath, 'exclusive', {
      type: 'file',
      timeout: LOCK_HOLD_TIMEOUT_MS,
      wait: true,
      waitTimeout: LOCK_WAIT_TIMEOUT_MS,
    });

    if (!lockResult.acquired) {
      return {
        ok: false,
        error: `Cannot acquire lock for ${filePath}: ${lockResult.reason}. File may be in use by another operation.`,
        code: 'FS_ERROR',
      };
    }

    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      let existed = false;
      try {
        await fs.access(filePath);
        existed = true;
      } catch {
        // 不存在，正常创建
      }

      await atomicWriteFile(filePath, content, 'utf-8');
      const action = existed ? 'Updated' : 'Created';

      // 代码完整性检测（仅代码文件）
      const ext = path.extname(filePath).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        const check = checkCodeCompleteness(content, filePath);
        if (!check.isComplete) {
          ctx.logger.warn('Code completeness check failed', {
            filePath,
            issues: check.issues,
          });
          onProgress?.({ stage: 'completing', percent: 100 });
          return {
            ok: true,
            output:
              `${action} file: ${filePath} (${content.length} bytes)\n\n` +
              `⚠️ **代码完整性警告**: 检测到文件可能不完整！\n` +
              `问题:\n${check.issues.map((i) => `- ${i}`).join('\n')}\n\n` +
              `**建议**: 请使用 edit_file 工具追加剩余代码，或重新生成完整文件。`,
            meta: { outputPath: filePath, completenessIssues: check.issues },
          };
        }
      }

      let output = `${action} file: ${filePath} (${content.length} bytes)`;

      // LSP 诊断闭环
      try {
        const diagResult = await getPostEditDiagnostics(filePath);
        if (diagResult) {
          output += diagResult.formatted;
        }
      } catch {
        // 诊断失败不影响写入结果
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('Write done', { filePath, bytes: content.length, existed });
      return {
        ok: true,
        output,
        meta: { outputPath: filePath },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message || 'Failed to write file',
        code: 'FS_ERROR',
      };
    } finally {
      lockManager.release(holderId, resolvedPath);
    }
  }
}

export const writeModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WriteHandler();
  },
};
