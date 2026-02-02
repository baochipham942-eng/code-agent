// ============================================================================
// Message Converter - Convert between different message formats
// ============================================================================

import type { Message, MessageAttachment, ToolCall, ToolResult } from '../../../shared/types';
import type { ModelMessage, MessageContent } from '../loopTypes';
import { LARGE_DATA_FIELDS, LARGE_DATA_THRESHOLD } from '../loopTypes';
import { createLogger } from '../../services/infra/logger';
import * as fs from 'fs';

const logger = createLogger('MessageConverter');

// ----------------------------------------------------------------------------
// Tool Call Formatting
// ----------------------------------------------------------------------------

/**
 * Format a tool call for history (token optimization)
 * Only keeps key information, avoids token waste
 */
export function formatToolCallForHistory(tc: ToolCall): string {
  const { name, arguments: args } = tc;

  switch (name) {
    case 'edit_file':
      return `Edited ${args.file_path}`;

    case 'bash': {
      const cmd = (args.command as string) || '';
      if (cmd.length <= 200) {
        return `Ran: ${cmd}`;
      }
      // Long commands: preserve head + tail for better context
      const head = cmd.slice(0, 120);
      const tail = cmd.slice(-50);
      const omitted = cmd.length - 170;
      return `Ran: ${head}...[${omitted} chars]...${tail}`;
    }

    case 'read_file':
      return `Read ${args.file_path}`;

    case 'write_file':
      return `Created ${args.file_path}`;

    case 'glob':
      return `Found files matching: ${args.pattern}`;

    case 'grep':
      return `Searched for: ${args.pattern}`;

    case 'list_directory':
      return `Listed: ${args.path || '.'}`;

    case 'task':
      return `Delegated task: ${(args.description as string)?.slice(0, 50) || 'subagent'}`;

    case 'todo_write':
      return `Updated todo list`;

    case 'ask_user_question':
      return `Asked user a question`;

    case 'skill':
      return `Invoked skill: ${args.skill}`;

    case 'web_fetch':
      return `Fetched: ${args.url}`;

    default: {
      const argsStr = JSON.stringify(args);
      if (argsStr.length <= 150) {
        return `Called ${name}(${argsStr})`;
      }
      // Preserve more context for long arguments
      const head = argsStr.slice(0, 100);
      const tail = argsStr.slice(-30);
      return `Called ${name}(${head}...[${argsStr.length - 130} chars]...${tail})`;
    }
  }
}

// ----------------------------------------------------------------------------
// Tool Result Sanitization
// ----------------------------------------------------------------------------

/**
 * Sanitize a single tool result for history storage
 *
 * Design principles:
 * 1. Large binary data (base64 images etc.) only keep reference, not stored in history
 * 2. Frontend gets full data via tool_call_end event for rendering
 * 3. Model only needs to know "image generated", doesn't need to see image content
 */
export function sanitizeToolResultForHistory(result: ToolResult): ToolResult {
  if (!result.metadata) {
    return result;
  }

  // Deep copy to avoid modifying original data
  const sanitized: ToolResult = {
    ...result,
    metadata: { ...result.metadata },
  };

  // Filter known large data fields
  for (const field of LARGE_DATA_FIELDS) {
    if (sanitized.metadata![field]) {
      const data = sanitized.metadata![field];
      if (typeof data === 'string' && data.length > 100) {
        const sizeKB = (data.length / 1024).toFixed(1);
        sanitized.metadata![field] = `[BINARY_DATA_FILTERED: ${sizeKB}KB]`;
      }
    }
  }

  // Check other potentially large fields (dynamic detection)
  for (const [key, value] of Object.entries(sanitized.metadata!)) {
    if (LARGE_DATA_FIELDS.includes(key)) continue;

    if (typeof value === 'string' && value.length > LARGE_DATA_THRESHOLD) {
      // Detect if it's base64 data
      const isBase64 = value.startsWith('data:') ||
        /^[A-Za-z0-9+/]{1000,}={0,2}$/.test(value.slice(0, 1100));

      if (isBase64) {
        const sizeKB = (value.length / 1024).toFixed(1);
        sanitized.metadata![key] = `[LARGE_BASE64_FILTERED: ${sizeKB}KB]`;
        logger.debug(`Filtered large base64 field: ${key} (${sizeKB}KB)`);
      }
    }
  }

  return sanitized;
}

