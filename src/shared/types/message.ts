// ============================================================================
// Message Types
// ============================================================================

import type { ToolCall, ToolResult } from './tool';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

// 附件文件类别（用于精细化处理）
export type AttachmentCategory =
  | 'image'      // 图片：PNG, JPEG, GIF, WebP
  | 'pdf'        // PDF 文档
  | 'excel'      // Excel 表格：XLSX, XLS（支持解析）
  | 'code'       // 代码文件：JS, TS, Python, etc.
  | 'text'       // 纯文本：TXT, MD
  | 'data'       // 数据文件：JSON, CSV, XML
  | 'document'   // 办公文档：DOCX, PPTX (暂不支持)
  | 'html'       // 网页：HTML
  | 'folder'     // 文件夹
  | 'other';     // 其他

// 附件类型
export interface MessageAttachment {
  id: string;
  type: 'image' | 'file';
  category: AttachmentCategory;  // 细粒度分类
  name: string;
  size: number;
  mimeType: string;
  // 图片: base64 数据 URL
  // 文件: 提取的文本内容
  data?: string;
  path?: string;
  // 图片预览 (缩略图)
  thumbnail?: string;
  // PDF 特有：页数
  pageCount?: number;
  // Excel 特有：sheet 数和行数
  sheetCount?: number;
  rowCount?: number;
  // 代码特有：语言
  language?: string;
  // 文件夹特有：文件列表和统计
  files?: Array<{ path: string; content: string; size: number }>;
  folderStats?: { totalFiles: number; totalSize: number; byType: Record<string, number> };
}

// 消息来源类型
export type MessageSource = 'user' | 'skill' | 'system';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  // 多模态支持
  attachments?: MessageAttachment[];
  // Skill 系统支持 (Agent Skills 标准)
  // isMeta: true 表示消息不渲染到 UI，但会发送给模型
  isMeta?: boolean;
  // 消息来源追踪
  source?: MessageSource;
}
