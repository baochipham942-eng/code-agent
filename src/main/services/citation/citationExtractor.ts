// ============================================================================
// Citation Extractor - 从工具结果中提取引用
// ============================================================================
//
// 按工具类型分发提取逻辑，不修改工具本身，只从 ToolResult 中提取。

import type { Citation, CitationType } from '../../../shared/types/citation';

let citationCounter = 0;

function nextCitationId(): string {
  return `cite_${++citationCounter}_${Date.now().toString(36)}`;
}

/**
 * 从工具调用结果中提取引用
 */
export function extractCitations(
  toolName: string,
  toolCallId: string,
  params: Record<string, unknown>,
  output: string | undefined
): Citation[] {
  if (!output) return [];

  switch (toolName) {
    case 'read_file':
      return extractFileReadCitations(toolCallId, params, output);
    case 'grep':
      return extractGrepCitations(toolCallId, output);
    case 'glob':
      return extractGlobCitations(toolCallId, output);
    case 'web_fetch':
      return extractWebFetchCitations(toolCallId, params);
    case 'web_search':
      return extractWebSearchCitations(toolCallId, output);
    case 'read_xlsx':
    case 'read_pdf':
    case 'read_docx':
      return extractDocumentCitations(toolCallId, toolName, params);
    case 'memory_search':
      return extractMemoryCitations(toolCallId, output);
    default:
      return [];
  }
}

// read_file → 文件路径 + 行号范围
function extractFileReadCitations(
  toolCallId: string,
  params: Record<string, unknown>,
  output: string
): Citation[] {
  const filePath = (params.file_path || params.path) as string | undefined;
  if (!filePath) return [];

  const offset = (params.offset as number) || 1;
  const lineCount = output.split('\n').length;

  return [{
    id: nextCitationId(),
    type: 'file',
    source: filePath,
    location: lineCount > 1 ? `lines:${offset}-${offset + lineCount - 1}` : `line:${offset}`,
    label: `${basename(filePath)}:${offset}`,
    toolCallId,
    timestamp: Date.now(),
  }];
}

// grep → 匹配文件和行号
function extractGrepCitations(toolCallId: string, output: string): Citation[] {
  const citations: Citation[] = [];
  // grep 输出格式: "path/to/file:lineNum:content"
  const linePattern = /^(.+?):(\d+):/gm;
  const seen = new Set<string>();

  let match;
  while ((match = linePattern.exec(output)) !== null && citations.length < 10) {
    const [, filePath, lineNum] = match;
    const key = `${filePath}:${lineNum}`;
    if (seen.has(key)) continue;
    seen.add(key);

    citations.push({
      id: nextCitationId(),
      type: 'file',
      source: filePath,
      location: `line:${lineNum}`,
      label: `${basename(filePath)}:${lineNum}`,
      toolCallId,
      timestamp: Date.now(),
    });
  }

  return citations;
}

// glob → 匹配的文件列表
function extractGlobCitations(toolCallId: string, output: string): Citation[] {
  const files = output.split('\n').filter(l => l.trim().length > 0).slice(0, 10);
  return files.map(filePath => ({
    id: nextCitationId(),
    type: 'file' as CitationType,
    source: filePath.trim(),
    label: basename(filePath.trim()),
    toolCallId,
    timestamp: Date.now(),
  }));
}

// web_fetch → URL 引用
function extractWebFetchCitations(
  toolCallId: string,
  params: Record<string, unknown>
): Citation[] {
  const url = params.url as string | undefined;
  if (!url) return [];

  return [{
    id: nextCitationId(),
    type: 'url',
    source: url,
    label: truncateUrl(url),
    toolCallId,
    timestamp: Date.now(),
  }];
}

// web_search → 搜索结果 URL
function extractWebSearchCitations(toolCallId: string, output: string): Citation[] {
  const citations: Citation[] = [];
  // 提取输出中的 URL
  const urlPattern = /https?:\/\/[^\s"'<>\]]+/g;
  const seen = new Set<string>();

  let match;
  while ((match = urlPattern.exec(output)) !== null && citations.length < 5) {
    const url = match[0].replace(/[.,;:!?)]+$/, ''); // 移除尾部标点
    if (seen.has(url)) continue;
    seen.add(url);

    citations.push({
      id: nextCitationId(),
      type: 'url',
      source: url,
      label: truncateUrl(url),
      toolCallId,
      timestamp: Date.now(),
    });
  }

  return citations;
}

// read_xlsx / read_pdf / read_docx → 文档引用
function extractDocumentCitations(
  toolCallId: string,
  toolName: string,
  params: Record<string, unknown>
): Citation[] {
  const filePath = (params.file_path || params.path) as string | undefined;
  if (!filePath) return [];

  const typeMap: Record<string, CitationType> = {
    read_xlsx: 'cell',
    read_pdf: 'file',
    read_docx: 'file',
  };

  return [{
    id: nextCitationId(),
    type: typeMap[toolName] || 'file',
    source: filePath,
    label: basename(filePath),
    toolCallId,
    timestamp: Date.now(),
  }];
}

// memory_search → 记忆引用
function extractMemoryCitations(toolCallId: string, output: string): Citation[] {
  // 提取记忆搜索结果
  return [{
    id: nextCitationId(),
    type: 'memory',
    source: 'memory_search',
    label: '记忆检索结果',
    toolCallId,
    timestamp: Date.now(),
  }];
}

// Utility: 从路径中提取文件名
function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

// Utility: 截断 URL 用于展示
function truncateUrl(url: string, maxLen = 50): string {
  if (url.length <= maxLen) return url;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 20
      ? parsed.pathname.substring(0, 20) + '...'
      : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return url.substring(0, maxLen) + '...';
  }
}