/**
 * Batch sanitize tool results
 */
export function sanitizeToolResultsForHistory(results: ToolResult[]): ToolResult[] {
  return results.map(r => sanitizeToolResultForHistory(r));
}

// ----------------------------------------------------------------------------
// Multimodal Content Building
// ----------------------------------------------------------------------------

/** Large file threshold - files above this size get summarized */
const LARGE_FILE_THRESHOLD = 8000;
/** Max preview lines for large files */
const MAX_PREVIEW_LINES = 30;
/** Max total attachment characters */
const MAX_TOTAL_ATTACHMENT_CHARS = 50000;

/**
 * Check if content is considered a large file
 */
function isLargeFile(content: string): boolean {
  return content.length > LARGE_FILE_THRESHOLD;
}

/**
 * Generate a file preview for large files
 */
function generateFilePreview(content: string, filePath: string, lang: string): string {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const previewLines = lines.slice(0, MAX_PREVIEW_LINES).join('\n');
  const sizeKB = (content.length / 1024).toFixed(1);

  return `**预览 (前 ${Math.min(MAX_PREVIEW_LINES, totalLines)} 行 / 共 ${totalLines} 行, ${sizeKB} KB):**
\`\`\`${lang}
${previewLines}
\`\`\`
${totalLines > MAX_PREVIEW_LINES ? `\n⚠️ 还有 ${totalLines - MAX_PREVIEW_LINES} 行未显示。这只是预览，要分析完整代码必须用 \`read_file\` 读取: \`${filePath}\`` : ''}`;
}

/**
 * Build multimodal content from text and attachments
 * Handles different file types with appropriate formatting
 */
export function buildMultimodalContent(
  text: string,
  attachments: MessageAttachment[]
): MessageContent[] {
  const contents: MessageContent[] = [];
  let totalAttachmentChars = 0;

  // Add user text
  if (text.trim()) {
    contents.push({ type: 'text', text });
  }

  // Process each attachment by category
  for (const attachment of attachments) {
    const category = attachment.category || (attachment.type === 'image' ? 'image' : 'other');
    if (!attachment.data && category !== 'image') continue;
    if (!attachment.data && !attachment.path) continue;

    // Check total size limit
    if (totalAttachmentChars >= MAX_TOTAL_ATTACHMENT_CHARS) {
      contents.push({
        type: 'text',
        text: `⚠️ 附件内容已达上限，跳过: ${attachment.name}`,
      });
      continue;
    }

    switch (category) {
      case 'image': {
        const result = processImageAttachment(attachment, contents);
        if (!result) continue;
        break;
      }

      case 'pdf': {
        const contentText = processPdfAttachment(attachment);
        totalAttachmentChars += contentText.length;
        contents.push({ type: 'text', text: contentText });
        break;
      }

      case 'code': {
        const contentText = processCodeAttachment(attachment);
        totalAttachmentChars += contentText.length;
        contents.push({ type: 'text', text: contentText });
        break;
      }

      case 'data': {
        const contentText = processDataAttachment(attachment);
        totalAttachmentChars += contentText.length;
        contents.push({ type: 'text', text: contentText });
        break;
      }

      case 'html': {
        const contentText = processHtmlAttachment(attachment);
        totalAttachmentChars += contentText.length;
        contents.push({ type: 'text', text: contentText });
        break;
      }

      case 'text': {
        const contentText = processTextAttachment(attachment);
        totalAttachmentChars += contentText.length;
        contents.push({ type: 'text', text: contentText });
        break;
      }

      case 'excel': {
        const contentText = processExcelAttachment(attachment);
        totalAttachmentChars += contentText.length;
        contents.push({ type: 'text', text: contentText });
        break;
      }

      case 'folder': {
        const contentText = processFolderAttachment(attachment);
        totalAttachmentChars += contentText.length;
        contents.push({ type: 'text', text: contentText });
        break;
      }

      default: {
        const contentText = processDefaultAttachment(attachment);
        totalAttachmentChars += contentText.length;
        contents.push({ type: 'text', text: contentText });
      }
    }
  }

  // If no content, return empty text
  if (contents.length === 0) {
    contents.push({ type: 'text', text: text || '' });
  }

  return contents;
}

// Helper functions for attachment processing
function processImageAttachment(
  attachment: MessageAttachment,
  contents: MessageContent[]
): boolean {
  let base64Data = attachment.data;
  let mediaType = attachment.mimeType;

  if (!base64Data && attachment.path) {
    try {
      if (fs.existsSync(attachment.path)) {
        const imageBuffer = fs.readFileSync(attachment.path);
        base64Data = imageBuffer.toString('base64');
        logger.debug('Loaded image from path:', attachment.path);
      } else {
        logger.warn('Image file not found:', attachment.path);
        contents.push({
          type: 'text',
          text: `⚠️ 图片文件不存在: ${attachment.path}`,
        });
        return false;
      }
    } catch (err) {
      logger.error('Failed to read image file:', err);
      contents.push({
        type: 'text',
        text: `⚠️ 无法读取图片: ${attachment.name}`,
      });
      return false;
    }
  }

  if (base64Data?.startsWith('data:')) {
    const match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mediaType = match[1];
      base64Data = match[2];
    }
  }

  if (!base64Data) {
    logger.warn('No image data available for:', attachment.name);
    return false;
  }

  contents.push({
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType || 'image/png',
      data: base64Data,
    },
  });

  if (attachment.path) {
    contents.push({
      type: 'text',
      text: `📍 图片文件路径: ${attachment.path}`,
    });
  }

  return true;
}

function processPdfAttachment(attachment: MessageAttachment): string {
  const pageInfo = attachment.pageCount ? ` (${attachment.pageCount} 页)` : '';
  const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
  const filePath = attachment.path || attachment.name;
  const data = attachment.data || '';

  if (isLargeFile(data)) {
    return `📄 **PDF 文档: ${attachment.name}**${pageInfo}${pathInfo}\n\n${generateFilePreview(data, filePath || attachment.name, 'text')}`;
  }
  return `📄 **PDF 文档: ${attachment.name}**${pageInfo}${pathInfo}\n\n${data}`;
}

function processCodeAttachment(attachment: MessageAttachment): string {
  const lang = attachment.language || 'plaintext';
  const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
  const filePath = attachment.path || attachment.name;
  const data = attachment.data || '';

  if (isLargeFile(data)) {
    return `📝 **代码文件: ${attachment.name}** (${lang})${pathInfo}\n\n${generateFilePreview(data, filePath, lang)}`;
  }
  return `📝 **代码文件: ${attachment.name}** (${lang})${pathInfo}\n\`\`\`${lang}\n${data}\n\`\`\``;
}

