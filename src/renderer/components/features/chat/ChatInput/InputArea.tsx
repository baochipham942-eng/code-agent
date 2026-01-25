// ============================================================================
// InputArea - 输入区域组件（textarea + 快捷键 + 附件按钮）
// ============================================================================

import React, { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { Paperclip } from 'lucide-react';
import { UI } from '@shared/constants';

// 图片 MIME 类型
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// 代码文件扩展名
const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.swift', '.kt', '.scala',
  '.php', '.sh', '.bash', '.zsh', '.sql', '.r', '.lua', '.vim', '.el',
];

// 样式文件扩展名
const STYLE_EXTENSIONS = ['.css', '.scss', '.sass', '.less'];

// 数据文件扩展名
const DATA_EXTENSIONS = ['.json', '.csv', '.xml', '.yaml', '.yml', '.toml'];

// 文本文件扩展名
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.rst', '.log'];

// Excel 文件扩展名
const EXCEL_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.xlsb'];

export interface InputAreaProps {
  /** 输入值 */
  value: string;
  /** 值变化回调 */
  onChange: (value: string) => void;
  /** 提交回调 */
  onSubmit: () => void;
  /** 文件选择回调 */
  onFileSelect: (files: FileList) => void;
  /** 图片粘贴回调 */
  onImagePaste?: (file: File) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否有附件 */
  hasAttachments?: boolean;
  /** 是否处于焦点状态 */
  isFocused: boolean;
  /** 焦点状态变化回调 */
  onFocusChange: (focused: boolean) => void;
  /** 操作按钮插槽（放在输入框内部右侧，包含语音输入和发送按钮） */
  actionButtons?: React.ReactNode;
  /** 自定义 placeholder */
  placeholder?: string;
  /** @deprecated 使用 actionButtons 代替 */
  sendButton?: React.ReactNode;
}

export interface InputAreaRef {
  /** 聚焦输入框 */
  focus: () => void;
  /** 获取 textarea 元素 */
  getTextarea: () => HTMLTextAreaElement | null;
}

/**
 * 输入区域 - 包含文本输入框和附件按钮
 */
export const InputArea = forwardRef<InputAreaRef, InputAreaProps>(
  (
    {
      value,
      onChange,
      onSubmit,
      onFileSelect,
      onImagePaste,
      disabled = false,
      hasAttachments = false,
      isFocused,
      onFocusChange,
      actionButtons,
      placeholder,
      sendButton,
    },
    ref
  ) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 暴露 ref 方法
    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      getTextarea: () => textareaRef.current,
    }));

    // 自动调整 textarea 高度
    useEffect(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, UI.TEXTAREA_MAX_HEIGHT)}px`;
      }
    }, [value]);

    // 处理键盘事件
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Submit on Enter (without Shift)
      // 重要: 检查 isComposing 避免中文输入法选词时误触发
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        onSubmit();
      }
    };

    // 处理粘贴事件 - 支持从剪贴板粘贴图片（如微信截图）
    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData.items;
      for (const item of Array.from(items)) {
        // 检查是否是图片类型
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file && onImagePaste) {
            e.preventDefault();
            onImagePaste(file);
            return;
          }
        }
      }
      // 非图片内容，让默认粘贴行为继续
    };

    // 点击附件按钮
    const handleAttachClick = () => {
      fileInputRef.current?.click();
    };

    // 文件选择
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        onFileSelect(e.target.files);
      }
      // 重置 input 以允许再次选择同一文件
      e.target.value = '';
    };

    // 生成 accept 属性
    const acceptTypes = [
      ...IMAGE_MIMES,
      ...CODE_EXTENSIONS,
      ...STYLE_EXTENSIONS,
      ...DATA_EXTENSIONS,
      ...TEXT_EXTENSIONS,
      ...EXCEL_EXTENSIONS,
      '.pdf',
      'application/pdf',
      '.html',
      '.htm',
      // Excel MIME types
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ].join(',');

    return (
      <div className="relative flex items-center">
        {/* 隐藏的文件输入 */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={acceptTypes}
          onChange={handleFileChange}
          className="hidden"
        />

        {/* 附件按钮 - 与发送按钮大小一致 */}
        <button
          type="button"
          onClick={handleAttachClick}
          className="flex-shrink-0 ml-2 w-9 h-9 rounded-xl flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
          aria-label="添加图片或文件"
        >
          <Paperclip className="w-4 h-4" />
        </button>

        {/* 文本输入框 */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          placeholder={placeholder ?? (hasAttachments ? '添加描述...' : '描述你想解决的问题...')}
          disabled={disabled}
          rows={1}
          className="flex-1 min-w-0 bg-transparent py-3 px-2 text-sm text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none disabled:opacity-50 max-h-[200px] leading-relaxed"
        />

        {/* 操作按钮区（语音输入 + 发送） */}
        <div className="flex items-center gap-1.5 mr-2">
          {actionButtons || sendButton}
        </div>
      </div>
    );
  }
);

InputArea.displayName = 'InputArea';

export default InputArea;
