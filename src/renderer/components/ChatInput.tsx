// ============================================================================
// ChatInput - Message Input Component with Multimodal Support
// ============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Paperclip, Loader2, Sparkles, CornerDownLeft, X, Image, FileText, Code, Database, Globe, File } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { MessageAttachment, AttachmentCategory } from '../../shared/types';

// 配置 PDF.js worker - 使用 CDN 避免打包问题
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

interface ChatInputProps {
  onSend: (message: string, attachments?: MessageAttachment[]) => void;
  disabled?: boolean;
}

// ============================================================================
// 文件类型配置 - 按类别精细化分类
// ============================================================================

// 图片类型
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// 代码文件扩展名 → 语言映射
const CODE_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.php': 'php',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.sql': 'sql',
  '.r': 'r',
  '.lua': 'lua',
  '.vim': 'vim',
  '.el': 'elisp',
};

// 数据文件
const DATA_EXTENSIONS = ['.json', '.csv', '.xml', '.yaml', '.yml', '.toml'];

// 文本文件
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.rst', '.log'];

// 样式文件（归类为代码）
const STYLE_EXTENSIONS: Record<string, string> = {
  '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
};

// 最大文件大小 (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * 根据文件信息判断类别
 */
function getFileCategory(file: File): { category: AttachmentCategory; language?: string } {
  const mimeType = file.type.toLowerCase();
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();

  // 1. 图片
  if (IMAGE_MIMES.includes(mimeType) || mimeType.startsWith('image/')) {
    return { category: 'image' };
  }

  // 2. PDF
  if (mimeType === 'application/pdf' || ext === '.pdf') {
    return { category: 'pdf' };
  }

  // 3. HTML
  if (mimeType === 'text/html' || ext === '.html' || ext === '.htm') {
    return { category: 'html', language: 'html' };
  }

  // 4. 代码文件
  if (CODE_EXTENSIONS[ext]) {
    return { category: 'code', language: CODE_EXTENSIONS[ext] };
  }
  if (STYLE_EXTENSIONS[ext]) {
    return { category: 'code', language: STYLE_EXTENSIONS[ext] };
  }

  // 5. 数据文件
  if (DATA_EXTENSIONS.includes(ext) || mimeType === 'application/json') {
    const lang = ext === '.json' ? 'json' : ext === '.xml' ? 'xml' : ext.slice(1);
    return { category: 'data', language: lang };
  }

  // 6. 纯文本
  if (TEXT_EXTENSIONS.includes(ext) || mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return { category: 'text', language: ext === '.md' || ext === '.markdown' ? 'markdown' : undefined };
  }

  // 7. 办公文档
  if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx' ||
      mimeType.includes('officedocument') || mimeType.includes('msword')) {
    return { category: 'document' };
  }

  // 8. 其他
  return { category: 'other' };
}

/**
 * 从 PDF 文件中提取文本内容
 */
async function extractPdfText(file: File): Promise<{ text: string; pageCount: number }> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const textParts: string[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: any) => item.str)
        .join(' ');
      if (pageText.trim()) {
        textParts.push(`--- 第 ${i} 页 ---\n${pageText}`);
      }
    }

    if (textParts.length === 0) {
      return {
        text: '[PDF 文件无法提取文本内容，可能是扫描件或图片 PDF]',
        pageCount: pdf.numPages,
      };
    }

    return {
      text: textParts.join('\n\n'),
      pageCount: pdf.numPages,
    };
  } catch (error) {
    console.error('PDF 文本提取失败:', error);
    return {
      text: `[PDF 解析失败: ${error instanceof Error ? error.message : '未知错误'}]`,
      pageCount: 0,
    };
  }
}

/**
 * 根据附件类别返回对应图标
 */
