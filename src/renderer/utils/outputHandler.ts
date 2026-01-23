// ============================================================================
// Output Handler - 大输出处理工具
// ============================================================================
// 处理超大工具输出的截断、预览和完整查看

export interface OutputMetadata {
  originalSize: number;
  truncated: boolean;
  lineCount: number;
  previewSize: number;
}

export interface ProcessedOutput {
  preview: string;
  metadata: OutputMetadata;
  isBinary: boolean;
}

// 阈值配置
const THRESHOLDS = {
  MAX_SIZE: 400 * 1024, // 400KB 触发截断
  PREVIEW_SIZE: 2 * 1024, // 预览显示 2KB
  LINE_LIMIT: 500, // 最多显示 500 行
  BINARY_DETECT_SIZE: 8192, // 检测前 8KB
};

/**
 * 检测是否为二进制内容
 */
function isBinaryContent(content: string): boolean {
  // 检查前 8KB 中的非打印字符比例
  const sample = content.slice(0, THRESHOLDS.BINARY_DETECT_SIZE);
  let nonPrintable = 0;

  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // 允许：换行、回车、制表符、以及可打印 ASCII
    if (code < 9 || (code > 13 && code < 32) || code === 127) {
      nonPrintable++;
    }
  }

  // 如果非打印字符超过 10%，认为是二进制
  return nonPrintable / sample.length > 0.1;
}

/**
 * 处理输出内容
 */
export function processOutput(content: unknown): ProcessedOutput {
  // 转换为字符串
  let str: string;
  if (typeof content === 'string') {
    str = content;
  } else if (content === null || content === undefined) {
    str = '';
  } else {
    try {
      str = JSON.stringify(content, null, 2);
    } catch {
      str = String(content);
    }
  }

  const originalSize = str.length;
  const lineCount = str.split('\n').length;

  // 检测二进制
  if (isBinaryContent(str)) {
    return {
      preview: '[Binary content - cannot display]',
      metadata: {
        originalSize,
        truncated: true,
        lineCount: 0,
        previewSize: 0,
      },
      isBinary: true,
    };
  }

  // 检查是否需要截断
  const needsTruncation = originalSize > THRESHOLDS.MAX_SIZE || lineCount > THRESHOLDS.LINE_LIMIT;

  if (!needsTruncation) {
    return {
      preview: str,
      metadata: {
        originalSize,
        truncated: false,
        lineCount,
        previewSize: originalSize,
      },
      isBinary: false,
    };
  }

  // 截断处理
  const lines = str.split('\n');
  let preview: string;

  if (lineCount > THRESHOLDS.LINE_LIMIT) {
    // 按行数截断：显示前半和后半
    const halfLimit = Math.floor(THRESHOLDS.LINE_LIMIT / 2);
    const headLines = lines.slice(0, halfLimit);
    const tailLines = lines.slice(-halfLimit);
    const omittedLines = lineCount - THRESHOLDS.LINE_LIMIT;

    preview = [
      ...headLines,
      `\n... ${omittedLines} lines omitted ...\n`,
      ...tailLines,
    ].join('\n');
  } else {
    // 按大小截断：显示前 2KB
    preview = str.slice(0, THRESHOLDS.PREVIEW_SIZE);
    if (preview.length < originalSize) {
      preview += `\n\n... ${formatSize(originalSize - THRESHOLDS.PREVIEW_SIZE)} more ...`;
    }
  }

  return {
    preview,
    metadata: {
      originalSize,
      truncated: true,
      lineCount,
      previewSize: preview.length,
    },
    isBinary: false,
  };
}

/**
 * 格式化文件大小
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 在内容中搜索关键词
 */
export function searchInContent(content: string, keyword: string): number[] {
  if (!keyword) return [];

  const matches: number[] = [];
  const lowerContent = content.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();

  let index = 0;
  while ((index = lowerContent.indexOf(lowerKeyword, index)) !== -1) {
    matches.push(index);
    index += lowerKeyword.length;
  }

  return matches;
}

/**
 * 高亮显示搜索结果
 */
export function highlightMatches(
  content: string,
  keyword: string,
  highlightClass = 'bg-yellow-500/30'
): string {
  if (!keyword) return content;

  const regex = new RegExp(`(${escapeRegExp(keyword)})`, 'gi');
  return content.replace(regex, `<mark class="${highlightClass}">$1</mark>`);
}

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 复制内容到剪贴板
 */
export async function copyToClipboard(content: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    // 降级方案：使用 execCommand
    try {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      return success;
    } catch {
      return false;
    }
  }
}
