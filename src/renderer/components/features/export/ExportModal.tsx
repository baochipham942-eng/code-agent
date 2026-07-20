// ============================================================================
// ExportModal - 会话导出模态框
// 支持导出为 Markdown 和 JSON 格式
// ============================================================================

import React, { useState, useCallback } from 'react';
import { X, Download, FileText, FileJson, Check, Copy } from 'lucide-react';
import type { Message } from '@shared/contract';
import { Button, IconButton, Modal } from '../../primitives';
import { createLogger } from '../../../utils/logger';
import { sanitizeMessagesForBrowserComputerExport } from '../../../utils/browserComputerExportRedaction';

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
      if (call.result) {
        const resultText = call.result.success ? call.result.output : call.result.error;
        if (resultText) {
          content += `  **结果**\n\n  \`\`\`\n  ${String(resultText).split('\n').join('\n  ')}\n  \`\`\`\n`;
        }
        if (call.result.metadata) {
          content += `  **元数据**\n\n  \`\`\`json\n  ${JSON.stringify(call.result.metadata, null, 2).split('\n').join('\n  ')}\n  \`\`\`\n`;
        }
      }
    });
    content += '</details>\n';
  }

  return `### ${role}\n_${timestamp}_\n\n${content}\n`;
}

export function exportToMarkdown(title: string, messages: Message[]): string {
  const header = `# ${title}\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n---\n\n`;
  const safeMessages = sanitizeMessagesForBrowserComputerExport(messages);

  const messageContent = safeMessages
    .map(formatMessageToMarkdown)
    .join('\n---\n\n');

  return header + messageContent;
}

export function exportToJson(title: string, messages: Message[]): string {
  const safeMessages = sanitizeMessagesForBrowserComputerExport(messages);
  const exportData = {
    title,
    exportedAt: new Date().toISOString(),
    messageCount: safeMessages.length,
    messages: safeMessages.map(msg => ({
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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="导出会话"
      size="md"
      header={
        <>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-zinc-200">导出会话</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {messages.length} 条消息
            </p>
          </div>
          <IconButton
            variant="default"
            size="md"
            icon={<X className="w-5 h-5" />}
            aria-label="关闭"
            onClick={onClose}
          />
        </>
      }
      footer={
        <>
          <Button
            variant="ghost"
            leftIcon={
              copied ? (
                <Check className="w-4 h-4 text-green-400" />
              ) : (
                <Copy className="w-4 h-4" />
              )
            }
            onClick={handleCopyToClipboard}
          >
            {copied ? '已复制' : '复制内容'}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Download className="w-4 h-4" />}
            loading={isExporting}
            onClick={handleDownload}
          >
            下载文件
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Session info */}
        <div className="p-3 rounded-lg bg-zinc-800 border border-zinc-700">
          <p className="text-sm text-zinc-400 font-medium truncate">
            {sessionTitle}
          </p>
        </div>

        {/* Format selection */}
        <div>
          <label className="block text-sm font-medium text-zinc-400 mb-2">
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
                      ? 'border-zinc-500 bg-zinc-800/60'
                      : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={isSelected ? 'text-zinc-200' : 'text-zinc-400'}>
                      {option.icon}
                    </span>
                    <span className={`font-medium ${isSelected ? 'text-zinc-200' : 'text-zinc-400'}`}>
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
    </Modal>
  );
};

export default ExportModal;
