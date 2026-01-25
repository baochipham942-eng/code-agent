// ============================================================================
// ChatInput - 消息输入组件主入口
// 支持多模态输入：文本、图片、代码、PDF、文件夹
// 深度研究通过语义自动检测触发，无需手动切换
// ============================================================================

import React, { useState, useRef, useCallback } from 'react';
import { Image, FileText } from 'lucide-react';
import type { MessageAttachment } from '../../../../../shared/types';
import { UI } from '@shared/constants';

import { InputArea, InputAreaRef } from './InputArea';
import { AttachmentBar } from './AttachmentBar';
import { SendButton } from './SendButton';
import { VoiceInputButton } from './VoiceInputButton';
import { useFileUpload } from './useFileUpload';

// ============================================================================
// 类型定义
// ============================================================================

export interface ChatInputProps {
  onSend: (message: string, attachments?: MessageAttachment[]) => void;
  disabled?: boolean;
  /** 是否正在处理（用于显示停止按钮） */
  isProcessing?: boolean;
  /** 停止处理回调 */
  onStop?: () => void;
  /** 是否有 Plan */
  hasPlan?: boolean;
  /** 点击 Plan 入口 */
  onPlanClick?: () => void;
}

// ============================================================================
// 主组件
// ============================================================================

export const ChatInput: React.FC<ChatInputProps> = ({
  onSend,
  disabled,
  isProcessing,
  onStop,
  hasPlan,
  onPlanClick,
}) => {
  const [value, setValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const inputAreaRef = useRef<InputAreaRef>(null);
  const { processFile, processFolderEntry } = useFileUpload();

  // 处理提交
  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmedValue = value.trim();
    if ((trimmedValue || attachments.length > 0) && !disabled) {
      onSend(
        trimmedValue,
        attachments.length > 0 ? attachments : undefined
      );
      setValue('');
      setAttachments([]);
    }
  };

  // 处理文件选择
  const handleFileSelect = async (files: FileList) => {
    const newAttachments: MessageAttachment[] = [];
    for (const file of Array.from(files)) {
      const attachment = await processFile(file);
      if (attachment) newAttachments.push(attachment);
    }
    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments].slice(0, UI.MAX_ATTACHMENTS_FILE_SELECT));
    }
  };

  // 处理图片粘贴（如微信截图）
  const handleImagePaste = useCallback(async (file: File) => {
    const attachment = await processFile(file);
    if (attachment) {
      setAttachments((prev) => [...prev, attachment].slice(0, UI.MAX_ATTACHMENTS_FILE_SELECT));
    }
  }, [processFile]);

  // 拖放处理
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

    const items = e.dataTransfer.items;
    const newAttachments: MessageAttachment[] = [];

    if (items) {
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }

      for (const entry of entries) {
        if (entry.isFile) {
          const fileEntry = entry as FileSystemFileEntry;
          const file = await new Promise<File>((resolve, reject) => {
            fileEntry.file(resolve, reject);
          });
          const attachment = await processFile(file);
          if (attachment) newAttachments.push(attachment);
        } else if (entry.isDirectory) {
          const dirEntry = entry as FileSystemDirectoryEntry;
          const folderAttachment = await processFolderEntry(dirEntry, entry.name);
          if (folderAttachment) newAttachments.push(folderAttachment);
        }
      }
    } else {
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        const attachment = await processFile(file);
        if (attachment) newAttachments.push(attachment);
      }
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments].slice(0, UI.MAX_ATTACHMENTS_DROP));
    }
  }, [processFile, processFolderEntry]);

  // 移除附件
  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // 语音输入回调 - 追加到现有文本
  const handleVoiceTranscript = useCallback((text: string) => {
    if (text.trim()) {
      setValue(prev => prev.trim() ? `${prev} ${text}` : text);
      // 聚焦输入框
      inputAreaRef.current?.focus();
    }
  }, []);

  const hasContent = value.trim().length > 0 || attachments.length > 0;

  return (
    <div
      className={`px-4 pb-4 pt-2 transition-colors ${isDragOver ? 'bg-primary-500/5' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
        {/* Plan 入口按钮 - 仅当有 Plan 时显示 */}
        {hasPlan && onPlanClick && (
          <button
            type="button"
            onClick={onPlanClick}
            className="flex items-center gap-2 px-3 py-2 mb-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg hover:bg-indigo-500/20 transition-colors w-full text-left"
          >
            <FileText className="w-4 h-4 text-indigo-400" />
            <span className="text-sm text-indigo-400">查看实现计划</span>
          </button>
        )}

        {/* 附件预览区 */}
        {attachments.length > 0 && (
          <div className="mb-2">
            <AttachmentBar attachments={attachments} onRemove={removeAttachment} />
          </div>
        )}

        {/* 拖放提示 */}
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-950/90 backdrop-blur-sm z-10 rounded-xl border-2 border-dashed border-primary-500">
            <div className="flex flex-col items-center gap-2 text-primary-400">
              <Image className="w-8 h-8" />
              <span className="text-sm">拖放文件或文件夹到这里</span>
            </div>
          </div>
        )}

        {/* 输入区域 - 玻璃质感样式 */}
        <div className="relative bg-white/[0.03] backdrop-blur-sm rounded-2xl border border-white/[0.08] focus-within:border-white/[0.15] focus-within:bg-white/[0.05] transition-all duration-200 shadow-lg shadow-black/20">
          <InputArea
            ref={inputAreaRef}
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            onFileSelect={handleFileSelect}
            onImagePaste={handleImagePaste}
            disabled={disabled}
            hasAttachments={attachments.length > 0}
            isFocused={isFocused}
            onFocusChange={setIsFocused}
            placeholder="描述你想解决的问题..."
            actionButtons={
              <>
                {/* 语音输入按钮 */}
                {!disabled && (
                  <VoiceInputButton
                    onTranscript={handleVoiceTranscript}
                    disabled={disabled}
                  />
                )}
                {/* 发送/停止按钮 */}
                <SendButton
                  disabled={disabled}
                  isProcessing={isProcessing}
                  hasContent={hasContent}
                  type="submit"
                  onStop={onStop}
                />
              </>
            }
          />
        </div>
      </form>
    </div>
  );
};

export default ChatInput;
