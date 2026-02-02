// ============================================================================
// ExportModal - 会话导出模态框
// 支持导出为 Markdown 和 JSON 格式
// ============================================================================

import React, { useState, useCallback } from 'react';
import { X, Download, FileText, FileJson, Check, Copy, Loader2 } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Message } from '@shared/types';
import { createLogger } from '../../../utils/logger';

const logger = createLogger('ExportModal');

// ============================================================================
// Types
// ============================================================================

export type ExportFormat = 'markdown' | 'json';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  sessionTitle: string;
  messages: Message[];
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatMessageToMarkdown(message: Message): string {
  const role = message.role === 'user' ? '**用户**' : '**助手**';
  const timestamp = new Date(message.timestamp).toLocaleString('zh-CN');
  let content = message.content;

  // 处理工具调用
  if (message.toolCalls && message.toolCalls.length > 0) {
    content += '\n\n<details>\n<summary>工具调用</summary>\n\n';
    message.toolCalls.forEach(call => {
      content += `- **${call.name}**\n`;
      if (call.arguments) {
        content += `  \`\`\`json\n  ${JSON.stringify(call.arguments, null, 2).split('\n').join('\n  ')}\n  \`\`\`\n`;
      }
    });
    content += '</details>\n';
  }

  return `### ${role}\n_${timestamp}_\n\n${content}\n`;
}

function exportToMarkdown(title: string, messages: Message[]): string {
  const header = `# ${title}\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n---\n\n`;

  const messageContent = messages
    .map(formatMessageToMarkdown)
    .join('\n---\n\n');

  return header + messageContent;
}

function exportToJson(title: string, messages: Message[]): string {
  const exportData = {
    title,
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages: messages.map(msg => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      toolCalls: msg.toolCalls,
      reasoning: msg.reasoning,
    })),
  };

  return JSON.stringify(exportData, null, 2);
}

// ============================================================================
// Component
// ============================================================================

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  sessionTitle,
  messages,
}) => {
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [isExporting, setIsExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloadedFile, setDownloadedFile] = useState<string | null>(null);

  // 生成导出内容
  const generateContent = useCallback(() => {
    return format === 'markdown'
      ? exportToMarkdown(sessionTitle, messages)
      : exportToJson(sessionTitle, messages);
  }, [format, sessionTitle, messages]);

  // 复制到剪贴板
  const handleCopyToClipboard = async () => {
    try {
      const content = generateContent();
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      logger.info('Copied to clipboard', { format });
    } catch (error) {
      logger.error('Failed to copy to clipboard', error);
    }
  };

  // 下载文件
  const handleDownload = async () => {
    setIsExporting(true);
    try {
      const content = generateContent();
      const extension = format === 'markdown' ? 'md' : 'json';
      const filename = `${sessionTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}_${new Date().toISOString().split('T')[0]}.${extension}`;

      // 创建 Blob 并下载
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setDownloadedFile(filename);
      logger.info('Downloaded file', { filename, format });
    } catch (error) {
      logger.error('Failed to download file', error);
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  const formatOptions = [
    {
      id: 'markdown' as const,
      label: 'Markdown',
      icon: <FileText className="w-5 h-5" />,
      description: '适合阅读和分享，支持格式化展示',
      extension: '.md',
    },
    {
      id: 'json' as const,
      label: 'JSON',
      icon: <FileJson className="w-5 h-5" />,
      description: '结构化数据，适合程序处理',
      extension: '.json',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl overflow-hidden animate-fadeIn">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">导出会话</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {messages.length} 条消息
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
            aria-label="关闭"
          >
            <X className="w-5 h-5 text-zinc-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Session info */}
          <div className="p-3 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
            <p className="text-sm text-zinc-300 font-medium truncate">
              {sessionTitle}
            </p>
          </div>

          {/* Format selection */}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2">
              导出格式
            </label>
            <div className="grid grid-cols-2 gap-3">
              {formatOptions.map(option => {
                const isSelected = format === option.id;
                return (
                  <button
                    key={option.id}
                    onClick={() => setFormat(option.id)}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      isSelected
                        ? 'border-primary-500 bg-primary-500/10'
                        : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={isSelected ? 'text-primary-400' : 'text-zinc-400'}>
                        {option.icon}
                      </span>
                      <span className={`font-medium ${isSelected ? 'text-zinc-100' : 'text-zinc-300'}`}>
                        {option.label}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-500">
                      {option.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Success message */}
          {downloadedFile && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400">
              <Check className="w-4 h-4" />
              <span className="text-sm">已下载: {downloadedFile}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-zinc-800 bg-zinc-900/50">
          <button
            onClick={handleCopyToClipboard}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-zinc-700 hover:bg-zinc-800 text-sm text-zinc-300 transition-colors"
          >
            {copied ? (
              <>
                <Check className="w-4 h-4 text-green-400" />
                已复制
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                复制内容
              </>
            )}
          </button>
          <button
            onClick={handleDownload}
            disabled={isExporting}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-500 text-sm text-white transition-colors disabled:opacity-50"
          >
            {isExporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            下载文件
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportModal;
