// ============================================================================
// InputArea - 输入区域组件（contenteditable 富文本 + 文字流内联 chip）
// ============================================================================
//
// 2026-07-29 UX round2：textarea 换成 contenteditable，chip（命令/skill/@文件）
// 从「文字上方独立一排」改成内联在文字流里（WorkBuddy phrase chip 模型）。
// - 文本模型不变：`value` 是纯文本（不含 chip），换行用 text 节点里的 '\n'
//   （CSS white-space: pre-wrap 渲染），不引入 <br>/<div>，IME 候选框定位不受干扰。
// - chip 是 store 的渲染：DOM 挂载点（contenteditable=false）⇄ pendingCommand /
//   selectedSkillIds / attachments 双向对账（见 composerRichTextModel）。
// - IME 三重防护（isComposing + keyCode 229 + 延迟复位 ref）与 textarea 版逐字一致。

import React, { useCallback, useLayoutEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { useModeStore } from '../../../../stores/modeStore';
import { useI18n } from '../../../../hooks/useI18n';
import { InlineComposerChip, type InlineChipView } from './InlineComposerChip';
import {
  chipMountAfterCaret,
  chipMountBeforeCaret,
  chipRefFromMount,
  extractComposerPlainText,
  findChipMount,
  getCaretPlainTextOffset,
  insertPlainTextAtCaret,
  listChipMounts,
  rebuildComposerText,
  removeChipMountWithCaret,
  replaceRangeWithChipMount,
  deletePlainTextRange,
  setCaretPlainTextOffset,
  syncChipMounts,
  type InlineChipRef,
} from './composerRichTextModel';

// 图片 MIME 类型
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const AUDIO_MIMES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/webm'];
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo'];

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
const PRESENTATION_EXTENSIONS = ['.pptx', '.ppt'];
const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz', '.gz', '.7z', '.rar'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'];

export interface InputAreaProps {
  /** 输入值（纯文本，不含 chip） */
  value: string;
  /** 值变化回调 */
  onChange: (value: string) => void;
  /** 提交回调 */
  onSubmit: (opts?: { steer?: boolean }) => void;
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
  /** 当前会话是否已有消息（用于区分首轮 vs 续轮 placeholder） */
  hasMessages?: boolean;
  /** @deprecated 使用 actionButtons 代替 */
  sendButton?: React.ReactNode;
  /** 获取上一条历史输入 */
  onHistoryPrev?: (currentInput: string) => string | null;
  /** 获取下一条历史输入 */
  onHistoryNext?: () => string | null;
  /** 重置历史浏览状态 */
  onHistoryReset?: () => void;
  /** 输入框内联补全按键拦截；返回 true 表示已消费 */
  onAutocompleteKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => boolean;
  /** 文字区上方 chip（@neo 续接 / appshot / pin 资料等非文字流内容） */
  chips?: React.ReactNode;
  /** 文字流内联 chip（store 的渲染：命令 / skill / @文件），按 DOM 位置混排在文字里 */
  inlineChips?: InlineChipView[];
  /** 内联 chip 删除（× / chip 聚焦 Delete / Backspace 紧贴删除） */
  onRemoveInlineChip?: (chip: InlineChipView) => void;
  /** 浏览器侧删除了 chip（框选删除 / 剪切）后，DOM 里现存的 chip key 列表 */
  onInlineChipsChanged?: (presentKeys: string[]) => void;
}

export interface InputAreaRef {
  /** 聚焦输入框 */
  focus: () => void;
  /** 获取 contenteditable 编辑区元素 */
  getEditor: () => HTMLElement | null;
  /** 光标的纯文本偏移（无有效选区时返回最后一次记录的位置） */
  getCaretOffset: () => number;
  /** 删除纯文本区间 [start, end) 并在原位插入 chip（触发词 chip 化） */
  replaceRangeWithChip: (start: number, end: number, chip: InlineChipRef) => void;
  /** 删除纯文本区间 [start, end) 并插入文本（@目录等保留文本路径的场景） */
  replaceRangeWithText: (start: number, end: number, text: string) => void;
}

export function shouldBrowseHistoryOnArrowUp(selectionStart: number, selectionEnd: number): boolean {
  return selectionStart === selectionEnd && selectionStart === 0;
}

export function shouldBrowseHistoryOnArrowDown(value: string, selectionStart: number, selectionEnd: number): boolean {
  return selectionStart === selectionEnd && selectionStart === value.length;
}

