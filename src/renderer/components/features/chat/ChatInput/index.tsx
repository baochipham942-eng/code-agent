// ============================================================================
// ChatInput - 消息输入组件主入口
// 支持多模态输入：文本、图片、代码、PDF、文件夹
// 支持语义自动触发深度研究模式
// ============================================================================

import React, { useState, useRef, useCallback } from 'react';
import { Image, Sparkles, CornerDownLeft, FileText, Microscope, Settings2 } from 'lucide-react';
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
  /** 是否启用语义自动检测（默认 true） */
  autoDetectEnabled?: boolean;
  /** 切换自动检测设置 */
  onToggleAutoDetect?: (enabled: boolean) => void;
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
  autoDetectEnabled = true,
  onToggleAutoDetect,
}) => {
  const [value, setValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [mode, setMode] = useState<ChatMode>('normal');
  const [reportStyle, setReportStyle] = useState<ReportStyle>('default');
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const inputAreaRef = useRef<InputAreaRef>(null);
  const { processFile, processFolderEntry } = useFileUpload();

  // 处理提交
  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((value.trim() || attachments.length > 0) && !disabled) {
      onSend(
        value,
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
      className={`border-t border-zinc-800/50 bg-gradient-to-t from-surface-950 to-surface-950/80 backdrop-blur-sm p-4 transition-colors ${
        isDragOver ? 'bg-primary-500/10' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-3">
        {/* Plan 入口按钮 - 仅当有 Plan 时显示 */}
        {hasPlan && onPlanClick && (
          <button
            type="button"
            onClick={onPlanClick}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg hover:bg-indigo-500/20 transition-colors w-full text-left"
          >
            <FileText className="w-4 h-4 text-indigo-400" />
            <span className="text-sm text-indigo-400">查看实现计划</span>
          </button>
        )}

        {/* 语义自动检测指示器 */}
        {autoDetectEnabled && mode === 'normal' && (
          <div className="flex items-center gap-2 text-2xs text-zinc-500">
            <Microscope className="w-3 h-3 text-primary-400" />
            <span>深度研究将根据问题自动触发</span>
          </div>
        )}

        {/* 高级选项区域（折叠） */}
        {showAdvancedOptions && (
          <div className="p-3 bg-surface-800/50 border border-zinc-700/30 rounded-lg space-y-3 animate-in slide-in-from-top-2 duration-200">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">高级选项</span>
              <button
                type="button"
                onClick={() => setShowAdvancedOptions(false)}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                收起
              </button>
            </div>

            {/* 模式切换 */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500">研究模式</span>
              <ModeSwitch
                mode={mode}
                onModeChange={handleModeChange}
                disabled={isProcessing}
              />
            </div>

            {/* 自动检测开关 */}
            {onToggleAutoDetect && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">语义自动检测</span>
                <button
                  type="button"
                  onClick={() => onToggleAutoDetect(!autoDetectEnabled)}
                  disabled={isProcessing}
                  className={`
                    relative w-10 h-5 rounded-full transition-colors
                    ${autoDetectEnabled ? 'bg-primary-500' : 'bg-zinc-600'}
                    ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                  `}
                >
                  <div
                    className={`
                      absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform
                      ${autoDetectEnabled ? 'translate-x-5' : 'translate-x-0.5'}
                    `}
                  />
                </button>
              </div>
            )}

            {/* 深度研究模式的报告风格选择 */}
            {isDeepResearch && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">报告风格</span>
                <ReportStyleSelector
                  value={reportStyle}
                  onChange={setReportStyle}
                  disabled={isProcessing}
                />
              </div>
            )}
          </div>
        )}

        {/* 深度研究模式提示（手动选择时） */}
        {isDeepResearch && (
          <div className="px-3 py-2 bg-primary-500/10 border border-primary-500/20 rounded-lg">
            <div className="flex items-center gap-2">
              <Microscope className="w-4 h-4 text-primary-400" />
              <p className="text-xs text-primary-400">
                深度研究模式：输入研究主题，AI 将自动规划研究步骤、搜索信息、分析数据并生成结构化报告。
              </p>
            </div>
          </div>
        )}

        {/* 附件预览区 */}
        <AttachmentBar attachments={attachments} onRemove={removeAttachment} />

        {/* 拖放提示 */}
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-950/90 backdrop-blur-sm z-10 rounded-xl border-2 border-dashed border-primary-500">
            <div className="flex flex-col items-center gap-2 text-primary-400">
              <Image className="w-8 h-8" />
              <span className="text-sm">拖放文件或文件夹到这里</span>
              <span className="text-xs text-zinc-500">支持代码、文档、图片等多种格式</span>
            </div>
          </div>
        )}

        {/* 输入区域 */}
        <div className="relative">
          <InputArea
            ref={inputAreaRef}
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            onFileSelect={handleFileSelect}
            disabled={disabled}
            hasAttachments={attachments.length > 0}
            isFocused={isFocused}
            onFocusChange={setIsFocused}
            actionButtons={
              <>
                {/* 高级选项按钮 */}
                {!showAdvancedOptions && (
                  <button
                    type="button"
                    onClick={() => setShowAdvancedOptions(true)}
                    className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-surface-700 rounded-lg transition-colors"
                    title="高级选项"
                  >
                    <Settings2 className="w-4 h-4" />
                  </button>
                )}
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

        {/* 提示信息 */}
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

export default ChatInput;