function processDataAttachment(attachment: MessageAttachment): string {
  const lang = attachment.language || 'json';
  const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
  const filePath = attachment.path || attachment.name;
  const data = attachment.data || '';

  if (isLargeFile(data)) {
    return `📊 **数据文件: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(data, filePath, lang)}`;
  }
  return `📊 **数据文件: ${attachment.name}**${pathInfo}\n\`\`\`${lang}\n${data}\n\`\`\``;
}

function processHtmlAttachment(attachment: MessageAttachment): string {
  const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
  const filePath = attachment.path || attachment.name;
  const data = attachment.data || '';

  if (isLargeFile(data)) {
    return `🌐 **HTML 文件: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(data, filePath, 'html')}`;
  }
  return `🌐 **HTML 文件: ${attachment.name}**${pathInfo}\n\`\`\`html\n${data}\n\`\`\``;
}

function processTextAttachment(attachment: MessageAttachment): string {
  const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
  const isMarkdown = attachment.language === 'markdown';
  const filePath = attachment.path || attachment.name;
  const icon = isMarkdown ? '📝' : '📄';
  const fileType = isMarkdown ? 'Markdown 文件' : '文本文件';
  const lang = isMarkdown ? 'markdown' : 'text';
  const data = attachment.data || '';

  if (isLargeFile(data)) {
    return `${icon} **${fileType}: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(data, filePath, lang)}`;
  }
  return `${icon} **${fileType}: ${attachment.name}**${pathInfo}\n\n${data}`;
}