// 稳定的空数组：props 缺省时避免每次渲染新引用触发对账 effect
const NO_INLINE_CHIPS: InlineChipView[] = [];

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
      onFocusChange,
      placeholder,
      hasMessages = false,
      onHistoryPrev,
      onHistoryNext,
      onHistoryReset,
      onAutocompleteKeyDown,
      chips,
      inlineChips = NO_INLINE_CHIPS,
      onRemoveInlineChip,
      onInlineChipsChanged,
    },
    ref
  ) => {
    const editorRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isComposingRef = useRef(false);
    // 最近一次由编辑区自己发出的文本；value 与它不一致 = 外部改写（历史/草稿/清空），需要重建 DOM
    const lastEmittedRef = useRef<string | null>(null);
    // 编辑器失焦后（如鼠标点面板行）仍能回答「最后在哪儿」的光标位置
    const lastCaretRef = useRef(0);
    const [isEmpty, setIsEmpty] = useState(true);
    const [portalTargets, setPortalTargets] = useState<Array<{ chip: InlineChipView; el: HTMLElement }>>([]);

    const refreshEmptiness = useCallback(() => {
      const root = editorRef.current;
      if (!root) return;
      setIsEmpty(extractComposerPlainText(root).length === 0 && listChipMounts(root).length === 0);
    }, []);

    const emitChange = useCallback(() => {
      const root = editorRef.current;
      if (!root) return;
      // 删光全部文字后 WebKit 会留一个占位 <br>：本编辑器换行走 '\n' 文本（见下方
      // Shift+Enter 注释），<br> 只会是浏览器残留——不清掉它 extract 读成 '\n'，
      // placeholder 被「非空」吞掉、光标也没有可落的文本节点（真机 2026-08-05）。
      if (root.childNodes.length > 0 && (root.textContent ?? '') === '' && listChipMounts(root).length === 0) {
        root.replaceChildren();
      }
      const text = extractComposerPlainText(root);
      lastEmittedRef.current = text;
      lastCaretRef.current = getCaretPlainTextOffset(root) ?? text.length;
      root.setAttribute('data-plain-text', text);
      setIsEmpty(text.length === 0 && listChipMounts(root).length === 0);
      onChange(text);
      // 用户开始输入新内容时，重置历史索引
      onHistoryReset?.();
      onInlineChipsChanged?.(listChipMounts(root).map((mount) => chipRefFromMount(mount).key));
    }, [onChange, onHistoryReset, onInlineChipsChanged]);

    const rememberCaret = useCallback(() => {
      const root = editorRef.current;
      if (!root) return;
      const caret = getCaretPlainTextOffset(root);
      if (caret !== null) lastCaretRef.current = caret;
    }, []);

    // 暴露 ref 方法
    useImperativeHandle(ref, () => ({
      focus: () => editorRef.current?.focus(),
      getEditor: () => editorRef.current,
      getCaretOffset: () => {
        const root = editorRef.current;
        if (!root) return lastCaretRef.current;
        return getCaretPlainTextOffset(root) ?? lastCaretRef.current;
      },
      replaceRangeWithChip: (start, end, chip) => {
        const root = editorRef.current;
        if (!root) return;
        replaceRangeWithChipMount(root, start, end, chip);
        emitChange();
      },
      replaceRangeWithText: (start, end, text) => {
        const root = editorRef.current;
        if (!root) return;
        deletePlainTextRange(root, start, end);
        setCaretPlainTextOffset(root, start);
        insertPlainTextAtCaret(root, text);
        emitChange();
      },
    }), [emitChange]);

    // 外部 value 同步（历史 / 草稿恢复 / 发送后清空 / dictation）：与编辑区自发文本不一致时重建文本，
    // chip 挂载点保持原位。重建后光标收在文本末尾（对齐 textarea 版历史导航的落点）。
    useLayoutEffect(() => {
      const root = editorRef.current;
      if (!root) return;
      if (lastEmittedRef.current === value) return;
      lastEmittedRef.current = value;
      if (extractComposerPlainText(root) !== value) {
        rebuildComposerText(root, value);
        if (document.activeElement === root) {
          setCaretPlainTextOffset(root, value.length);
        }
      }
      root.setAttribute('data-plain-text', value);
      refreshEmptiness();
    }, [value, refreshEmptiness]);

    // store → DOM 对账：inlineChips（store 的渲染）与 DOM 挂载点保持一致——
    // 缺席的挂载点补到末尾（+ 菜单等无光标来源），多余的摘除（store 侧 × 掉）。
    useLayoutEffect(() => {
      const root = editorRef.current;
      if (!root) return;
      syncChipMounts(root, inlineChips);
      const targets: Array<{ chip: InlineChipView; el: HTMLElement }> = [];
      for (const chip of inlineChips) {
        const el = findChipMount(root, chip.key);
        if (el) targets.push({ chip, el });
      }
      setPortalTargets((prev) => (
        prev.length === targets.length && prev.every((item, index) => item.chip === targets[index].chip && item.el === targets[index].el)
          ? prev
          : targets
      ));
      refreshEmptiness();
    }, [inlineChips, refreshEmptiness]);

    // 跟踪光标（键盘 / 鼠标 / 选区变化），失焦后面板选中仍能定位触发词
    useLayoutEffect(() => {
      const root = editorRef.current;
      if (!root) return;
      const handleSelectionChange = () => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        if (!root.contains(selection.getRangeAt(0).startContainer)) return;
        rememberCaret();
      };
      document.addEventListener('selectionchange', handleSelectionChange);
      return () => document.removeEventListener('selectionchange', handleSelectionChange);
    }, [rememberCaret]);

    // 处理键盘事件
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (onAutocompleteKeyDown?.(e)) {
        return;
      }

      const isIme = e.nativeEvent.isComposing || isComposingRef.current || e.nativeEvent.keyCode === 229;

      // Submit on Enter (without Shift)
      // 三重检查: isComposing (标准) + compositionEnd ref (兼容搜狗/百度) + keyCode 229 (IME 标准信号)
      if (e.key === 'Enter' && !e.shiftKey && !isIme) {
        e.preventDefault();
        if (e.altKey) {
          onSubmit({ steer: true });
        } else {
          onSubmit();
        }
        return;
      }

      const root = editorRef.current;
      if (!root) return;

      // Shift+Enter 换行：插入 '\n' 文本字符（pre-wrap 渲染），不让浏览器产 <div>/<br>
      if (e.key === 'Enter' && e.shiftKey && !isIme) {
        e.preventDefault();
        insertPlainTextAtCaret(root, '\n');
        emitChange();
        return;
      }

      // Backspace / Delete 紧贴 chip：删 chip（从对应 store 移除），光标落位由模型层保证
      if ((e.key === 'Backspace' || e.key === 'Delete') && !isIme) {
        const mount = e.key === 'Backspace' ? chipMountBeforeCaret(root) : chipMountAfterCaret(root);
        if (mount) {
          e.preventDefault();
          const chipRef = chipRefFromMount(mount);
          const view = inlineChips.find((chip) => chip.key === chipRef.key);
          removeChipMountWithCaret(root, mount);
          if (view) {
            onRemoveInlineChip?.(view);
          } else {
            onInlineChipsChanged?.(listChipMounts(root).map((item) => chipRefFromMount(item).key));
          }
          refreshEmptiness();
          return;
        }
      }

      // 历史命令浏览（上下箭头）
      // 只有光标已经到输入开头/结尾时才接管，先保留原生光标移动。
      const caret = getCaretPlainTextOffset(root) ?? lastCaretRef.current;

      // 上箭头 - 获取上一条历史
      if (e.key === 'ArrowUp' && onHistoryPrev) {
        if (shouldBrowseHistoryOnArrowUp(caret, caret)) {
          const prevInput = onHistoryPrev(value);
          if (prevInput !== null) {
            e.preventDefault();
            onChange(prevInput);
          }
        }
      }

      // 下箭头 - 获取下一条历史
      if (e.key === 'ArrowDown' && onHistoryNext) {
        if (shouldBrowseHistoryOnArrowDown(value, caret, caret)) {
          const nextInput = onHistoryNext();
          if (nextInput !== null) {
            e.preventDefault();
            onChange(nextInput);
          }
        }
      }
    };

    // 处理粘贴事件 - 支持从剪贴板粘贴图片（如微信截图）；文本粘贴强制转纯文本
    const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
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
      // 文本粘贴：阻止浏览器塞 HTML，按纯文本插入（保留换行）
      const text = e.clipboardData.getData('text/plain');
      if (text) {
        e.preventDefault();
        const root = editorRef.current;
        if (!root) return;
        insertPlainTextAtCaret(root, text);
        emitChange();
      }
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
      ...PRESENTATION_EXTENSIONS,
      ...ARCHIVE_EXTENSIONS,
      ...AUDIO_MIMES,
      ...VIDEO_MIMES,
      ...AUDIO_EXTENSIONS,
      ...VIDEO_EXTENSIONS,
      'audio/*',
      'video/*',
      '.pdf',
      'application/pdf',
      '.html',
      '.htm',
      // Excel MIME types
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      // PowerPoint MIME types
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint',
      // Archive MIME types
      'application/zip',
      'application/x-zip-compressed',
      'application/x-tar',
      'application/gzip',
      'application/x-7z-compressed',
      'application/vnd.rar',
    ].join(',');

    const interactionMode = useModeStore((s) => s.interactionMode);
    const { t } = useI18n();

    // 根据交互模式决定 placeholder 文案和颜色；续轮统一精炼
    const placeholderConfig = {
      code: { text: t.chatInput.placeholderCode, colorClass: 'placeholder-zinc-500', textClass: 'text-zinc-500' },
      plan: { text: t.chatInput.placeholderPlan, colorClass: 'placeholder-amber-500/50', textClass: 'text-badge-warning/50' },
      ask: { text: t.chatInput.placeholderAsk, colorClass: 'placeholder-emerald-500/50', textClass: 'text-badge-success/50' },
    };
    const baseConfig = placeholderConfig[interactionMode] ?? placeholderConfig.code;
    // 续轮用中性 placeholder：之前的 "@ 标记 agent" 提示在普通对话里造成困惑
    // （产品负责人反馈："出现 @agent 的提示不合适"），只有 swarm session 才适合提示
    const placeholderText = hasMessages ? t.chatInput.placeholderContinue : baseConfig.text;
    const resolvedPlaceholder = placeholder ?? (hasAttachments ? t.chatInput.placeholderWithAttachments : placeholderText);

    return (
      <div className="relative">
        {/* 隐藏的文件输入 */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={acceptTypes}
          onChange={handleFileChange}
          className="hidden"
        />

        {/* 文字区上方 chip（非文字流：@neo 续接 / appshot / pin 资料） */}
        {chips ? <div className="px-4 pt-3 empty:hidden">{chips}</div> : null}

        {/* 文本编辑区（contenteditable）：文字与内联 chip 按阅读顺序混排 */}
        <div className="relative">
          {isEmpty && (
            <span
              aria-hidden
              className={`pointer-events-none absolute left-4 top-4 select-none text-sm ${baseConfig.textClass}`}
            >
              {resolvedPlaceholder}
            </span>
          )}
          <div
            ref={editorRef}
            contentEditable={!disabled}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            data-chat-input
            data-testid="chat-composer-textarea"
            data-plain-text=""
            aria-label={t.chatInput.sendAria}
            aria-disabled={disabled || undefined}
            onInput={emitChange}
            onKeyDown={handleKeyDown}
            onKeyUp={rememberCaret}
            onClick={rememberCaret}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => {
              // 某些中文输入法（搜狗/百度）事件顺序: compositionEnd → keyDown
              // 延迟重置以确保 keyDown 检查时 ref 仍为 true
              setTimeout(() => { isComposingRef.current = false; }, 50);
            }}
            onPaste={handlePaste}
            onFocus={() => onFocusChange(true)}
            onBlur={() => onFocusChange(false)}
            className={`chat-composer-textarea min-h-6 w-full cursor-text whitespace-pre-wrap break-words bg-transparent px-4 pt-4 pb-4 text-sm text-zinc-200 focus:outline-hidden focus-visible:outline-none focus-visible:ring-0 max-h-[200px] overflow-y-auto leading-relaxed ${disabled ? 'opacity-50' : ''}`}
          />
          {/* 内联 chip 经 portal 填进各自的 contenteditable=false 挂载点 */}
          {portalTargets.map(({ chip, el }) => createPortal(
            <InlineComposerChip chip={chip} onRemove={(target) => onRemoveInlineChip?.(target)} />,
            el,
            chip.key,
          ))}
        </div>
      </div>
    );
  }
);

InputArea.displayName = 'InputArea';

export default InputArea;
