// Codex 风格 "+" 二级菜单：收纳 ChatInput 工具栏低频入口。
// B+ 设计：上传 / 命令 / 交互模式（Code/Plan/Ask）都进这里，
// ChatInput 工具栏只露真正高频的（权限模式 / 上下文 / 模型 / 语音 / 发送）。

import React, { useEffect, useRef, useState } from 'react';
import { Plus, Image as ImageIcon, SlashSquare, Brain, BookOpen, Bot, ChevronRight, Plug, Sparkles } from 'lucide-react';
import { useModeStore } from '../../../../stores/modeStore';
import { useAppStore } from '../../../../stores/appStore';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import type { InteractionMode } from '../../../../../shared/contract/agent';
import type { SessionMemoryMode } from '../../../../../shared/contract';
import type { WorkbenchCapabilityRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';
import { useI18n } from '../../../../hooks/useI18n';
import { InputAddSubmenu, type InputAddSubmenuItem } from './InputAddSubmenu';

interface Props {
  onSlashCommand: () => void;
  onFileSelect: (files: FileList) => void;
  /** 本会话记忆模式（默认 'auto' = 开启）。C-6：从底栏移入此二级菜单。 */
  memoryMode: SessionMemoryMode;
  onToggleMemory: () => void;
  memoryToggleDisabled?: boolean;
  /** Batch 2 L2：打开资料库 Pin 选择器（无会话时禁用） */
  onOpenLibrary: () => void;
  libraryDisabled?: boolean;
  /** 当轮能力选择动作（由 ChatInput 从 useChatInputSlashCommands 透传） */
  onSelectCapability: (capability: WorkbenchCapabilityRegistryItem) => void;
}

function buildModeOptions(hints: { code: string; plan: string; ask: string }): Array<{ value: InteractionMode; label: string; color: string; hint: string }> {
  return [
    { value: 'code', label: '◆Code', color: 'text-emerald-400', hint: hints.code },
    { value: 'plan', label: '◆Plan', color: 'text-purple-400', hint: hints.plan },
    { value: 'ask', label: '◆Ask', color: 'text-cyan-400', hint: hints.ask },
  ];
}

export const InputAddMenu: React.FC<Props> = ({
  onSlashCommand,
  onFileSelect,
  memoryMode,
  onToggleMemory,
  memoryToggleDisabled,
  onOpenLibrary,
  libraryDisabled,
  onSelectCapability,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<'experts' | 'skills' | 'connectors' | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const interactionMode = useModeStore((s) => s.interactionMode);
  const setInteractionMode = useModeStore((s) => s.setInteractionMode);
  const { skills, connectors } = useWorkbenchCapabilityRegistry();
  const expertEntries = useAgentRegistryStore((s) => s.entries);
  const activeAgentId = useAppStore((s) => s.activeAgentId);
  const setActiveAgentId = useAppStore((s) => s.setActiveAgentId);
  const openCapabilityHub = useAppStore((s) => s.openCapabilityHub);
  const modeOptions = buildModeOptions(t.inputAddMenu.modeHints);

  const closeMenu = () => {
    setSubmenu(null);
    setOpen(false);
  };
  const focusComposer = () => {
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-textarea"]')?.focus());
  };
  const capabilityItems = (items: WorkbenchCapabilityRegistryItem[]): InputAddSubmenuItem[] => items.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.kind === 'skill' ? item.description : item.kind === 'connector' ? item.detail || item.capabilities.join(' · ') : item.error,
    selected: item.selected,
  }));
  const expertItems: InputAddSubmenuItem[] = expertEntries.map((entry) => ({
    id: entry.id,
    label: entry.name || entry.id,
    description: entry.description,
    selected: entry.id === activeAgentId,
  }));

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => { if (v) setSubmenu(null); return !v; })}
        aria-label={t.inputAddMenu.moreOptionsAria}
        aria-expanded={open}
        title={t.inputAddMenu.moreOptionsTitle}
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
            <span>{t.inputAddMenu.uploadLabel}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              closeMenu();
              onSlashCommand();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors text-left"
          >
            <SlashSquare className="w-3.5 h-3.5 text-zinc-400" />
            <span>{t.inputAddMenu.slashPanelLabel}</span>
            <span className="ml-auto text-[10px] text-zinc-500 font-mono">/</span>
          </button>

          <div className="border-t border-zinc-700/60 mt-1 pt-1">
            {([
              ['experts', Bot, t.inputAddMenu.expertsLabel],
              ['skills', Sparkles, t.inputAddMenu.skillsLabel],
              ['connectors', Plug, t.inputAddMenu.connectorsLabel],
            ] as const).map(([kind, Icon, label]) => (
              <div key={kind} className="relative" onMouseEnter={() => setSubmenu(kind)}>
                <button /* ds-allow:button: "+"菜单的二级入口是图标、文案和 chevron 对齐的完整菜单行，Button primitive 不适配 */
                  type="button"
                  onClick={() => setSubmenu((current) => current === kind ? null : kind)}
                  aria-expanded={submenu === kind}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-700"
                >
                  <Icon className="h-3.5 w-3.5 text-zinc-400" />
                  <span>{label}</span>
                  <ChevronRight className="ml-auto h-3.5 w-3.5 text-zinc-500" />
                </button>
                {submenu === kind && (
                  <div className="absolute bottom-0 left-full ml-1 z-40">
                    <InputAddSubmenu
                      scope={kind}
                      items={kind === 'experts' ? expertItems : capabilityItems(kind === 'skills' ? skills : connectors)}
                      onSelect={(item) => {
                        if (kind === 'experts') {
                          setActiveAgentId(item.id);
                          focusComposer();
                        } else {
                          const capability = (kind === 'skills' ? skills : connectors).find((entry) => entry.id === item.id);
                          if (capability) onSelectCapability(capability);
                        }
                        closeMenu();
                      }}
                      footerActions={[{
                        label: kind === 'experts' ? t.inputAddMenu.manageExperts : kind === 'skills' ? t.inputAddMenu.manageSkills : t.inputAddMenu.manageConnectors,
                        onClick: () => {
                          openCapabilityHub(kind);
                          closeMenu();
                        },
                      }]}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Batch 2 L2: 资料库 Pin 选择器入口 */}
          <button /* ds-allow:button: "+"二级菜单行（图标+文案左对齐菜单项，同文件既有菜单行同构），Button primitive 是居中动作按钮形状，不适配菜单行 */
            type="button"
            data-library-pin-entry
            disabled={libraryDisabled}
            onClick={() => {
              closeMenu();
              onOpenLibrary();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors text-left disabled:cursor-not-allowed disabled:opacity-40"
          >
            <BookOpen className="w-3.5 h-3.5 text-zinc-400" />
            <span>{t.inputAddMenu.libraryLabel}</span>
          </button>

          {/* C-6: 本会话记忆开关（默认开启的低频功能，从底栏移入这里） */}
          <button
            type="button"
            disabled={memoryToggleDisabled}
            onClick={() => {
              onToggleMemory();
              closeMenu();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors text-left disabled:cursor-not-allowed disabled:opacity-40"
            title={memoryMode === 'off' ? t.inputAddMenu.memoryOffTitle : t.inputAddMenu.memoryOnTitle}
          >
            <Brain className={`w-3.5 h-3.5 ${memoryMode === 'off' ? 'text-zinc-500' : 'text-emerald-300'}`} />
            <span>{t.inputAddMenu.memoryLabel}</span>
            <span className={`ml-auto text-[10px] ${memoryMode === 'off' ? 'text-zinc-500' : 'text-emerald-300'}`}>
              {memoryMode === 'off' ? t.inputAddMenu.memoryOffStatus : t.inputAddMenu.memoryOnStatus}
            </span>
          </button>

          {/* 交互模式：3 chip 横排，显示当前选中并直接切换 */}
          <div className="border-t border-zinc-700/60 mt-1 pt-1.5 px-2 pb-1.5">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 px-1">{t.inputAddMenu.interactionModeHeader}</div>
            <div className="grid grid-cols-3 gap-1">
              {modeOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setInteractionMode(opt.value);
                    closeMenu();
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
