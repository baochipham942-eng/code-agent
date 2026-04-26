// Codex 风格 "+" 二级菜单：收纳低频 ChatInput 入口，工具栏只露一等公民。
// 当前收纳：上传图片/文件、/ 命令。Plan mode toggle 已经作为 InteractionMode
// 独立胶囊放右侧，权限模式 PermissionToggle 也保持独立。

import React, { useEffect, useRef, useState } from 'react';
import { Plus, Image as ImageIcon, SlashSquare } from 'lucide-react';

interface Props {
  onSlashCommand: () => void;
  onFileSelect: (files: FileList) => void;
}

export const InputAddMenu: React.FC<Props> = ({ onSlashCommand, onFileSelect }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="更多输入选项"
        aria-expanded={open}
        title="更多（命令 / 上传）"
        className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
      >
        <Plus className="w-4 h-4" />
      </button>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onFileSelect(e.target.files);
          }
          e.target.value = '';
          setOpen(false);
        }}
      />

      {open && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-0 mb-2 min-w-[180px] py-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-30"
        >
          <button
            type="button"
            onClick={() => {
              fileInputRef.current?.click();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors text-left"
          >
            <ImageIcon className="w-3.5 h-3.5 text-zinc-400" />
            <span>上传图片或文件</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSlashCommand();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors text-left"
          >
            <SlashSquare className="w-3.5 h-3.5 text-zinc-400" />
            <span>/ 命令面板</span>
            <span className="ml-auto text-[10px] text-zinc-500 font-mono">/</span>
          </button>
        </div>
      )}
    </div>
  );
};
