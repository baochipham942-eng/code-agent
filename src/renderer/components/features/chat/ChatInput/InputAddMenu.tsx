// Codex 风格 "+" 二级菜单：收纳 ChatInput 工具栏低频入口。
// B+ 设计：上传 / 命令 / 交互模式（Code/Plan/Ask）都进这里，
// ChatInput 工具栏只露真正高频的（权限模式 / 上下文 / 模型 / 语音 / 发送）。

import React, { useEffect, useRef, useState } from 'react';
import { Plus, Image as ImageIcon, SlashSquare } from 'lucide-react';
import { useModeStore } from '../../../../stores/modeStore';
import type { InteractionMode } from '../../../../../shared/contract/agent';

interface Props {
  onSlashCommand: () => void;
  onFileSelect: (files: FileList) => void;
}

const MODE_OPTIONS: Array<{ value: InteractionMode; label: string; color: string; hint: string }> = [
  { value: 'code', label: '◆Code', color: 'text-emerald-400', hint: '全权执行：调用工具、修改文件、运行命令' },
  { value: 'plan', label: '◆Plan', color: 'text-purple-400', hint: '只规划：列计划但不动手' },
  { value: 'ask', label: '◆Ask', color: 'text-cyan-400', hint: '只问答：纯文字回复，不调工具' },
];

export const InputAddMenu: React.FC<Props> = ({ onSlashCommand, onFileSelect }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const interactionMode = useModeStore((s) => s.interactionMode);
  const setInteractionMode = useModeStore((s) => s.setInteractionMode);

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
        title="更多（命令 / 上传 / 模式）"
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
          className="absolute bottom-full left-0 mb-2 min-w-[220px] py-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-30"
        >
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
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

          {/* 交互模式：3 chip 横排，显示当前选中并直接切换 */}
          <div className="border-t border-zinc-700/60 mt-1 pt-1.5 px-2 pb-1.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 px-1">交互模式</div>
            <div className="grid grid-cols-3 gap-1">
              {MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setInteractionMode(opt.value);
                    setOpen(false);
                  }}
                  className={`
                    px-2 py-1.5 text-[11px] rounded transition-colors
                    ${interactionMode === opt.value
                      ? `${opt.color} bg-zinc-700 font-medium`
                      : 'text-zinc-500 hover:bg-zinc-700/50'}
                  `}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