const AttachmentIcon: React.FC<{ category: AttachmentCategory }> = ({ category }) => {
  const iconClass = "w-5 h-5";
  switch (category) {
    case 'pdf':
      return <FileText className={`${iconClass} text-red-400`} />;
    case 'code':
      return <Code className={`${iconClass} text-blue-400`} />;
    case 'data':
      return <Database className={`${iconClass} text-amber-400`} />;
    case 'html':
      return <Globe className={`${iconClass} text-orange-400`} />;
    case 'text':
      return <FileText className={`${iconClass} text-zinc-400`} />;
    default:
      return <File className={`${iconClass} text-zinc-500`} />;
  }
};

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled }) => {
  const [value, setValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [value]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((value.trim() || attachments.length > 0) && !disabled) {
      onSend(value, attachments.length > 0 ? attachments : undefined);
      setValue('');
      setAttachments([]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Submit on Enter (without Shift)
    // 重要: 检查 isComposing 避免中文输入法选词时误触发
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // 处理文件选择
  const processFile = useCallback(async (file: File): Promise<MessageAttachment | null> => {
    if (file.size > MAX_FILE_SIZE) {
      console.warn(`File ${file.name} is too large (max 10MB)`);
      return null;
    }

    const { category, language } = getFileCategory(file);
    const id = `att-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // 不支持的类型：办公文档暂时跳过
    if (category === 'document') {
      console.warn(`Office documents (.docx, .xlsx) are not yet supported. Please convert to PDF first.`);
      return null;
    }

    // 图片类型：读取为 base64
    if (category === 'image') {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const data = e.target?.result as string;
          resolve({
            id,
            type: 'image',
            category: 'image',
            name: file.name,
            size: file.size,
            mimeType: file.type,
            data,
            thumbnail: data,
          });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    // PDF 类型：提取文本
    if (category === 'pdf') {
      const { text, pageCount } = await extractPdfText(file);
      return {
        id,
        type: 'file',
        category: 'pdf',
        name: file.name,
        size: file.size,
        mimeType: 'application/pdf',
        data: text,
        pageCount,
      };
    }

    // 代码、数据、文本、HTML、其他：读取文本内容
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = e.target?.result as string;
        resolve({
          id,
          type: 'file',
          category,
          name: file.name,
          size: file.size,
          mimeType: file.type || 'text/plain',
          data,
          language,
        });
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
  }, []);

  // 处理拖放
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    const newAttachments: MessageAttachment[] = [];

    for (const file of files) {
      const attachment = await processFile(file);
      if (attachment) {
        newAttachments.push(attachment);
      }
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments].slice(0, 5)); // 最多 5 个附件
    }
  }, [processFile]);

  // 点击附件按钮
  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  // 文件选择
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newAttachments: MessageAttachment[] = [];

    for (const file of files) {
      const attachment = await processFile(file);
      if (attachment) {
        newAttachments.push(attachment);
      }
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments].slice(0, 5));
    }

    // 重置 input 以允许再次选择同一文件
    e.target.value = '';
  };

  // 移除附件
  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const hasContent = value.trim().length > 0 || attachments.length > 0;

  return (
    <div
      className={`border-t border-zinc-800/50 bg-gradient-to-t from-surface-950 to-surface-950/80 backdrop-blur-sm p-4 transition-colors ${
        isDragOver ? 'bg-primary-500/10' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
        {/* 附件预览区 */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3 px-2">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="relative group flex items-center gap-2 px-3 py-2 bg-zinc-800/60 rounded-lg border border-zinc-700/50"
              >
                {att.category === 'image' ? (
                  <>
                    <img
                      src={att.thumbnail}
                      alt={att.name}
                      className="w-10 h-10 object-cover rounded"
                    />
                    <div className="flex flex-col">
                      <span className="text-xs text-zinc-300 truncate max-w-[120px]">{att.name}</span>
                      <span className="text-2xs text-zinc-500">{(att.size / 1024).toFixed(1)} KB</span>
                    </div>
                  </>
                ) : (
                  <>
                    <AttachmentIcon category={att.category} />
                    <div className="flex flex-col">
                      <span className="text-xs text-zinc-300 truncate max-w-[120px]">{att.name}</span>
                      <span className="text-2xs text-zinc-500">
                        {att.category === 'pdf' && att.pageCount
                          ? `${att.pageCount} 页`
                          : att.language
                            ? att.language
                            : (att.size / 1024).toFixed(1) + ' KB'
                        }
                      </span>
                    </div>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(att.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-zinc-700 hover:bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3 text-white" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 拖放提示 */}
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-950/90 backdrop-blur-sm z-10 rounded-xl border-2 border-dashed border-primary-500">
            <div className="flex flex-col items-center gap-2 text-primary-400">
              <Image className="w-8 h-8" />
              <span className="text-sm">拖放图片或文件到这里</span>
            </div>
          </div>
        )}

        <div
          className={`relative flex items-center bg-zinc-800/60 rounded-2xl border transition-all duration-300 ${
            isFocused
              ? 'border-primary-500/40 shadow-lg shadow-primary-500/5 ring-1 ring-primary-500/20'
              : 'border-zinc-700/50 hover:border-zinc-600/50'
          }`}
        >
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={[
              // 图片
              ...IMAGE_MIMES,
              // 代码文件
              ...Object.keys(CODE_EXTENSIONS),
              ...Object.keys(STYLE_EXTENSIONS),
              // 数据文件
              ...DATA_EXTENSIONS,
              // 文本文件
              ...TEXT_EXTENSIONS,
              // PDF
              '.pdf', 'application/pdf',
              // HTML
              '.html', '.htm',
            ].join(',')}
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Attachment button */}
          <button
            type="button"
            onClick={handleAttachClick}
            className="flex-shrink-0 p-2.5 ml-2 rounded-xl hover:bg-zinc-700/50 text-zinc-500 hover:text-zinc-300 transition-all duration-200"
            title="添加图片或文件"
          >
            <Paperclip className="w-5 h-5" />
          </button>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={attachments.length > 0 ? "添加描述..." : "问我任何关于代码的问题..."}
            disabled={disabled}
            rows={1}
            className="flex-1 min-w-0 bg-transparent py-3 px-2 text-sm text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none disabled:opacity-50 max-h-[200px] leading-relaxed"
          />

          {/* Send button */}
          <button
            type="submit"
            disabled={disabled || !hasContent}
            className={`flex-shrink-0 p-2.5 mr-2 rounded-xl text-white transition-all duration-300 ${
              hasContent && !disabled
                ? 'bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-500 hover:to-primary-400 shadow-lg shadow-primary-500/20 hover:shadow-primary-500/30 scale-100 hover:scale-105'
                : 'bg-zinc-700/50 cursor-not-allowed scale-95 opacity-60'
            }`}
          >
            {disabled ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className={`w-5 h-5 transition-transform duration-200 ${hasContent ? '-rotate-45' : ''}`} />
            )}
          </button>
        </div>

        {/* Hints */}
        <div className="flex items-center justify-between mt-2.5 px-2">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <kbd className="px-1.5 py-0.5 rounded-md bg-zinc-800/80 text-zinc-400 font-mono text-2xs border border-zinc-700/50">
                <CornerDownLeft className="w-3 h-3 inline" />
              </kbd>
              <span>发送</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <kbd className="px-1.5 py-0.5 rounded-md bg-zinc-800/80 text-zinc-400 font-mono text-2xs border border-zinc-700/50">
                Shift
              </kbd>
              <span>+</span>
              <kbd className="px-1.5 py-0.5 rounded-md bg-zinc-800/80 text-zinc-400 font-mono text-2xs border border-zinc-700/50">
                <CornerDownLeft className="w-3 h-3 inline" />
              </kbd>
              <span>换行</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Sparkles className="w-3 h-3 text-primary-400" />
            <span>由 DeepSeek 驱动</span>
          </div>
        </div>
      </form>
    </div>
  );
};