function processExcelAttachment(attachment: MessageAttachment): string {
  const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
  const sheetInfo = attachment.sheetCount ? ` (${attachment.sheetCount} 个工作表` : '';
  const rowInfo = attachment.rowCount ? `, ${attachment.rowCount} 行数据)` : sheetInfo ? ')' : '';
  const filePath = attachment.path || attachment.name;
  const data = attachment.data || '';

  if (isLargeFile(data)) {
    return `📊 **Excel 文件: ${attachment.name}**${sheetInfo}${rowInfo}${pathInfo}\n\n⚠️ 以下是已解析的表格数据（CSV 格式），无需调用工具读取：\n\n${generateFilePreview(data, filePath, 'csv')}`;
  }
  return `📊 **Excel 文件: ${attachment.name}**${sheetInfo}${rowInfo}${pathInfo}\n\n⚠️ 以下是已解析的表格数据（CSV 格式），无需调用工具读取：\n\n\`\`\`csv\n${data}\n\`\`\``;
}

function processFolderAttachment(attachment: MessageAttachment): string {
  const pathInfo = attachment.path ? `\n📍 绝对路径: ${attachment.path}` : '';
  const stats = attachment.folderStats;
  const statsInfo = stats
    ? `\n📊 统计: ${stats.totalFiles} 个文件, ${(stats.totalSize / 1024).toFixed(1)} KB`
    : '';

  let fileList = '';
  if (attachment.files && attachment.files.length > 0) {
    fileList = '\n\n**文件列表：**\n';
    for (const file of attachment.files) {
      const sizeKB = file.content ? (file.content.length / 1024).toFixed(1) : '?';
      const fullPath = attachment.path ? `${attachment.path}/${file.path}` : file.path;
      fileList += `- ${file.path} (${sizeKB} KB) → \`${fullPath}\`\n`;
    }
    fileList += '\n⚠️ **注意**: 以上只是文件列表，不包含文件内容。要分析代码，必须先用 `read_file` 工具读取文件。';
  }

  return `📁 **文件夹: ${attachment.name}**${pathInfo}${statsInfo}\n\n${attachment.data || ''}${fileList}`;
}

function processDefaultAttachment(attachment: MessageAttachment): string {
  const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
  const filePath = attachment.path || attachment.name;
  const data = attachment.data || '';

  if (isLargeFile(data)) {
    return `📎 **文件: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(data, filePath, 'text')}`;
  }
  return `📎 **文件: ${attachment.name}**${pathInfo}\n\`\`\`\n${data}\n\`\`\``;
}

// ----------------------------------------------------------------------------
// Image Stripping
// ----------------------------------------------------------------------------

/**
 * Strip images from messages, replacing with text description
 * Used when vision model is unavailable
 */
export function stripImagesFromMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) {
      return msg;
    }

    const newContent: MessageContent[] = [];
    let hasImage = false;

    for (const part of msg.content) {
      if (part.type === 'image') {
        hasImage = true;
        newContent.push({
          type: 'text',
          text: '[用户上传了图片，但当前模型不支持直接处理图片。如需在图片上标注，请使用 image_annotate 工具并提供图片路径]',
        });
      } else {
        newContent.push(part);
      }
    }

    if (hasImage) {
      return { ...msg, content: newContent };
    }
    return msg;
  });
}

/**
 * Extract text content from a user message
 */
export function extractUserRequestText(message: ModelMessage | undefined): string {
  if (!message) return '';

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
  }

  return '';
}
